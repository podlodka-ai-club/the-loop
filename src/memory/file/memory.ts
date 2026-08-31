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
import {
  isSharedMemoryPrompt,
  MemoryBindingError,
  MemoryWriteError,
  markFrozenMemoryReader,
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
} from "../memory.ts";

export const MEMORY_DIR = process.env.MEMORY_DIR ?? join("data", "memory");
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{12}$/;
const LOCK_WAIT_MS = 5;
const LOCK_HEARTBEAT_MS = 5_000;

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

function parseLessons(text: string): StoredLesson[] {
  const lessons: StoredLesson[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lessons.push(JSON.parse(line) as StoredLesson);
  }
  return lessons;
}

/**
 * Ranking is deliberately the dumbest thing that can work: overlap between the
 * query's tokens and the lesson's trigger tokens. It is a placeholder for a real
 * retriever, and it is a *useful* placeholder only because it is deterministic -
 * comparing memory-on against memory-off requires that the same features pull the
 * same lessons every time.
 */
export class FileMemory implements Memory, LegacyMemory {
  readonly promptMetadata = sharedMemoryPromptMetadata();
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

  constructor(path = join(MEMORY_DIR, "live.jsonl"), mode: RecallMode = "all", readOnly = false) {
    this.path = path;
    this.mode = mode;
    this.readOnly = readOnly;
  }

  get featureScope(): MemoryReaderFeatureScope {
    return this.mode === "all" ? "global" : "feature";
  }

  asFeatureScopedReader(): MemoryReader {
    if (this.mode === "all") return new FileMemory(this.path, "top", this.readOnly);
    return this;
  }

  asReadOnlyReader(): MemoryReader {
    return new FileMemory(this.path, this.mode, true);
  }

  private async load(): Promise<StoredLesson[]> {
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
  async snapshot(): Promise<string> {
    const lessons = await this.load();
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
    await mkdir(MEMORY_DIR, { recursive: true });
    await writeFile(join(MEMORY_DIR, `${id}.jsonl`), body === "" ? "" : `${body}\n`, "utf8");
    return id;
  }

  async restore(id: string): Promise<void> {
    if (this.readOnly) {
      throw new Error("FileMemory is read-only: evaluation and production must not restore lessons");
    }
    const frozen = await readFile(join(MEMORY_DIR, `${id}.jsonl`), "utf8");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, frozen, "utf8");
  }

  async loadSnapshot(snapshotId: string): Promise<MemoryReader> {
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new MemoryBindingError("memory_not_found", `invalid memory snapshot id ${snapshotId}`);
    }
    const snapshotPath = join(MEMORY_DIR, `${snapshotId}.jsonl`);
    try {
      parseLessons(await readFile(snapshotPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MemoryBindingError("memory_not_found", `memory snapshot ${snapshotId} does not exist`, { cause: error });
      }
      throw new MemoryBindingError("unavailable", `memory snapshot ${snapshotId} is unavailable`, { cause: error });
    }
    return new FrozenMemory(snapshotId, this.mode === "all" ? "top" : this.mode);
  }

  async size(): Promise<number> {
    return (await this.load()).length;
  }
}

/** Reads a frozen snapshot without touching the working store. Used by eval runs. */
export class FrozenMemory extends FileMemory {
  constructor(snapshotId: string, mode: RecallMode = "all") {
    super(join(MEMORY_DIR, `${snapshotId}.jsonl`), mode, true);
    this.snapshotId = snapshotId;
    markFrozenMemoryReader(this, snapshotId);
  }
  override async remember(
    _input?: LessonInput | LegacyLessonInput,
    _prompt?: MemoryPrompt,
  ): Promise<MemoryWriteResult> {
    throw new MemoryWriteError("write_failed", "FrozenMemory is read-only: evaluation must not write lessons");
  }
}

export function featureScopedFileMemoryReader(memory: FileMemory): MemoryReader {
  return memory.asFeatureScopedReader();
}
