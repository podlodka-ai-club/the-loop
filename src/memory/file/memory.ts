/**
 * JSONL-backed Memory adapter.
 *
 * Lessons are stored as one JSON object per line. The file remains readable in a
 * diff, and a control run can swap the whole store for a different file without a
 * migration.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { isNormalizedFeatureKey } from "../../observe.ts";
import { countSentences } from "../../sentence-count.ts";
import { makeMemoryIdempotencyKey } from "../provenance.ts";
import {
  isSharedMemoryPrompt,
  MemoryBindingError,
  MemoryWriteError,
  RECALL_LIMIT,
  renderHint,
  sharedMemoryPrompt,
  sharedMemoryPromptMetadata,
} from "../memory.ts";
import type {
  Hint,
  LegacyLesson,
  LegacyLessonInput,
  LegacyMemory,
  Lesson,
  LessonInput,
  Memory,
  MemoryReader,
  MemoryReaderFeatureScope,
  MemoryWriteResult,
  MemoryAdapterPromptPort,
  MemoryPrompt,
  MemorySnapshotMode,
} from "../memory.ts";

export const MEMORY_DIR = process.env.MEMORY_DIR ?? join("data", "memory");
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{12}$/;
const LOCK_WAIT_MS = 5;
const LOCK_HEARTBEAT_MS = 5_000;

function currentMemoryDir(): string {
  // Tests and embedded callers may set MEMORY_DIR after module loading. Keep
  // the exported legacy constant for compatibility, but resolve filesystem
  // operations against the current process configuration.
  return process.env.MEMORY_DIR ?? MEMORY_DIR;
}

type FrozenReaderMetadata = {
  snapshotId: string;
  recall: MemoryReader["recall"];
  promptPort: MemoryAdapterPromptPort | undefined;
};

// The marker is deliberately private to this module. There is no exported
// token or marking function, so importing an internal helper cannot turn a live
// reader (or arbitrary lesson array) into a frozen reader.
const TRUSTED_FROZEN_READERS = new WeakSet<object>();
const TRUSTED_FROZEN_METADATA = new WeakMap<object, FrozenReaderMetadata>();

function cloneFrozenPrompt(prompt: MemoryPrompt): MemoryPrompt {
  return Object.freeze({
    operation: prompt.operation,
    text: prompt.text,
    version: prompt.version,
    digest: prompt.digest,
  });
}

function cloneFrozenPromptMetadata(
  metadata: MemoryReader["promptMetadata"],
): MemoryReader["promptMetadata"] {
  if (metadata === undefined) return undefined;
  return Object.freeze({
    retrieve: cloneFrozenPrompt(metadata.retrieve),
    store: cloneFrozenPrompt(metadata.store),
  });
}

function freezePromptPort(port: MemoryAdapterPromptPort): MemoryAdapterPromptPort {
  for (const value of Object.values(port)) {
    if (typeof value === "function") Object.freeze(value);
  }
  return Object.freeze(port);
}

function markTrustedFrozenReader(reader: MemoryReader, snapshotId: string): MemoryReader {
  if (reader.promptMetadata !== undefined) {
    Object.defineProperty(reader, "promptMetadata", {
      configurable: false,
      enumerable: true,
      value: cloneFrozenPromptMetadata(reader.promptMetadata),
      writable: false,
    });
  }
  if (reader.promptPort !== undefined) {
    freezePromptPort(reader.promptPort);
    Object.defineProperty(reader, "promptPort", {
      configurable: false,
      enumerable: true,
      value: reader.promptPort,
      writable: false,
    });
  }
  TRUSTED_FROZEN_READERS.add(reader);
  TRUSTED_FROZEN_METADATA.set(reader, {
    snapshotId,
    recall: reader.recall,
    promptPort: reader.promptPort,
  });
  // The trusted marker alone is not enough: callers can still mutate a
  // structural reader with Reflect or Object.defineProperty after it has been
  // accepted. Freeze the reader itself so its frozen identity and methods stay
  // immutable for the lifetime of the binding.
  return Object.freeze(reader);
}

export function isTrustedFrozenMemoryReader(
  reader: unknown,
  snapshotId: string,
): reader is MemoryReader {
  if (typeof reader !== "object" || reader === null || !TRUSTED_FROZEN_READERS.has(reader)) return false;
  const metadata = TRUSTED_FROZEN_METADATA.get(reader);
  const candidate = reader as MemoryReader;
  return metadata?.snapshotId === snapshotId &&
    metadata.recall === candidate.recall &&
    metadata.promptPort === candidate.promptPort;
}

export function trustedFrozenSnapshotId(reader: unknown): string | null {
  if (typeof reader !== "object" || reader === null || !TRUSTED_FROZEN_READERS.has(reader)) return null;
  return TRUSTED_FROZEN_METADATA.get(reader)?.snapshotId ?? null;
}

type LockOwner = {
  pid: number;
  token: string;
};

const ACTIVE_LOCKS = new Map<string, string>();

function readLockOwner(value: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { pid?: unknown }).pid !== "number" ||
      !Number.isSafeInteger((parsed as { pid: number }).pid) ||
      (parsed as { pid: number }).pid <= 0 ||
      typeof (parsed as { token?: unknown }).token !== "string" ||
      (parsed as { token: string }).token.trim() === ""
    ) {
      return null;
    }
    return {
      pid: (parsed as { pid: number }).pid,
      token: (parsed as { token: string }).token,
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwnerIsLive(lockPath: string, owner: LockOwner): boolean {
  if (owner.pid === process.pid) return ACTIVE_LOCKS.get(lockPath) === owner.token;
  return processIsAlive(owner.pid);
}

async function reclaimDeadLock(lockPath: string, owner: LockOwner): Promise<void> {
  let current: LockOwner | null;
  try {
    current = readLockOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current === null || current.token !== owner.token || lockOwnerIsLive(lockPath, current)) return;

  const quarantinePath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await unlink(quarantinePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * How recall decides what to show.
 *
 * `all` - every lesson in the store, no ranking at all. At the scale this project
 *   will reach in a sprint (a few hundred lessons, ~50 tokens each) that is ~10k
 *   tokens against a 262k context, so retrieval buys nothing and costs determinism.
 *   This is the default: it makes the memory-on/memory-off delta measurable today,
 *   and it turns ranking into an optimisation rather than a blocker.
 * `top`  - the ranked subset. See `FileMemory.recall` for what "ranked" means and
 *   why it is weaker than it sounds.
 * `off`  - nothing, even from a populated store. Lets one store serve as its own
 *   control without swapping files.
 */
export type RecallMode = "all" | "top" | "off";

export const RECALL_MODES: readonly RecallMode[] = ["all", "top", "off"];

export function parseRecallMode(value: string): RecallMode {
  if ((RECALL_MODES as readonly string[]).includes(value)) return value as RecallMode;
  throw new Error(`unknown recall mode "${value}", expected one of ${RECALL_MODES.join("|")}`);
}

/** Lowercased word set, so ranking compares features the way they were written. */
function tokenize(values: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2) tokens.add(token);
    }
  }
  return tokens;
}

function normalizeRecallInput(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

type StoredLesson = Lesson | LegacyLesson;
export type SnapshotLesson = StoredLesson;

function parseLessons(text: string): StoredLesson[] {
  const lessons: StoredLesson[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lessons.push(JSON.parse(line) as StoredLesson);
  }
  return lessons;
}

const SNAPSHOT_REQUIRED_KEYS = [
  "id",
  "content",
  "sourceAttemptId",
  "triggers",
  "region",
  "hits",
  "wins",
] as const;
const SNAPSHOT_PROVENANCE_KEYS = ["featureKey", "memoryHitId", "effect", "idempotencyKey"] as const;
const SNAPSHOT_OPTIONAL_KEYS = SNAPSHOT_PROVENANCE_KEYS;
const SNAPSHOT_EFFECTS = ["helped", "irrelevant", "misleading", "insufficient"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function unicodeCodePointLength(value: string): number {
  return [...value].length;
}

function hasAllSnapshotProvenance(record: Record<string, unknown>): boolean {
  return SNAPSHOT_PROVENANCE_KEYS.every((key) => Object.hasOwn(record, key));
}

function validateSnapshotLesson(
  value: unknown,
  index: number,
  mode: MemorySnapshotMode,
): asserts value is StoredLesson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot record ${index + 1} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set<string>([...SNAPSHOT_REQUIRED_KEYS, ...SNAPSHOT_OPTIONAL_KEYS]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`snapshot record ${index + 1} has unknown field ${key}`);
  }
  for (const key of SNAPSHOT_REQUIRED_KEYS) {
    if (!Object.hasOwn(record, key)) throw new Error(`snapshot record ${index + 1} is missing ${key}`);
  }
  if (!isNonEmptyString(record.id)) throw new Error(`snapshot record ${index + 1}.id is invalid`);
  if (
    !isNonEmptyString(record.content) ||
    unicodeCodePointLength(record.content) > 2_000 ||
    countSentences(record.content) > 2
  ) {
    throw new Error(`snapshot record ${index + 1}.content is invalid`);
  }
  if (!isNonEmptyString(record.sourceAttemptId)) {
    throw new Error(`snapshot record ${index + 1}.sourceAttemptId is invalid`);
  }
  if (
    !Array.isArray(record.triggers) ||
    record.triggers.length < 1 ||
    record.triggers.length > 8 ||
    record.triggers.some(
      (trigger) =>
        !isNonEmptyString(trigger) ||
        unicodeCodePointLength(trigger) > 128,
    )
  ) {
    throw new Error(`snapshot record ${index + 1}.triggers is invalid`);
  }
  if (typeof record.region !== "string" || !/^[A-Z]{2}$/.test(record.region)) {
    throw new Error(`snapshot record ${index + 1}.region is invalid`);
  }
  if (!Number.isSafeInteger(record.hits) || (record.hits as number) < 0) {
    throw new Error(`snapshot record ${index + 1}.hits is invalid`);
  }
  if (!Number.isSafeInteger(record.wins) || (record.wins as number) < 0) {
    throw new Error(`snapshot record ${index + 1}.wins is invalid`);
  }
  const hasProvenance = hasAllSnapshotProvenance(record);
  if (mode === "dynamic" && !hasProvenance) {
    throw new Error(`snapshot record ${index + 1} is missing dynamic provenance`);
  }
  if (mode === "legacy" && Object.keys(record).some((key) => SNAPSHOT_PROVENANCE_KEYS.includes(key as typeof SNAPSHOT_PROVENANCE_KEYS[number])) && !hasProvenance) {
    throw new Error(`snapshot record ${index + 1} has partial provenance`);
  }
  if (Object.hasOwn(record, "featureKey") && !isNormalizedFeatureKey(record.featureKey)) {
    throw new Error(`snapshot record ${index + 1}.featureKey is invalid`);
  }
  for (const key of ["memoryHitId", "idempotencyKey"] as const) {
    if (Object.hasOwn(record, key) && !isNonEmptyString(record[key])) {
      throw new Error(`snapshot record ${index + 1}.${key} is invalid`);
    }
  }
  if (
    Object.hasOwn(record, "effect") &&
    !(SNAPSHOT_EFFECTS as readonly unknown[]).includes(record.effect)
  ) {
    throw new Error(`snapshot record ${index + 1}.effect is invalid`);
  }
  if (mode === "dynamic" && hasProvenance) {
    if (record.idempotencyKey !== makeMemoryIdempotencyKey(
      record.sourceAttemptId as string,
      record.featureKey as string,
      record.memoryHitId as string,
    )) {
      throw new Error(`snapshot record ${index + 1}.idempotencyKey is not deterministic`);
    }
  }
}

function snapshotContentHash(text: string): string {
  // snapshot() hashes the JSONL body without its single terminal newline. An
  // extra newline is intentionally left in the hashed content and therefore
  // fails integrity validation instead of being silently normalized away.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

function validateSnapshotContent(snapshotId: string, text: string, mode: MemorySnapshotMode): StoredLesson[] {
  const lessons = parseLessons(text);
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  lessons.forEach((lesson, index) => {
    validateSnapshotLesson(lesson, index, mode);
    if (ids.has(lesson.id)) throw new Error(`snapshot contains duplicate lesson id ${lesson.id}`);
    ids.add(lesson.id);
    if (lesson.idempotencyKey !== undefined) {
      if (idempotencyKeys.has(lesson.idempotencyKey)) {
        throw new Error(`snapshot contains duplicate idempotency key ${lesson.idempotencyKey}`);
      }
      idempotencyKeys.add(lesson.idempotencyKey);
    }
  });
  const actualId = snapshotContentHash(text);
  if (actualId !== snapshotId) {
    throw new Error(`snapshot content hash ${actualId} does not match requested id ${snapshotId}`);
  }
  return lessons;
}

function freezeSnapshotLessons(lessons: readonly StoredLesson[]): readonly StoredLesson[] {
  const frozen = lessons.map((lesson) => Object.freeze({
    ...lesson,
    // The public lesson type predates immutable snapshots and uses a mutable
    // array. Keep the runtime array frozen while retaining that compatibility
    // type at the adapter boundary.
    triggers: Object.freeze([...lesson.triggers]) as unknown as string[],
  }));
  return Object.freeze(frozen) as unknown as readonly StoredLesson[];
}

async function readValidatedSnapshot(
  snapshotId: string,
  snapshotPath: string,
  mode: MemorySnapshotMode,
): Promise<StoredLesson[]> {
  let text: string;
  try {
    text = await readFile(snapshotPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryBindingError("memory_not_found", `memory snapshot ${snapshotId} does not exist`, { cause: error });
    }
    throw new MemoryBindingError("unavailable", `memory snapshot ${snapshotId} is unavailable`, { cause: error });
  }
  try {
    return validateSnapshotContent(snapshotId, text, mode);
  } catch (error) {
    throw new MemoryBindingError("memory_mismatch", `memory snapshot ${snapshotId} is invalid`, { cause: error });
  }
}

export async function loadValidatedSnapshotLessons(
  snapshotId: string,
  mode: MemorySnapshotMode = "dynamic",
): Promise<SnapshotLesson[]> {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new MemoryBindingError("memory_not_found", `invalid memory snapshot id ${snapshotId}`);
  }
  return readValidatedSnapshot(snapshotId, join(currentMemoryDir(), `${snapshotId}.jsonl`), mode);
}

/**
 * Ranking is deliberately the dumbest thing that can work: overlap between the
 * query's tokens and the lesson's trigger tokens. It is a placeholder for a real
 * retriever, and it is a *useful* placeholder only because it is deterministic -
 * comparing memory-on against memory-off requires that the same features pull the
 * same lessons every time.
 */
export class FileMemory implements Memory, LegacyMemory {
  readonly promptMetadata = cloneFrozenPromptMetadata(sharedMemoryPromptMetadata());
  readonly promptPort: MemoryAdapterPromptPort = {
    retrieve: (request) => {
      if (request.operation !== "retrieve" || typeof request.query !== "string") {
        return Promise.reject(new Error("FileMemory retrieve prompt binding is invalid"));
      }
      return this.recall(request.query, request.limit ?? RECALL_LIMIT, request.prompt);
    },
    store: (request) => {
      if (request.operation !== "store" || request.lesson === undefined) {
        return Promise.reject(new Error("FileMemory store prompt binding is invalid"));
      }
      return this.remember(request.lesson, request.prompt);
    },
  };
  readonly path: string;
  readonly mode: RecallMode;
  /** A read-only store never writes back, not even usage counters. */
  readonly readOnly: boolean;
  protected snapshotId: string | null = null;
  protected readonly snapshotLessons: readonly StoredLesson[] | null;

  constructor(
    path = join(currentMemoryDir(), "live.jsonl"),
    mode: RecallMode = "all",
    readOnly = false,
    snapshotLessons: readonly StoredLesson[] | null = null,
  ) {
    this.path = path;
    this.mode = mode;
    this.readOnly = readOnly;
    this.snapshotLessons = snapshotLessons === null ? null : freezeSnapshotLessons(snapshotLessons);
  }

  get featureScope(): MemoryReaderFeatureScope {
    return this.mode === "all" ? "global" : "feature";
  }

  asFeatureScopedReader(): MemoryReader {
    if (this.mode === "all") {
      const reader = this.snapshotId !== null && this.snapshotLessons !== null
        ? createTrustedFrozenProjection(
            new FrozenMemory(this.snapshotId, "top", this.snapshotLessons),
            this.snapshotId,
          )
        : new FileMemory(this.path, "top", this.readOnly, this.snapshotLessons);
      if (this.snapshotId !== null && this.snapshotLessons === null) {
        (reader as FileMemory).snapshotId = this.snapshotId;
      }
      return reader;
    }
    return this;
  }

  asReadOnlyReader(): MemoryReader {
    const reader = this.snapshotId !== null && this.snapshotLessons !== null
      ? createTrustedFrozenProjection(
          new FrozenMemory(this.snapshotId, this.mode, this.snapshotLessons),
          this.snapshotId,
        )
      : new FileMemory(this.path, this.mode, true, this.snapshotLessons);
    if (this.snapshotId !== null && this.snapshotLessons === null) {
      (reader as FileMemory).snapshotId = this.snapshotId;
    }
    return reader;
  }

  private async load(): Promise<StoredLesson[]> {
    if (this.snapshotId !== null) {
      if (this.snapshotLessons !== null) {
        return this.snapshotLessons.map((lesson) => ({ ...lesson, triggers: [...lesson.triggers] }));
      }
      return readValidatedSnapshot(this.snapshotId, this.path, "dynamic");
    }
    try {
      return parseLessons(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.snapshotId !== null) {
          throw new MemoryBindingError("memory_not_found", `memory snapshot ${this.snapshotId} does not exist`);
        }
        return [];
      }
      throw error;
    }
  }

  async recall(
    queryOrFeatures: string | string[],
    limit: number = RECALL_LIMIT,
    prompt: MemoryPrompt = sharedMemoryPrompt("retrieve"),
  ): Promise<Hint[]> {
    if (!isSharedMemoryPrompt(prompt, "retrieve")) throw new Error("FileMemory requires the shared retrieve prompt");
    if (this.mode === "off") return [];

    const features = normalizeRecallInput(queryOrFeatures);
    const lessons = await this.load();
    if (lessons.length === 0) return [];

    // Whole store, in a stable order. No query, no ranking, nothing to go wrong.
    if (this.mode === "all") {
      const every = lessons.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      await this.countHits(every.map((lesson) => lesson.id));
      return every.map(renderHint);
    }

    const query = tokenize(features);

    // NOT retrieval. With no observed features there is no query to rank against, so
    // this returns the most-applied lessons - the same set for every task, i.e. a
    // global prior. It is listed under `top` for continuity, but read it as "the
    // memory the agent always carries", not "the memory relevant to this image".
    // Real ranking needs a query, which needs something to have looked at the frame
    // first - see the two-step mode.
    if (query.size === 0) {
      const prior = lessons
        .slice()
        .sort((a, b) => b.hits - a.hits || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
      await this.countHits(prior.map((lesson) => lesson.id));
      return prior.map(renderHint);
    }

    const ranked = lessons
      .map((lesson) => {
        const triggers = tokenize(lesson.triggers);
        let overlap = 0;
        for (const token of triggers) if (query.has(token)) overlap++;
        return { lesson, overlap };
      })
      .filter((entry) => entry.overlap > 0)
      // Ties break on id so the order never depends on file order or Map iteration.
      .sort((a, b) => b.overlap - a.overlap || (a.lesson.id < b.lesson.id ? -1 : 1))
      .slice(0, limit);

    if (ranked.length > 0) {
      await this.countHits(ranked.map((entry) => entry.lesson.id));
    }
    return ranked.map(({ lesson }) => renderHint(lesson));
  }

  async remember(
    input: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt = sharedMemoryPrompt("store"),
  ): Promise<MemoryWriteResult> {
    if (!isSharedMemoryPrompt(prompt, "store")) throw new Error("FileMemory requires the shared store prompt");
    if (this.readOnly) {
      throw new MemoryWriteError(
        "write_failed",
        "FileMemory is read-only: evaluation and production must not write lessons",
      );
    }
    return this.withWriteLock(async () => {
      const existing = await this.load();
      if (input.idempotencyKey !== undefined) {
        const duplicate = existing.find((lesson) => lesson.idempotencyKey === input.idempotencyKey);
        if (duplicate !== undefined) {
          return { status: "already_stored", lessonId: duplicate.id };
        }
      }
      const lesson: StoredLesson = {
        id: `lesson-${String(existing.length + 1).padStart(4, "0")}`,
        content: input.content,
        sourceAttemptId: input.sourceAttemptId,
        ...(input.featureKey === undefined ? {} : { featureKey: input.featureKey }),
        ...(input.memoryHitId === undefined ? {} : { memoryHitId: input.memoryHitId }),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        triggers: input.triggers,
        region: input.region,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        hits: 0,
        wins: 0,
      };
      validateSnapshotLesson(lesson, existing.length, "legacy");
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(lesson)}\n`, "utf8");
      return { status: "stored", lessonId: lesson.id };
    });
  }

  /**
   * Exclusive-create lock with an owner token and heartbeat.
   *
   * An age check alone cannot distinguish a slow live writer from a crashed one,
   * so a live owner's lock is never removed just because it is old. Recovery is
   * limited to a lock whose recorded process is no longer alive, and the rename
   * makes reclaim atomic with respect to a new writer.
   */
  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = readLockOwner(await readFile(lockPath, "utf8"));
          if (owner !== null) await reclaimDeadLock(lockPath, owner);
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        }
        await delay(LOCK_WAIT_MS);
        continue;
      }

      const owner: LockOwner = { pid: process.pid, token: randomUUID() };
      let lockCreated = true;
      let ownsLock = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
        ACTIVE_LOCKS.set(lockPath, owner.token);
        ownsLock = true;
        heartbeat = setInterval(() => {
          void handle?.utimes(new Date(), new Date()).catch(() => undefined);
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return await operation();
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (ownsLock && ACTIVE_LOCKS.get(lockPath) === owner.token) ACTIVE_LOCKS.delete(lockPath);
        await handle.close();
        if (lockCreated) {
          try {
            await unlink(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        lockCreated = false;
      }
    }
  }

  /**
   * Bumps `hits` in place. Rewrites the file: it is small and stays diffable.
   *
   * Skipped entirely on a read-only store. A snapshot is addressed by the hash of
   * its own content, so incrementing a counter inside it would change the id of the
   * thing being measured, mid-measurement.
   */
  private async countHits(ids: readonly string[]): Promise<void> {
    if (this.readOnly) return;
    await this.withWriteLock(async () => {
      const bumped = new Set(ids);
      const lessons = (await this.load()).map((lesson) =>
        bumped.has(lesson.id) ? { ...lesson, hits: lesson.hits + 1 } : lesson,
      );
      await this.write(lessons);
    });
  }

  private async write(lessons: readonly StoredLesson[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    await writeFile(this.path, lessons.length > 0 ? `${body}\n` : "", "utf8");
  }

  /**
   * The snapshot id is the hash of the content, not a counter, so two runs that
   * produced identical memory are provably the same state.
   */
  async snapshot(mode: MemorySnapshotMode = "dynamic"): Promise<string> {
    const lessons = await this.load();
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
    try {
      validateSnapshotContent(id, body === "" ? "" : `${body}\n`, mode);
    } catch (error) {
      throw new MemoryBindingError("memory_mismatch", "cannot create a snapshot from invalid lessons", { cause: error });
    }
    await mkdir(currentMemoryDir(), { recursive: true });
    await writeFile(join(currentMemoryDir(), `${id}.jsonl`), body === "" ? "" : `${body}\n`, "utf8");
    return id;
  }

  async restore(id: string): Promise<void> {
    if (this.readOnly) {
      throw new Error("FileMemory is read-only: evaluation and production must not restore lessons");
    }
    const frozen = await readFile(join(currentMemoryDir(), `${id}.jsonl`), "utf8");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, frozen, "utf8");
  }

  async loadSnapshot(
    snapshotId: string,
    mode: MemorySnapshotMode = "dynamic",
  ): Promise<FrozenMemory> {
    const lessons = await loadValidatedSnapshotLessons(snapshotId, mode);
    return createTrustedFrozenMemory(snapshotId, this.mode, lessons);
  }

  async size(): Promise<number> {
    return (await this.load()).length;
  }
}

/** Reads a frozen snapshot without touching the working store. Used by eval runs. */
class FrozenMemory extends FileMemory {
  constructor(
    snapshotId: string,
    mode: RecallMode = "all",
    snapshotLessons: readonly StoredLesson[] = [],
  ) {
    super(join(currentMemoryDir(), `${snapshotId}.jsonl`), mode, true, snapshotLessons);
    this.snapshotId = snapshotId;
  }
  override async remember(
    _input?: LessonInput | LegacyLessonInput,
    _prompt?: MemoryPrompt,
  ): Promise<MemoryWriteResult> {
    throw new MemoryWriteError("write_failed", "FrozenMemory is read-only: evaluation must not write lessons");
  }

  override async snapshot(_mode?: MemorySnapshotMode): Promise<string> {
    throw new MemoryWriteError("write_failed", "FrozenMemory is read-only: evaluation must not write snapshots");
  }
}

function createTrustedFrozenMemory(
  snapshotId: string,
  mode: RecallMode,
  lessons: readonly StoredLesson[],
): FrozenMemory {
  const reader = new FrozenMemory(snapshotId, mode, lessons);
  markTrustedFrozenReader(reader, snapshotId);
  return reader;
}

function createTrustedFrozenProjection(backing: FrozenMemory, snapshotId: string): MemoryReader {
  const promptPort: MemoryAdapterPromptPort = {
    retrieve: (request) => {
      if (request.query === undefined) throw new Error("memory retrieve query is required");
      return backing.recall(request.query, request.limit ?? RECALL_LIMIT, request.prompt);
    },
    store: async () => {
      throw new MemoryWriteError("write_failed", "frozen memory cannot store lessons");
    },
  };
  const reader: MemoryReader = {
    featureScope: backing.featureScope,
    promptMetadata: cloneFrozenPromptMetadata(backing.promptMetadata),
    recall: (query, limit, prompt) => backing.recall(query, limit, prompt),
    promptPort,
  };
  markTrustedFrozenReader(reader, snapshotId);
  return reader;
}

export function featureScopedFileMemoryReader(memory: FileMemory): MemoryReader {
  return memory.asFeatureScopedReader();
}
