import { createHash } from "node:crypto";
import type { Guess } from "../agent.ts";
import { isNormalizedFeatureKey, unicodeCodePointLength } from "../observe.ts";
import { countSentences } from "../sentence-count.ts";
import type { FeatureKey, FeatureObservation } from "../observe.ts";
import {
  MemoryWriteError,
  MemoryBindingError,
  memoryBindingFailureCodeOrNull,
  type Hint,
  type LessonInput,
  type MemoryAdapterPromptPort,
  type MemoryReader,
  recallWithMemoryPrompt,
  rememberWithMemoryPrompt,
  type MemoryWriteErrorCode,
  type MemoryWriter,
  type ReflectionEffect,
} from "../memory/memory.ts";
import { loadPrompt } from "../promts.ts";
import { makeMemoryIdempotencyKey } from "../memory/provenance.ts";
export {
  resolveMemoryBinding,
  type MemorySourceBinding,
  type MemorySourceResolver,
} from "../memory/memory.ts";
export type { MemoryBinding } from "../memory/memory.ts";

export type { ReflectionEffect };

export type MemoryHit = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  providerId: string | null;
  text: string;
  score: number | null;
  effect: ReflectionEffect | null;
};

export type RetrievalStatus = "hits" | "no_hit" | "failed";
export type RetrievalFailure =
  | "invalid_tool_arguments"
  | "wrong_feature"
  | "missing_tool_call"
  | "multiple_tool_calls"
  | "malformed_tool_json"
  | "memory_error"
  | "unavailable"
  | "timeout"
  | "budget_exhausted"
  | "skipped";

export type FeatureMemoryGroup = {
  attemptId: string;
  feature: FeatureObservation;
  query: string | null;
  status: RetrievalStatus;
  hits: MemoryHit[];
  failure: RetrievalFailure | null;
  /** Number of retries after the first model/provider attempt. */
  retryCount: number;
};

export type EpisodeTrace = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  effect: ReflectionEffect | null;
  reflectionStatus:
    | "stored"
    | "already_stored"
    | "write_failed"
    | "write_outcome_unknown"
    | "unsupported"
    | "memory_not_found"
    | "memory_mismatch"
    | "unavailable"
    | "timeout"
    | "reflection_failed";
  failure?:
    | "write_failed"
    | "write_outcome_unknown"
    | "unsupported"
    | "memory_not_found"
    | "memory_mismatch"
    | "unavailable"
    | "timeout"
    | "missing_tool_call"
    | "multiple_tool_calls"
    | "malformed_tool_json"
    | "invalid_tool_arguments"
    | "foreign_hit";
  lessonId: string | null;
};

export type ToolEvent = {
  attemptId: string;
  phase: "retrieve" | "analyze" | "reflect";
  operation: "memory_retrieve" | "memory_store";
  featureKey: FeatureKey;
  memoryHitId: string | null;
  status: string;
  sequence: number;
  /** Binding provenance for provider calls; null means the no-memory path. */
  memoryRef?: string | null;
  promptVersion?: string;
  promptDigest?: string;
};

export type AttemptTrace = {
  attemptId: string;
  groups: FeatureMemoryGroup[];
  episodes: EpisodeTrace[];
  events: ToolEvent[];
};

export type LocateResult = {
  attemptId: string;
  guess: Guess;
  observations: FeatureObservation[];
  memoryGroups: FeatureMemoryGroup[];
  episodes: EpisodeTrace[];
  trace: AttemptTrace;
};

export type MemoryRetrieveToolResult = {
  attempt_id: string;
  feature_key: FeatureKey;
  status: RetrievalStatus;
  hits: Array<{
    memory_hit_id: string;
    provider_id: string | null;
    text: string;
    score: number | null;
    effect: ReflectionEffect | null;
  }>;
  failure: RetrievalFailure | null;
};

export type MemoryStoreToolResult =
  | { status: "stored" | "already_stored"; lesson_id: string; failure: null }
  | {
      status: "write_failed" | "write_outcome_unknown" | "unsupported" | WorkflowMemoryFailure;
      lesson_id: null;
      failure: "write_failed" | "write_outcome_unknown" | "unsupported" | WorkflowMemoryFailure;
    };

export type WorkflowMemoryFailure =
  | "memory_not_found"
  | "memory_mismatch"
  | "unavailable"
  | "timeout";

export type DynamicFailureMapping = {
  providerError: WorkflowMemoryFailure;
  featureGroup: RetrievalFailure;
  workflowOutcome: "degraded" | "sample_failed" | "run_aborted";
};

export type MemoryRetrieveArgs = {
  feature_key: FeatureKey;
  query: string;
};

export const MEMORY_RETRIEVE_TOOL = {
  type: "function",
  function: {
    name: "memory_retrieve",
    description: loadPrompt("memory-retrieve"),
    strict: true,
    parameters: {
        type: "object",
        properties: {
        feature_key: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9_]{0,63}$",
        },
        query: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["feature_key", "query"],
      additionalProperties: false,
    },
  },
} as const;

export type MemoryStoreArgs = {
  feature_key: FeatureKey;
  memory_hit_id: string;
  effect: ReflectionEffect;
  content: string;
  triggers: string[];
  region: string;
};

export const MEMORY_STORE_TOOL = {
  type: "function",
  function: {
    name: "memory_store",
    description: loadPrompt("memory-store"),
    strict: true,
    parameters: {
        type: "object",
        properties: {
        feature_key: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9_]{0,63}$",
        },
        memory_hit_id: { type: "string", minLength: 1 },
        effect: {
          type: "string",
          enum: ["helped", "irrelevant", "misleading", "insufficient"],
        },
        content: { type: "string", minLength: 1, maxLength: 2_000 },
        triggers: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        region: { type: "string", minLength: 2, maxLength: 2, pattern: "^[A-Z]{2}$" },
      },
      required: ["feature_key", "memory_hit_id", "effect", "content", "triggers", "region"],
      additionalProperties: false,
    },
  },
} as const;

export type MemoryToolPhase = "retrieve" | "reflect";
export type WorkflowMode = "training" | "evaluation" | "production";

export type MemoryRunConfig = {
  /** Null disables provider access and writes. This field is intentionally mandatory. */
  memoryRef: string | null;
  mode: WorkflowMode;
  snapshotId: string | null;
  readOnly: boolean;
  recallLimit: 1 | 2 | 3 | 4 | 5;
};

export type MemoryToolContext = {
  attemptId: string;
  reader: MemoryReader;
  writer?: MemoryWriter;
  /** Resolver-owned prompt boundary; provider calls must go through this port. */
  promptPort?: MemoryAdapterPromptPort;
  phase: MemoryToolPhase;
  run: MemoryRunConfig;
  activeFeature: FeatureObservation;
  activeMemoryHit?: MemoryHit;
};

export type RetrievalMetric = {
  featureKey: FeatureKey;
  class: "rare" | "broad";
  expectedProviderIds: string[];
  returnedProviderIds: string[];
  hit: boolean;
};

export type AttemptMetrics = {
  attemptId: string;
  visibleFeatures: number;
  retrievalOutcomes: number;
  memoryHits: number;
  episodesByEffect: Record<ReflectionEffect, number>;
  rareCueHitRate: number | null;
  broadCueHitRate: number | null;
  legacyGlobalTopKRareCueHitRate: number | null;
  featureScopedRareCueHitRate: number | null;
  geoscore: number | null;
  validOutput: boolean;
  toolCalls: number;
  latencyMs: number;
};

export type FrozenMemoryConfig = {
  mode: "evaluation";
  snapshotId: string;
  readOnly: true;
};

export class MemoryToolValidationError extends Error {
  readonly failure: RetrievalFailure | MemoryWriteErrorCode | "foreign_hit";

  constructor(failure: RetrievalFailure | MemoryWriteErrorCode | "foreign_hit", message?: string) {
    super(message ?? failure);
    this.name = "MemoryToolValidationError";
    this.failure = failure;
  }
}

const REFLECTION_EFFECTS: readonly ReflectionEffect[] = [
  "helped",
  "irrelevant",
  "misleading",
  "insufficient",
];
function stableHash(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isFeatureKey(value: unknown): value is FeatureKey {
  return isNormalizedFeatureKey(value);
}

function isReflectionEffect(value: unknown): value is ReflectionEffect {
  return typeof value === "string" && (REFLECTION_EFFECTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedGroup(
  context: MemoryToolContext,
  failure: RetrievalFailure,
  query: string | null = null,
): FeatureMemoryGroup {
  return {
    attemptId: context.attemptId,
    feature: context.activeFeature,
    query,
    status: "failed",
    hits: [],
    failure,
    retryCount: 0,
  };
}

function parseToolArguments(
  input: unknown,
  expectedTool: "memory_retrieve" | "memory_store",
): unknown {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new MemoryToolValidationError("missing_tool_call");
    if (input.length > 1) throw new MemoryToolValidationError("multiple_tool_calls");
    return parseToolArguments(input[0], expectedTool);
  }
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as unknown;
    } catch {
      throw new MemoryToolValidationError("malformed_tool_json");
    }
  }
  if (isRecord(input) && isRecord(input.function)) {
    const name = input.function.name;
    if (name !== expectedTool) throw new MemoryToolValidationError("missing_tool_call");
    const rawArgs = input.function.arguments;
    if (typeof rawArgs !== "string") throw new MemoryToolValidationError("malformed_tool_json");
    try {
      return JSON.parse(rawArgs) as unknown;
    } catch {
      throw new MemoryToolValidationError("malformed_tool_json");
    }
  }
  return input;
}

function validateRetrieveArgs(input: unknown): MemoryRetrieveArgs {
  const value = parseToolArguments(input, "memory_retrieve");
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  if (!isFeatureKey(value.feature_key)) throw new MemoryToolValidationError("invalid_tool_arguments");
  if (typeof value.query !== "string") throw new MemoryToolValidationError("invalid_tool_arguments");
  const query = value.query.trim().replace(/\s+/g, " ");
  if (query === "" || unicodeCodePointLength(query) > 512) throw new MemoryToolValidationError("invalid_tool_arguments");
  return { feature_key: value.feature_key, query };
}

function validateStoreArgs(input: unknown): MemoryStoreArgs {
  const value = parseToolArguments(input, "memory_store");
  if (!isRecord(value) || Object.keys(value).length !== 6) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  if (!isFeatureKey(value.feature_key)) throw new MemoryToolValidationError("invalid_tool_arguments");
  if (typeof value.memory_hit_id !== "string" || value.memory_hit_id.trim() === "") {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  if (!isReflectionEffect(value.effect)) throw new MemoryToolValidationError("invalid_tool_arguments");
  if (typeof value.content !== "string") throw new MemoryToolValidationError("invalid_tool_arguments");
  if (value.content.trim() === "" || unicodeCodePointLength(value.content) > 2_000) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  const content = value.content.trim().replace(/\s+/g, " ");
  if (countSentences(content) > 2) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  if (!Array.isArray(value.triggers) || value.triggers.length < 1 || value.triggers.length > 8) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  const triggers = value.triggers.map((trigger) => {
    if (typeof trigger !== "string") throw new MemoryToolValidationError("invalid_tool_arguments");
    if (trigger.trim() === "" || unicodeCodePointLength(trigger) > 128) {
      throw new MemoryToolValidationError("invalid_tool_arguments");
    }
    const normalized = trigger.trim().replace(/\s+/g, " ");
    return normalized;
  });
  if (typeof value.region !== "string" || !/^[A-Z]{2}$/.test(value.region)) {
    throw new MemoryToolValidationError("invalid_tool_arguments");
  }
  return {
    feature_key: value.feature_key,
    memory_hit_id: value.memory_hit_id.trim(),
    effect: value.effect,
    content,
    triggers,
    region: value.region,
  };
}

export function validateMemoryRunConfig(run: MemoryRunConfig): void {
  if (run.mode !== "training" && run.mode !== "evaluation" && run.mode !== "production") {
    throw new MemoryToolValidationError("invalid_tool_arguments", "unknown memory mode");
  }
  if (!Number.isInteger(run.recallLimit) || run.recallLimit < 1 || run.recallLimit > 5) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "recallLimit must be 1..5");
  }
  if (run.memoryRef === undefined || (run.memoryRef !== null && (typeof run.memoryRef !== "string" || run.memoryRef.trim() === ""))) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "memoryRef must be null or non-empty");
  }
  if (run.mode === "evaluation" && (run.readOnly !== true || run.snapshotId === null || run.snapshotId.trim() === "")) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "evaluation memory must be frozen");
  }
  if (run.mode === "production" && run.readOnly !== true) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "production memory must be read-only");
  }
  if (run.mode === "training" && (run.readOnly !== false || run.snapshotId !== null)) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "training memory must be writable");
  }
}

function hintProviderId(hint: Hint): string | null {
  const id = hint.lessonId.trim();
  return id === "" ? null : id;
}

function isValidHint(value: unknown): value is Hint {
  try {
    if (!isRecord(value)) return false;
    if (typeof value.lessonId !== "string") return false;
    if (typeof value.text !== "string" || value.text.trim() === "") return false;
    if (value.featureKey !== undefined && !isFeatureKey(value.featureKey)) return false;
    if (value.effect !== undefined && !isReflectionEffect(value.effect)) return false;
    const score = (value as { score?: unknown }).score;
    if (score !== undefined && score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateRecallOutput(value: unknown): Hint[] | null {
  if (!Array.isArray(value)) return null;
  const hints: Hint[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const hint = value[index];
    if (!isValidHint(hint)) return null;
    hints.push(hint);
  }
  return hints;
}

function hintText(hint: Hint): string {
  return hint.text.trim().replace(/\s+/g, " ");
}

function hintScore(hint: Hint): number | null {
  const value = (hint as { score?: unknown }).score;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMemoryWriteResult(value: unknown): value is { status: "stored" | "already_stored"; lessonId: string } {
  return (
    isRecord(value) &&
    (value.status === "stored" || value.status === "already_stored") &&
    typeof value.lessonId === "string" &&
    value.lessonId.trim() !== ""
  );
}

function errorStringProperty(error: unknown, property: string): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isTimeoutFailure(error: unknown): boolean {
  const code = errorStringProperty(error, "code");
  if (code === "timeout" || code === "ETIMEDOUT") return true;
  const name = errorStringProperty(error, "name");
  return name === "TimeoutError" || name === "AbortError";
}

function requirePromptPort(context: MemoryToolContext): MemoryAdapterPromptPort {
  const readerPromptPort = context.reader.promptPort;
  const contextPromptPort = context.promptPort;
  if (readerPromptPort !== undefined && contextPromptPort !== undefined && readerPromptPort !== contextPromptPort) {
    throw new MemoryBindingError(
      "memory_mismatch",
      "memory tool prompt boundary must belong to the active reader",
    );
  }
  const promptPort = readerPromptPort ?? contextPromptPort ?? {
    retrieve: async (request) => {
      if (request.query === undefined) throw new Error("memory retrieve query is required");
      return context.reader.recall(request.query, request.limit ?? context.run.recallLimit, request.prompt);
    },
    store: async (request) => {
      if (context.writer === undefined || request.lesson === undefined) {
        throw new MemoryWriteError("write_failed", "memory binding is not writable");
      }
      return context.writer.remember(request.lesson, request.prompt);
    },
  } satisfies MemoryAdapterPromptPort;
  if (
    typeof promptPort.retrieve !== "function" ||
    typeof promptPort.store !== "function"
  ) {
    throw new MemoryToolValidationError(
      "invalid_tool_arguments",
      "memory binding prompt boundary is missing",
    );
  }
  return promptPort;
}

export function makeMemoryHitId(
  attemptId: string,
  featureKey: FeatureKey,
  providerId: string | null,
  text: string,
  occurrence: number,
): string {
  const digest = stableHash(
    attemptId,
    featureKey,
    providerId ?? "",
    normalizeText(text),
    String(occurrence),
  ).slice(0, 12);
  return `${attemptId}/${featureKey}/${digest}`;
}

export function makeIdempotencyKey(
  attemptId: string,
  featureKey: FeatureKey,
  memoryHitId: string,
): string {
  return makeMemoryIdempotencyKey(attemptId, featureKey, memoryHitId);
}

export function memoryToolsForPhase(
  phase: MemoryToolPhase | "analyze",
): readonly [typeof MEMORY_RETRIEVE_TOOL] | readonly [typeof MEMORY_STORE_TOOL] | readonly [] {
  if (phase === "retrieve") return [MEMORY_RETRIEVE_TOOL] as const;
  if (phase === "reflect") return [MEMORY_STORE_TOOL] as const;
  return [] as const;
}

export async function executeMemoryRetrieve(
  context: MemoryToolContext,
  args: unknown,
): Promise<FeatureMemoryGroup> {
  validateMemoryRunConfig(context.run);
  if (context.phase !== "retrieve") return failedGroup(context, "skipped");
  if (context.run.memoryRef === null) {
    return {
      attemptId: context.attemptId,
      feature: { key: context.activeFeature.key, text: context.activeFeature.text },
      query: null,
      status: "no_hit",
      hits: [],
      failure: null,
      retryCount: 0,
    };
  }
  if (context.reader.featureScope === "global") {
    return failedGroup(context, "invalid_tool_arguments");
  }
  const promptPort = requirePromptPort(context);

  let parsed: MemoryRetrieveArgs;
  try {
    parsed = validateRetrieveArgs(args);
  } catch (error) {
    if (error instanceof MemoryToolValidationError) {
      return failedGroup(context, error.failure as RetrievalFailure);
    }
    throw error;
  }
  if (parsed.feature_key !== context.activeFeature.key) {
    return failedGroup(context, "wrong_feature", parsed.query);
  }

  let hints: Hint[];
  try {
    const output = await recallWithMemoryPrompt(context.reader, {
      memoryRef: context.run.memoryRef,
      featureKey: context.activeFeature.key,
      query: parsed.query,
      limit: context.run.recallLimit,
    }, promptPort);
    const validated = validateRecallOutput(output);
    if (validated === null) return failedGroup(context, "memory_error", parsed.query);
    hints = validated;
  } catch (error) {
    if (error instanceof MemoryToolValidationError) throw error;
    const providerFailure = memoryBindingFailureCodeOrNull(error);
    if (providerFailure !== null) {
      throw new MemoryBindingError(providerFailure, `memory provider failed during recall: ${providerFailure}`, { cause: error });
    }
    return failedGroup(
      context,
      providerFailure === "timeout" || isTimeoutFailure(error)
        ? "timeout"
        : providerFailure === "unavailable"
          ? "unavailable"
          : "memory_error",
      parsed.query,
    );
  }

  const hits = hints.slice(0, Math.min(context.run.recallLimit, 5)).map((hint, index) => {
    const text = hintText(hint);
    const providerId = hintProviderId(hint);
    return {
      attemptId: context.attemptId,
      featureKey: context.activeFeature.key,
      memoryHitId: makeMemoryHitId(context.attemptId, context.activeFeature.key, providerId, text, index),
      providerId,
      text,
      score: hintScore(hint),
      effect: hint.effect ?? null,
    };
  });

  return {
    attemptId: context.attemptId,
    feature: context.activeFeature,
    query: parsed.query,
    status: hits.length === 0 ? "no_hit" : "hits",
    hits,
    failure: null,
    retryCount: 0,
  };
}

export async function executeMemoryStore(
  context: MemoryToolContext,
  args: unknown,
): Promise<
  | { status: "stored" | "already_stored"; lessonId: string; failure: null }
  | {
      status: "write_failed" | "write_outcome_unknown" | "unsupported";
      lessonId: null;
      failure: "write_failed" | "write_outcome_unknown" | "unsupported";
    }
  | {
      status: WorkflowMemoryFailure;
      lessonId: null;
      failure: WorkflowMemoryFailure;
    }
> {
  validateMemoryRunConfig(context.run);
  if (context.run.memoryRef === null) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "memory_store is disabled when memoryRef=null");
  }
  if (
    context.phase !== "reflect" ||
    context.run.mode !== "training" ||
    context.run.readOnly !== false ||
    context.writer === undefined ||
    context.activeMemoryHit === undefined
  ) {
    throw new MemoryToolValidationError("invalid_tool_arguments", "memory_store is not enabled");
  }
  const promptPort = requirePromptPort(context);

  const parsed = validateStoreArgs(args);
  const hit = context.activeMemoryHit;
  if (
    hit.attemptId !== context.attemptId ||
    hit.featureKey !== context.activeFeature.key ||
    parsed.feature_key !== hit.featureKey ||
    parsed.memory_hit_id !== hit.memoryHitId
  ) {
    throw new MemoryToolValidationError("foreign_hit");
  }

  const lesson: LessonInput = {
    content: parsed.content,
    sourceAttemptId: context.attemptId,
    featureKey: parsed.feature_key,
    memoryHitId: parsed.memory_hit_id,
    effect: parsed.effect,
    triggers: parsed.triggers,
    region: parsed.region,
    idempotencyKey: makeIdempotencyKey(context.attemptId, parsed.feature_key, parsed.memory_hit_id),
  };

  try {
    const result = await rememberWithMemoryPrompt(context.writer, {
      memoryRef: context.run.memoryRef,
      featureKey: context.activeFeature.key,
      lesson,
    }, promptPort);
    if (!isMemoryWriteResult(result)) {
      return { status: "write_outcome_unknown", lessonId: null, failure: "write_outcome_unknown" };
    }
    return { status: result.status, lessonId: result.lessonId, failure: null };
  } catch (error) {
    if (error instanceof MemoryWriteError) {
      return { status: error.code, lessonId: null, failure: error.code };
    }
    const bindingFailure = memoryBindingFailureCodeOrNull(error);
    if (bindingFailure !== null) {
      return { status: bindingFailure, lessonId: null, failure: bindingFailure };
    }
    return { status: "write_outcome_unknown", lessonId: null, failure: "write_outcome_unknown" };
  }
}

export function serializeMemoryRetrieveResult(group: FeatureMemoryGroup): MemoryRetrieveToolResult {
  return {
    attempt_id: group.attemptId,
    feature_key: group.feature.key,
    status: group.status,
    hits: group.hits.map((hit) => ({
      memory_hit_id: hit.memoryHitId,
      provider_id: hit.providerId,
      text: hit.text,
      score: hit.score,
      effect: hit.effect,
    })),
    failure: group.failure,
  };
}

export function serializeMemoryStoreResult(
  result: Awaited<ReturnType<typeof executeMemoryStore>>,
): MemoryStoreToolResult {
  if (result.failure === null) {
    return { status: result.status, lesson_id: result.lessonId, failure: null };
  }
  return { status: result.status, lesson_id: null, failure: result.failure };
}
