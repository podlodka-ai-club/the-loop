/**
 * Memory: lessons the agent wrote about its own past attempts, and the retrieval
 * that puts them back in front of it.
 *
 * The contract is intentionally independent of how lessons are stored. A backend
 * may use a local file, a hosted memory service, or another implementation without
 * changing the task and workflow code that consumes it.
 */
import type { FeatureKey } from "../observe.ts";
import { loadPromptMetadata } from "../promts.ts";

/** Default number of lessons a single recall may put into the prompt. */
export type RecallLimit = 1 | 2 | 3 | 4 | 5;

export const RECALL_LIMIT = parseRecallLimit(process.env.MEMORY_RECALL_LIMIT ?? "5", "MEMORY_RECALL_LIMIT");

export function parseRecallLimit(value: string | number, name = "recallLimit"): RecallLimit {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from 1 to 5`);
  }
  const parsed = Number(raw);
  if (parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 || parsed === 5) {
    return parsed;
  }
  throw new Error(`${name} must be an integer from 1 to 5`);
}

export type ReflectionEffect =
  | "helped"
  | "irrelevant"
  | "misleading"
  | "insufficient";

export type MemoryOperation = "retrieve" | "store";

export type MemoryPrompt = {
  operation: MemoryOperation;
  text: string;
  version: string;
  digest: string;
};

export type MemoryPromptMetadata = {
  retrieve: MemoryPrompt;
  store: MemoryPrompt;
};

export function sharedMemoryPrompt(operation: MemoryOperation): MemoryPrompt {
  const prompt = loadPromptMetadata(operation === "retrieve" ? "memory-retrieve" : "memory-store");
  return {
    operation,
    text: prompt.text,
    version: prompt.version,
    digest: prompt.digest,
  };
}

export function sharedMemoryPromptMetadata(): MemoryPromptMetadata {
  return {
    retrieve: sharedMemoryPrompt("retrieve"),
    store: sharedMemoryPrompt("store"),
  };
}

/**
 * Builds the only provider-facing retrieve instruction.  Adapters may map this
 * value to different native field names, but they must pass the resulting bytes
 * through unchanged.  Runtime data is JSON-encoded so a lesson/query can never
 * become an instruction fragment.
 */
export function encodeMemoryRetrieveQuery(prompt: MemoryPrompt, query: string): string {
  if (!isSharedMemoryPrompt(prompt, "retrieve")) {
    throw new Error("memory retrieve requires the shared prompt");
  }
  if (typeof query !== "string") throw new Error("memory retrieve query must be a string");
  return `${prompt.text}\n\nRUNTIME_QUERY_JSON:\n${JSON.stringify({ query })}`;
}

export function normalizeMemoryQuery(value: string | string[]): string {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 64 || values.some((item) => typeof item !== "string")) {
    throw new Error("memory retrieve query is invalid");
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of values) {
    const query = item.trim().replace(/\s+/g, " ");
    if ([...query].length > 512) throw new Error("memory retrieve query is too long");
    if (query !== "" && !seen.has(query)) {
      seen.add(query);
      normalized.push(query);
    }
  }
  const result = normalized.join("\n");
  if ([...result].length > 512) throw new Error("memory retrieve query is too long");
  return result;
}

export function isSharedMemoryPrompt(prompt: unknown, operation: MemoryOperation): prompt is MemoryPrompt {
  if (typeof prompt !== "object" || prompt === null) return false;
  const value = prompt as Partial<MemoryPrompt>;
  const expected = sharedMemoryPrompt(operation);
  return (
    value.operation === expected.operation &&
    value.text === expected.text &&
    value.version === expected.version &&
    value.digest === expected.digest
  );
}

export type MemoryWriteResult = {
  status: "stored" | "already_stored";
  lessonId: string;
};

export type MemoryWriteErrorCode =
  | "write_failed"
  | "write_outcome_unknown"
  | "unsupported";

export class MemoryWriteError extends Error {
  readonly code: MemoryWriteErrorCode;

  constructor(code: MemoryWriteErrorCode, message: string = code) {
    super(message);
    this.name = "MemoryWriteError";
    this.code = code;
  }
}

export type Lesson = {
  id: string;
  /** Free text, the transferable part. Written by the model during reflection. */
  content: string;
  /** Which attempt produced it, so a lesson can be traced back to its episode. */
  sourceAttemptId: string;
  /** Feature slot that produced the memory hit. */
  featureKey: FeatureKey;
  /** Application-owned hit id used to bind one lesson to one memory hit. */
  memoryHitId: string;
  /** Whether the hit helped, misled, was irrelevant, or was insufficient. */
  effect: ReflectionEffect;
  /** Deterministic key for idempotent episode writes. */
  idempotencyKey: string;
  /** Observable features that make this lesson relevant. Used for ranking. */
  triggers: string[];
  /** Country or area the lesson talks about. Diagnostic, not used for ranking. */
  region: string;
  /** Times the lesson reached a prompt. */
  hits: number;
  /** Times it reached a prompt and the guess landed closer than the run baseline. */
  wins: number;
};

/** What reflection produces, before the store assigns provenance and counters. */
export type LessonInput = {
  content: string;
  sourceAttemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  effect: ReflectionEffect;
  triggers: string[];
  region: string;
  idempotencyKey: string;
};

export type LegacyLessonInput = {
  content: string;
  sourceAttemptId: string;
  triggers: string[];
  region: string;
} & Partial<Pick<LessonInput, "featureKey" | "memoryHitId" | "effect" | "idempotencyKey">>;

export type LegacyLesson = LegacyLessonInput & {
  id: string;
  hits: number;
  wins: number;
};

export type Hint = {
  lessonId: string;
  text: string;
  featureKey?: FeatureKey;
  effect?: ReflectionEffect;
};

export type MemoryBindingRequest = {
  memoryRef: string;
  operation: MemoryOperation;
  prompt: MemoryPrompt;
  featureKey: string;
  query?: string;
  lesson?: LessonInput;
  limit?: number;
};

export type MemoryAdapterPromptPort = {
  retrieve(input: MemoryBindingRequest): Promise<Hint[]>;
  store(input: MemoryBindingRequest): Promise<MemoryWriteResult>;
};

export type MemorySourceBinding = {
  /** Stable identity for the complete reader/writer composition. */
  readonly identity: symbol;
  readonly memoryRef: string;
  readonly provider: string | null;
  readonly reader: MemoryReader;
  readonly writer?: MemoryWriter;
  /** Mandatory application-owned adapter boundary for this binding. */
  readonly promptPort: MemoryAdapterPromptPort;
  /** Returns a composition-root-marked frozen binding, never an arbitrary reader. */
  readonly loadSnapshot?: (snapshotId: string) => Promise<MemorySnapshotBinding>;
};

export type MemoryReaderFeatureScope = "feature" | "global";

/**
 * How a lesson is rendered into the prompt.
 *
 * The region is stated explicitly rather than left to the prose. Lessons routinely
 * describe places by sub-national names - "the Eastern Cape", "the South Island" -
 * so a shuffled-memory control that rewrites country names in the text leaves those
 * untouched and produces a control whose prompt is identical to the real run. Making
 * the attribution part of the hint means swapping it always changes what the model
 * reads. Shared by every adapter so the two runs stay comparable across backends.
 */
export function renderHint(lesson: Lesson): Hint;
export function renderHint(lesson: LegacyLesson): Hint;
export function renderHint(lesson: Lesson | LegacyLesson): Hint {
  const region = lesson.region.trim();
  const content = renderedLessonContent(lesson);
  const hint: Hint = {
    lessonId: lesson.id,
    text: region === "" ? content : `${region}: ${content}`,
  };
  if (lesson.featureKey !== undefined) hint.featureKey = lesson.featureKey;
  if (lesson.effect !== undefined) hint.effect = lesson.effect;
  return hint;
}

export function renderedLessonContent(
  lesson: Pick<LegacyLesson, "content"> & Partial<Pick<Lesson, "effect">>,
): string {
  if (lesson.effect === undefined || lesson.effect === "helped") return lesson.content;
  const prefix = `[effect=${lesson.effect}]`;
  return lesson.content.startsWith(prefix) ? lesson.content : `${prefix} ${lesson.content}`;
}

export interface MemoryReader {
  /** Shared application-owned prompts used by this configured adapter. */
  readonly promptMetadata?: MemoryPromptMetadata;
  /** Optional boundary that receives the complete application-owned binding request. */
  promptPort?: MemoryAdapterPromptPort;
  /**
   * `global` readers return an unbounded/global prior and are not valid inside
   * the feature-scoped tool dispatcher. Most providers are feature-scoped by
   * contract and can leave this undefined.
   */
  readonly featureScope?: MemoryReaderFeatureScope;
  /**
   * Optional composition hook for readers that can expose the same backing store
   * through feature-scoped ranking. Workflow code depends only on this capability,
   * not on a concrete adapter class.
   */
  asFeatureScopedReader?(): MemoryReader;
  /**
   * Optional projection for adapters whose read operation can otherwise mutate
   * counters or provider state. Evaluation and production use it before recall.
   */
  asReadOnlyReader?(): MemoryReader;
  /** Optional frozen-reader factory used by evaluation bindings. */
  loadSnapshot?(snapshotId: string): Promise<MemoryReader>;
  /** Feature-scoped dispatcher path: one query for one active feature. */
  recall(query: string, limit: number, prompt?: MemoryPrompt): Promise<Hint[]>;
}

type FrozenMemoryReaderMetadata = {
  snapshotId: string;
  readOnly: true;
};

const FROZEN_MEMORY_READERS = new WeakSet<object>();
const FROZEN_MEMORY_READER_METADATA = new WeakMap<object, FrozenMemoryReaderMetadata>();

/**
 * Marks a backend-created reader as the immutable reader for one snapshot.
 * The runtime brand is intentionally not structural: a caller cannot turn a
 * live reader into an evaluation reader by merely adding `snapshotId` fields.
 */
export function markFrozenMemoryReader(reader: MemoryReader, snapshotId: string): MemoryReader {
  if (typeof reader !== "object" || reader === null || typeof reader.recall !== "function") {
    throw new MemoryBindingError("memory_mismatch", "frozen snapshot reader is invalid");
  }
  if (snapshotId.trim() === "") {
    throw new MemoryBindingError("memory_not_found", "frozen snapshot id is empty");
  }
  FROZEN_MEMORY_READERS.add(reader);
  FROZEN_MEMORY_READER_METADATA.set(reader, { snapshotId, readOnly: true });
  return reader;
}

export function isFrozenMemoryReader(reader: unknown, snapshotId: string): reader is MemoryReader {
  if (typeof reader !== "object" || reader === null || !FROZEN_MEMORY_READERS.has(reader)) return false;
  const metadata = FROZEN_MEMORY_READER_METADATA.get(reader);
  return metadata?.snapshotId === snapshotId && metadata.readOnly === true;
}

function frozenReaderSnapshotId(reader: unknown): string | null {
  if (typeof reader !== "object" || reader === null || !FROZEN_MEMORY_READERS.has(reader)) return null;
  return FROZEN_MEMORY_READER_METADATA.get(reader)?.snapshotId ?? null;
}

/**
 * A snapshot is a binding, not merely a reader with a caller-supplied label. The
 * composition root creates and marks it so evaluation cannot substitute a live
 * reader while retaining the requested snapshot id.
 */
export type MemorySnapshotBinding = {
  readonly identity: symbol;
  readonly memoryRef: string;
  readonly snapshotId: string;
  readonly reader: MemoryReader;
  readonly promptPort: MemoryAdapterPromptPort;
  readonly frozen: true;
  readonly readOnly: true;
};

function readerPromptPort(reader: MemoryReader): MemoryAdapterPromptPort {
  return {
    retrieve: (request) => {
      if (request.query === undefined) throw new Error("memory retrieve query is required");
      return reader.recall(request.query, request.limit ?? RECALL_LIMIT, request.prompt);
    },
    store: async () => {
      throw new MemoryWriteError("write_failed", "reader-only memory cannot store lessons");
    },
  };
}

export async function recallWithMemoryPrompt(
  reader: MemoryReader,
  request: Omit<MemoryBindingRequest, "operation" | "lesson" | "prompt"> & { limit: number },
  bindingPromptPort: MemoryAdapterPromptPort,
): Promise<Hint[]> {
  const prompt = sharedMemoryPrompt("retrieve");
  if (reader.promptPort !== undefined && reader.promptPort !== bindingPromptPort) {
    throw new MemoryBindingError(
      "memory_mismatch",
      "memory retrieve must use the active feature-scoped reader prompt port",
    );
  }
  return bindingPromptPort.retrieve({ ...request, operation: "retrieve", prompt });
}

export async function rememberWithMemoryPrompt(
  writer: MemoryWriter,
  request: Omit<MemoryBindingRequest, "operation" | "query" | "limit" | "prompt"> & { lesson: LessonInput },
  bindingPromptPort: MemoryAdapterPromptPort,
): Promise<MemoryWriteResult> {
  const prompt = sharedMemoryPrompt("store");
  return bindingPromptPort.store({ ...request, operation: "store", prompt });
}

export function bindFeatureScopedReader(reader: MemoryReader): MemoryReader {
  const frozenSnapshotId = frozenReaderSnapshotId(reader);
  const scoped = reader.featureScope === "global" ? reader.asFeatureScopedReader?.() : reader;
  if (scoped === undefined || scoped.featureScope === "global") {
    throw new MemoryBindingError(
      "memory_mismatch",
      "global memory reader cannot be used by the feature-scoped runtime",
    );
  }
  const wrapped: MemoryReader = {
    featureScope: scoped.featureScope,
    promptMetadata: scoped.promptMetadata,
    recall: (query, limit, prompt) => scoped.recall(query, limit, prompt),
  };
  if (scoped.asReadOnlyReader !== undefined) {
    wrapped.asReadOnlyReader = () => scoped.asReadOnlyReader!();
  }
  wrapped.promptPort = readerPromptPort(wrapped);
  if (frozenSnapshotId !== null) markFrozenMemoryReader(wrapped, frozenSnapshotId);
  return wrapped;
}

export function readerOnly(memory: MemoryReader): MemoryReader {
  const frozenSnapshotId = frozenReaderSnapshotId(memory);
  const source = memory.asReadOnlyReader?.() ?? memory;
  const reader: MemoryReader =
    source.featureScope === undefined
      ? { promptMetadata: source.promptMetadata, recall: (query, limit, prompt) => source.recall(query, limit, prompt) }
      : {
          featureScope: source.featureScope,
          promptMetadata: source.promptMetadata,
          recall: (query, limit, prompt) => source.recall(query, limit, prompt),
        };
  if (source.asFeatureScopedReader !== undefined) {
    reader.asFeatureScopedReader = () => readerOnly(source.asFeatureScopedReader?.() ?? source);
  }
  if (source.loadSnapshot !== undefined) {
    reader.loadSnapshot = async (snapshotId: string) => readerOnly(await source.loadSnapshot!(snapshotId));
  }
  reader.promptPort = readerPromptPort(reader);
  if (frozenSnapshotId !== null) markFrozenMemoryReader(reader, frozenSnapshotId);
  return reader;
}

export interface MemoryWriter extends MemoryReader {
  remember(lesson: LessonInput, prompt?: MemoryPrompt): Promise<MemoryWriteResult>;
  /** Freezes the current store to its own file and returns that file's id. */
  snapshot(): Promise<string>;
  /** Replaces the working store with a frozen one. */
  restore(id: string): Promise<void>;
}

export function isMemoryWriter(value: unknown): value is MemoryWriter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MemoryWriter>;
  return (
    typeof candidate.recall === "function" &&
    typeof candidate.remember === "function" &&
    typeof candidate.snapshot === "function" &&
    typeof candidate.restore === "function"
  );
}

export type MemoryBinding =
  | { identity: symbol; promptPort: MemoryAdapterPromptPort; memoryRef: string | null; mode: "training"; reader: MemoryReader; writer: MemoryWriter; snapshotId: null; readOnly: false }
  | { identity: symbol; promptPort: MemoryAdapterPromptPort; memoryRef: string | null; mode: "evaluation"; reader: MemoryReader; writer?: never; snapshotId: string; readOnly: true }
  | { identity: symbol; promptPort: MemoryAdapterPromptPort; memoryRef: string | null; mode: "production"; reader: MemoryReader; writer?: never; snapshotId: string | null; readOnly: true };

export type Memory = MemoryWriter;

export interface MemorySourceResolver {
  resolve(memoryRef: string | null): Promise<MemorySourceBinding>;
}

function fallbackPromptPort(reader: MemoryReader, writer?: MemoryWriter): MemoryAdapterPromptPort {
  return {
    retrieve: (request) => {
      if (request.query === undefined) throw new Error("memory retrieve query is required");
      return reader.recall(request.query, request.limit ?? RECALL_LIMIT, request.prompt);
    },
    store: (request) => {
      if (writer === undefined || request.lesson === undefined) {
        throw new MemoryWriteError("write_failed", "memory binding is not writable");
      }
      return writer.remember(request.lesson, request.prompt);
    },
  };
}

type MemorySourceBindingInput = {
  memoryRef: string;
  /** One adapter object is the source of both reader and optional writer. */
  memory: MemoryReader;
  provider?: string | null;
  loadSnapshot?: (snapshotId: string) => Promise<MemorySnapshotBinding>;
} | {
  /** Compatibility spelling for callers being migrated to the unified memory object. */
  memoryRef: string;
  reader: MemoryReader;
  writer?: MemoryWriter;
  provider?: string | null;
  loadSnapshot?: (snapshotId: string) => Promise<MemorySnapshotBinding>;
};

type BindingComponents = {
  reader: MemoryReader;
  backingMemory?: MemoryReader;
  writer?: MemoryWriter;
  promptPort: MemoryAdapterPromptPort;
  identity?: symbol;
  memoryRef?: string | null;
  snapshotId?: string | null;
  readOnly?: boolean;
  frozen?: boolean;
};

const MEMORY_SOURCE_BINDINGS = new WeakSet<object>();
const MEMORY_SOURCE_COMPONENTS = new WeakMap<object, BindingComponents>();
const RESOLVED_MEMORY_BINDINGS = new WeakSet<object>();
const RESOLVED_MEMORY_COMPONENTS = new WeakMap<object, BindingComponents>();

function markMemorySourceBinding(binding: MemorySourceBinding, components: BindingComponents): MemorySourceBinding {
  MEMORY_SOURCE_BINDINGS.add(binding);
  MEMORY_SOURCE_COMPONENTS.set(binding, components);
  return binding;
}

function markResolvedBinding<T extends MemoryBinding>(binding: T): T {
  RESOLVED_MEMORY_BINDINGS.add(binding);
  RESOLVED_MEMORY_COMPONENTS.set(binding, {
    reader: binding.reader,
    ...(binding.writer === undefined ? {} : { writer: binding.writer }),
    promptPort: binding.promptPort,
    identity: binding.identity,
    memoryRef: binding.memoryRef,
    snapshotId: binding.snapshotId,
    readOnly: binding.readOnly,
    frozen: binding.snapshotId !== null,
  });
  return binding;
}

const FROZEN_SNAPSHOT_BINDINGS = new WeakSet<object>();
const FROZEN_SNAPSHOT_COMPONENTS = new WeakMap<object, BindingComponents>();

function markFrozenSnapshotBinding(binding: MemorySnapshotBinding): MemorySnapshotBinding {
  FROZEN_SNAPSHOT_BINDINGS.add(binding);
  FROZEN_SNAPSHOT_COMPONENTS.set(binding, {
    reader: binding.reader,
    promptPort: binding.promptPort,
    identity: binding.identity,
    memoryRef: binding.memoryRef,
    snapshotId: binding.snapshotId,
    readOnly: true,
    frozen: true,
  });
  return binding;
}

function validateFrozenSnapshotBinding(
  snapshot: unknown,
  expected: { memoryRef: string; snapshotId: string },
): asserts snapshot is MemorySnapshotBinding {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !FROZEN_SNAPSHOT_BINDINGS.has(snapshot) ||
    typeof (snapshot as Partial<MemorySnapshotBinding>).identity !== "symbol" ||
    (snapshot as Partial<MemorySnapshotBinding>).memoryRef !== expected.memoryRef ||
    (snapshot as Partial<MemorySnapshotBinding>).snapshotId !== expected.snapshotId ||
    (snapshot as Partial<MemorySnapshotBinding>).frozen !== true ||
    (snapshot as Partial<MemorySnapshotBinding>).readOnly !== true ||
    typeof (snapshot as Partial<MemorySnapshotBinding>).reader?.recall !== "function" ||
    !isFrozenMemoryReader((snapshot as Partial<MemorySnapshotBinding>).reader, expected.snapshotId) ||
    typeof (snapshot as Partial<MemorySnapshotBinding>).promptPort?.retrieve !== "function" ||
    typeof (snapshot as Partial<MemorySnapshotBinding>).promptPort?.store !== "function"
  ) {
    throw new MemoryBindingError("memory_mismatch", "snapshot loader returned an unmarked or mismatched snapshot");
  }
  const value = snapshot as MemorySnapshotBinding;
  const components = FROZEN_SNAPSHOT_COMPONENTS.get(value);
  if (
    components === undefined ||
    components.reader !== value.reader ||
    components.promptPort !== value.promptPort ||
    components.identity !== value.identity ||
    components.memoryRef !== value.memoryRef ||
    components.snapshotId !== value.snapshotId ||
    components.readOnly !== value.readOnly ||
    components.frozen !== value.frozen ||
    value.reader.promptPort !== value.promptPort
  ) {
    throw new MemoryBindingError("memory_mismatch", "snapshot binding components do not share one frozen identity");
  }
}

/** Marks a reader as the immutable snapshot selected by evaluation. */
export function createFrozenMemorySnapshotBinding(input: {
  memoryRef: string;
  snapshotId: string;
  reader: MemoryReader;
}): MemorySnapshotBinding {
  if (typeof input.memoryRef !== "string" || input.memoryRef.trim() === "") {
    throw new MemoryBindingError("memory_mismatch", "frozen snapshot requires memoryRef");
  }
  if (typeof input.snapshotId !== "string" || input.snapshotId.trim() === "") {
    throw new MemoryBindingError("memory_not_found", "frozen snapshot requires a non-empty snapshotId");
  }
  if (!isFrozenMemoryReader(input.reader, input.snapshotId)) {
    throw new MemoryBindingError(
      "memory_mismatch",
      "snapshot loader must return a backend-branded frozen reader",
    );
  }
  const reader = readerOnly(bindFeatureScopedReader(input.reader));
  markFrozenMemoryReader(reader, input.snapshotId);
  if (reader.promptPort === undefined) {
    throw new MemoryBindingError("memory_mismatch", "frozen snapshot reader has no prompt boundary");
  }
  return markFrozenSnapshotBinding({
    identity: Symbol(`memory-snapshot:${input.memoryRef}:${input.snapshotId}`),
    memoryRef: input.memoryRef,
    snapshotId: input.snapshotId,
    reader,
    promptPort: reader.promptPort,
    frozen: true,
    readOnly: true,
  });
}

function validateMemorySourceBinding(source: unknown): asserts source is MemorySourceBinding {
  if (
    typeof source !== "object" ||
    source === null ||
    !MEMORY_SOURCE_BINDINGS.has(source) ||
    typeof (source as Partial<MemorySourceBinding>).identity !== "symbol" ||
    typeof (source as Partial<MemorySourceBinding>).reader?.recall !== "function" ||
    typeof (source as Partial<MemorySourceBinding>).promptPort?.retrieve !== "function" ||
    typeof (source as Partial<MemorySourceBinding>).promptPort?.store !== "function"
  ) {
    throw new MemoryBindingError("memory_mismatch", "memory source binding was not created by the composition root");
  }
  const value = source as MemorySourceBinding;
  const components = MEMORY_SOURCE_COMPONENTS.get(source);
  if (
    components === undefined ||
    components.reader !== value.reader ||
    components.writer !== value.writer ||
    components.promptPort !== value.promptPort ||
    value.reader.promptPort !== value.promptPort
  ) {
    throw new MemoryBindingError("memory_mismatch", "memory source binding components do not share one identity");
  }
}

/** Creates one identity-bearing reader/writer binding for a composition root. */
export function createMemorySourceBinding(input: MemorySourceBindingInput): MemorySourceBinding {
  if (input.memoryRef.trim() === "") throw new Error("memoryRef must be non-empty");
  const memory = "memory" in input ? input.memory : input.reader;
  const suppliedWriter = "memory" in input ? undefined : input.writer;
  if (typeof memory?.recall !== "function") throw new Error("memory reader is invalid");
  if (suppliedWriter !== undefined && suppliedWriter !== memory) {
    throw new MemoryBindingError("memory_mismatch", "reader and writer must be the same memory adapter");
  }
  const writer = isMemoryWriter(memory) ? memory : undefined;
  if (suppliedWriter !== undefined && writer === undefined) {
    throw new Error("memory binding writer is invalid");
  }
  const reader = bindFeatureScopedReader(memory);
  const adapterPromptPort = memory.promptPort ?? fallbackPromptPort(memory, writer);
  const readerPort = reader.promptPort;
  const promptPort: MemoryAdapterPromptPort = {
    retrieve: readerPort?.retrieve ?? readerPromptPort(reader).retrieve,
    store: adapterPromptPort.store,
  };
  if (typeof promptPort.retrieve !== "function" || typeof promptPort.store !== "function") {
    throw new Error("memory adapter prompt boundary is invalid");
  }
  reader.promptPort = promptPort;
  const binding: MemorySourceBinding = {
    identity: Symbol(`memory-binding:${input.memoryRef}`),
    memoryRef: input.memoryRef,
    provider: input.provider ?? null,
    reader,
    ...(writer === undefined ? {} : { writer }),
    promptPort,
    ...(input.loadSnapshot === undefined ? {} : { loadSnapshot: input.loadSnapshot }),
  };
  return markMemorySourceBinding(binding, {
    reader,
    backingMemory: memory,
    ...(writer === undefined ? {} : { writer }),
    promptPort,
  });
}

/** Checks that a resolver binding is backed by the exact direct memory object. */
export function memorySourceMatchesReader(source: unknown, memory: MemoryReader): source is MemorySourceBinding {
  if (typeof source !== "object" || source === null || !MEMORY_SOURCE_BINDINGS.has(source)) return false;
  const components = MEMORY_SOURCE_COMPONENTS.get(source);
  return components?.backingMemory === memory || components?.reader === memory;
}

/**
 * Creates the resolver used by a composition root that owns one memory binding.
 * The resolver is deliberately exact: a request for another reference cannot
 * silently fall back to the supplied reader or to FileMemory.
 */
export function createMemorySourceResolver(binding: MemorySourceBinding): MemorySourceResolver {
  validateMemorySourceBinding(binding);
  return {
    async resolve(memoryRef: string | null): Promise<MemorySourceBinding> {
      if (memoryRef !== binding.memoryRef) {
        throw new MemoryBindingError("memory_not_found", `no memory binding for ${String(memoryRef)}`);
      }
      return binding;
    },
  };
}

export type MemoryBindingFailureCode =
  | "memory_not_found"
  | "memory_mismatch"
  | "unavailable"
  | "timeout";

export class MemoryBindingError extends Error {
  readonly code: MemoryBindingFailureCode;

  constructor(code: MemoryBindingFailureCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryBindingError";
    this.code = code;
  }
}

export function isMemoryBindingFailureCode(value: unknown): value is MemoryBindingFailureCode {
  return value === "memory_not_found" ||
    value === "memory_mismatch" ||
    value === "unavailable" ||
    value === "timeout";
}

export function memoryBindingFailureCode(error: unknown): MemoryBindingFailureCode {
  return memoryBindingFailureCodeOrNull(error) ?? "unavailable";
}

/** Returns a binding code only when the error can be identified as one. */
export function memoryBindingFailureCodeOrNull(error: unknown): MemoryBindingFailureCode | null {
  if (error instanceof MemoryBindingError) return error.code;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown } | null;
  if (candidate !== null && typeof candidate === "object") {
    if (isMemoryBindingFailureCode(candidate.code)) return candidate.code;
    if (candidate.code === "bank_not_found" || candidate.code === "instance_not_found") {
      return "memory_not_found";
    }
    if (candidate.code === "agent_not_found") return "memory_not_found";
    if (candidate.code === "rate_limited") return "unavailable";
    if (candidate.code === "authentication" || candidate.code === "authorization") {
      return "memory_mismatch";
    }
    if (candidate.code === "ETIMEDOUT" || candidate.name === "TimeoutError" || candidate.name === "AbortError") {
      return "timeout";
    }
    if (candidate.status === 404 || candidate.statusCode === 404) return "memory_not_found";
    if (candidate.status === 408 || candidate.statusCode === 408 || candidate.status === 429 || candidate.statusCode === 429) {
      return "unavailable";
    }
  }
  return null;
}

/**
 * Validates a runtime binding before it is used. The WeakSet check prevents an
 * arbitrary object passed through the internal `memoryBinding` escape hatch from
 * bypassing resolver checks and frozen/read-only construction.
 */
export function validateMemoryBinding(
  binding: unknown,
  config: {
    memoryRef: string | null;
    mode: "training" | "evaluation" | "production";
    snapshotId: string | null;
    readOnly: boolean;
  },
): asserts binding is MemoryBinding {
  if (
    typeof binding !== "object" ||
    binding === null ||
    !RESOLVED_MEMORY_BINDINGS.has(binding) ||
    typeof (binding as Partial<MemoryBinding>).identity !== "symbol" ||
    typeof (binding as Partial<MemoryBinding>).promptPort?.retrieve !== "function" ||
    typeof (binding as Partial<MemoryBinding>).promptPort?.store !== "function" ||
    typeof (binding as Partial<MemoryBinding>).reader?.recall !== "function"
  ) {
    throw new MemoryBindingError("memory_mismatch", "memory binding was not created by the resolver");
  }
  const value = binding as MemoryBinding;
  const components = RESOLVED_MEMORY_COMPONENTS.get(value);
  if (
    components === undefined ||
    components.reader !== value.reader ||
    components.writer !== value.writer ||
    components.promptPort !== value.promptPort ||
    components.identity !== value.identity ||
    components.memoryRef !== value.memoryRef ||
    components.snapshotId !== value.snapshotId ||
    components.readOnly !== value.readOnly ||
    components.frozen !== (value.snapshotId !== null) ||
    value.reader.promptPort !== value.promptPort
  ) {
    throw new MemoryBindingError("memory_mismatch", "memory binding components do not share one identity");
  }
  if (
    value.memoryRef !== config.memoryRef ||
    value.mode !== config.mode ||
    value.snapshotId !== config.snapshotId ||
    value.readOnly !== config.readOnly
  ) {
    throw new MemoryBindingError("memory_mismatch", "memory binding does not match the run configuration");
  }
  if (config.mode === "training") {
    if (value.writer === undefined || value.readOnly !== false || value.snapshotId !== null) {
      throw new MemoryBindingError("memory_mismatch", "training binding is not writable");
    }
  } else if (value.writer !== undefined || value.readOnly !== true) {
    throw new MemoryBindingError("memory_mismatch", "read-only binding exposes a writer");
  }
}

/** Existing global-memory contract kept for pre-tool benchmark scripts. */
export interface LegacyMemory {
  recall(features: string[], limit?: number): Promise<Hint[]>;
  remember(lesson: LegacyLessonInput): Promise<MemoryWriteResult | void>;
  /** Freezes the current store to its own file and returns that file's id. */
  snapshot(): Promise<string>;
  /** Replaces the working store with a frozen one. */
  restore(id: string): Promise<void>;
}

export class InMemoryMemory implements Memory {
  readonly promptMetadata = sharedMemoryPromptMetadata();
  readonly promptPort: MemoryAdapterPromptPort = {
    retrieve: (request) => {
      if (request.operation !== "retrieve" || typeof request.query !== "string") {
        return Promise.reject(new Error("InMemoryMemory retrieve prompt binding is invalid"));
      }
      return this.recall(request.query, request.limit ?? RECALL_LIMIT, request.prompt);
    },
    store: (request) => {
      if (request.operation !== "store" || request.lesson === undefined) {
        return Promise.reject(new Error("InMemoryMemory store prompt binding is invalid"));
      }
      return this.remember(request.lesson, request.prompt);
    },
  };
  readonly lessons: Lesson[] = [];
  #byIdempotencyKey = new Map<string, string>();

  async recall(queryOrFeatures: string | string[], limit: number = RECALL_LIMIT, _prompt?: MemoryPrompt): Promise<Hint[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const query = Array.isArray(queryOrFeatures) ? queryOrFeatures.join("\n") : queryOrFeatures;
    const tokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
    const lessons = this.lessons
      .map((lesson) => {
        const text = [lesson.content, ...lesson.triggers].join("\n").toLowerCase();
        let score = 0;
        for (const token of tokens) if (text.includes(token)) score += 1;
        return { lesson, score };
      })
      .filter((entry) => tokens.size === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || (a.lesson.id < b.lesson.id ? -1 : 1))
      .slice(0, limit);
    return lessons.map((entry) => renderHint(entry.lesson));
  }

  async remember(input: LessonInput, _prompt?: MemoryPrompt): Promise<MemoryWriteResult> {
    const existingId = this.#byIdempotencyKey.get(input.idempotencyKey);
    if (existingId !== undefined) return { status: "already_stored", lessonId: existingId };

    const lesson: Lesson = {
      id: `lesson-${String(this.lessons.length + 1).padStart(4, "0")}`,
      content: input.content,
      sourceAttemptId: input.sourceAttemptId,
      triggers: [...input.triggers],
      region: input.region,
      hits: 0,
      wins: 0,
      featureKey: input.featureKey,
      memoryHitId: input.memoryHitId,
      effect: input.effect,
      idempotencyKey: input.idempotencyKey,
    };
    this.lessons.push(lesson);
    this.#byIdempotencyKey.set(input.idempotencyKey, lesson.id);
    return { status: "stored", lessonId: lesson.id };
  }

  async snapshot(): Promise<string> {
    return "in-memory";
  }

  async restore(): Promise<void> {
    this.lessons.length = 0;
    this.#byIdempotencyKey = new Map<string, string>();
  }
}

export async function resolveMemoryBinding(config: {
  memoryRef: string | null;
  mode: "training" | "evaluation" | "production";
  snapshotId: string | null;
  readOnly: boolean;
  recallLimit: 1 | 2 | 3 | 4 | 5;
}, resolver: MemorySourceResolver): Promise<MemoryBinding> {
  if (config.mode !== "training" && config.mode !== "evaluation" && config.mode !== "production") {
    throw new Error("unknown memory mode");
  }
  parseRecallLimit(config.recallLimit, "recallLimit");
  const memoryRef = config.memoryRef;
  if (memoryRef !== null && (typeof memoryRef !== "string" || memoryRef.trim() === "")) {
    throw new Error("memoryRef must be null or non-empty");
  }
  if (config.mode === "evaluation") {
    if (typeof config.snapshotId !== "string" || config.snapshotId.trim() === "" || config.readOnly !== true) {
      throw new Error("evaluation memory requires a non-empty snapshotId and readOnly=true");
    }
  } else if (config.mode === "production") {
    if (config.readOnly !== true) throw new Error("production memory requires readOnly=true");
  } else if (config.readOnly !== false || config.snapshotId !== null) {
    throw new Error("training memory requires snapshotId=null and readOnly=false");
  }

  if (memoryRef === null) {
    if (config.mode === "evaluation") {
      return markResolvedBinding({
        identity: Symbol("memory-binding:null"),
        promptPort: NOOP_MEMORY_PROMPT_PORT,
        memoryRef: null,
        mode: "evaluation",
        reader: NOOP_MEMORY_READER,
        snapshotId: config.snapshotId as string,
        readOnly: true,
      });
    }
    if (config.mode === "production") {
      return markResolvedBinding({
        identity: Symbol("memory-binding:null"),
        promptPort: NOOP_MEMORY_PROMPT_PORT,
        memoryRef: null,
        mode: "production",
        reader: NOOP_MEMORY_READER,
        snapshotId: config.snapshotId,
        readOnly: true,
      });
    }
    return markResolvedBinding({
      identity: Symbol("memory-binding:null"),
      promptPort: NOOP_MEMORY_PROMPT_PORT,
      memoryRef: null,
      mode: "training",
      reader: NOOP_MEMORY_READER,
      writer: NOOP_MEMORY_WRITER,
      snapshotId: null,
      readOnly: false,
    });
  }

  let source: MemorySourceBinding;
  try {
    source = await resolver.resolve(memoryRef);
  } catch (error) {
    const code = memoryBindingFailureCodeOrNull(error) ?? "unavailable";
    throw new MemoryBindingError(code, `unable to resolve memoryRef ${memoryRef}`, { cause: error });
  }
  if (
    typeof source !== "object" ||
    source === null ||
    !MEMORY_SOURCE_BINDINGS.has(source) ||
    typeof source.identity !== "symbol" ||
    source.memoryRef !== memoryRef ||
    typeof source.reader?.recall !== "function" ||
    typeof source.promptPort?.retrieve !== "function" ||
    typeof source.promptPort?.store !== "function"
  ) {
    throw new MemoryBindingError(
      source?.memoryRef === memoryRef ? "unavailable" : "memory_mismatch",
      "memory source resolver returned an invalid binding",
    );
  }
  validateMemorySourceBinding(source);
  let reader = source.reader;
  let promptPort = source.promptPort;
  let bindingIdentity = source.identity;
  if (config.snapshotId !== null && source.loadSnapshot === undefined) {
    throw new MemoryBindingError(
      "unavailable",
      `memoryRef ${memoryRef} does not support frozen snapshot ${config.snapshotId}`,
    );
  }
  if (config.snapshotId !== null && source.loadSnapshot !== undefined) {
    try {
      const snapshot = await source.loadSnapshot(config.snapshotId);
      validateFrozenSnapshotBinding(snapshot, { memoryRef, snapshotId: config.snapshotId });
      reader = snapshot.reader;
      promptPort = snapshot.promptPort;
      bindingIdentity = snapshot.identity;
    } catch (error) {
      throw new MemoryBindingError(memoryBindingFailureCode(error), `unable to load memory snapshot ${config.snapshotId}`, { cause: error });
    }
  }

  if (config.mode === "evaluation") {
    return markResolvedBinding({
      memoryRef,
      mode: "evaluation",
      identity: bindingIdentity,
      promptPort,
      reader,
      snapshotId: config.snapshotId as string,
      readOnly: true,
    });
  }
  if (config.mode === "production") {
    const readOnlyMemory = readerOnly(reader);
    return markResolvedBinding({
      memoryRef,
      mode: "production",
      identity: bindingIdentity,
      promptPort: readOnlyMemory.promptPort!,
      reader: readOnlyMemory,
      snapshotId: config.snapshotId,
      readOnly: true,
    });
  }
  if (source.writer === undefined) {
    throw new MemoryBindingError("unavailable", "training memory source must expose a writer");
  }
  return markResolvedBinding({
    memoryRef,
    mode: "training",
    identity: source.identity,
    promptPort: source.promptPort,
    reader,
    writer: source.writer,
    snapshotId: null,
    readOnly: false,
  });
}

const NOOP_MEMORY_READER: MemoryReader = { recall: async () => [] };

const NOOP_MEMORY_WRITER: MemoryWriter = {
  ...NOOP_MEMORY_READER,
  async remember(): Promise<MemoryWriteResult> {
    throw new MemoryWriteError("write_failed", "memoryRef=null is read/write disabled");
  },
  async snapshot(): Promise<string> {
    return "null";
  },
  async restore(id: string): Promise<void> {
    if (id !== "null") throw new Error(`null memory cannot restore snapshot ${id}`);
  },
};

const NOOP_MEMORY_PROMPT_PORT = fallbackPromptPort(NOOP_MEMORY_READER, NOOP_MEMORY_WRITER);
NOOP_MEMORY_READER.promptPort = NOOP_MEMORY_PROMPT_PORT;
NOOP_MEMORY_WRITER.promptPort = NOOP_MEMORY_PROMPT_PORT;

export function createNoopMemoryBinding(config: {
  mode: "training" | "evaluation" | "production";
  snapshotId: string | null;
}): MemoryBinding {
  const promptPort = NOOP_MEMORY_PROMPT_PORT;
  if (config.mode === "training") {
    return markResolvedBinding({
      identity: Symbol("memory-binding:null"),
      promptPort,
      memoryRef: null,
      mode: "training",
      reader: NOOP_MEMORY_READER,
      writer: NOOP_MEMORY_WRITER,
      snapshotId: null,
      readOnly: false,
    });
  }
  if (config.mode === "evaluation") {
    if (config.snapshotId === null) throw new MemoryBindingError("memory_mismatch", "evaluation no-op binding requires snapshotId");
    return markResolvedBinding({
      identity: Symbol("memory-binding:null"),
      promptPort,
      memoryRef: null,
      mode: "evaluation",
      reader: NOOP_MEMORY_READER,
      snapshotId: config.snapshotId,
      readOnly: true,
    });
  }
  return markResolvedBinding({
    identity: Symbol("memory-binding:null"),
    promptPort,
    memoryRef: null,
    mode: "production",
    reader: NOOP_MEMORY_READER,
    snapshotId: config.snapshotId,
    readOnly: true,
  });
}
