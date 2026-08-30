/**
 * Memory: lessons the agent wrote about its own past attempts, and the retrieval
 * that puts them back in front of it.
 *
 * The contract is intentionally independent of how lessons are stored. A backend
 * may use a local file, a hosted memory service, or another implementation without
 * changing the task and workflow code that consumes it.
 */
import type { FeatureKey } from "../observe.ts";

/** Default number of lessons a single recall may put into the prompt. */
export const RECALL_LIMIT = Number(process.env.MEMORY_RECALL_LIMIT ?? 5);

export type ReflectionEffect =
  | "helped"
  | "irrelevant"
  | "misleading"
  | "insufficient";

export type MemoryWriteResult = {
  status: "stored" | "already_stored";
  lessonId: string;
};

export type MemoryWriteErrorCode = "write_failed" | "write_outcome_unknown";

export class MemoryWriteError extends Error {
  readonly code: MemoryWriteErrorCode;

  constructor(code: MemoryWriteErrorCode, message = code) {
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
  const hint: Hint = {
    lessonId: lesson.id,
    text: region === "" ? lesson.content : `${region}: ${lesson.content}`,
  };
  if (lesson.featureKey !== undefined) hint.featureKey = lesson.featureKey;
  if (lesson.effect !== undefined) hint.effect = lesson.effect;
  return hint;
}

export interface MemoryReader {
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
  /** Feature-scoped dispatcher path: one query for one active feature. */
  recall(query: string, limit: number): Promise<Hint[]>;
}

export function bindFeatureScopedReader(reader: MemoryReader): MemoryReader {
  if (reader.featureScope !== "global") return reader;
  return reader.asFeatureScopedReader?.() ?? reader;
}

export interface MemoryWriter extends MemoryReader {
  remember(lesson: LessonInput): Promise<MemoryWriteResult>;
  /** Freezes the current store to its own file and returns that file's id. */
  snapshot(): Promise<string>;
  /** Replaces the working store with a frozen one. */
  restore(id: string): Promise<void>;
}

export type MemoryBinding =
  | { mode: "training"; reader: MemoryReader; writer: MemoryWriter; snapshotId: null; readOnly: false }
  | { mode: "evaluation"; reader: MemoryReader; writer?: never; snapshotId: string; readOnly: true }
  | { mode: "production"; reader: MemoryReader; writer?: never; snapshotId: string | null; readOnly: true };

export type Memory = MemoryWriter;

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
  readonly lessons: Lesson[] = [];
  #byIdempotencyKey = new Map<string, string>();

  async recall(queryOrFeatures: string | string[], limit = RECALL_LIMIT): Promise<Hint[]> {
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

  async remember(input: LessonInput): Promise<MemoryWriteResult> {
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
  mode: "training" | "evaluation" | "production";
  snapshotId: string | null;
  readOnly: boolean;
  recallLimit: 1 | 2 | 3 | 4 | 5;
}): Promise<MemoryBinding> {
  if (config.mode !== "training" && config.mode !== "evaluation" && config.mode !== "production") {
    throw new Error("unknown memory mode");
  }
  if (!Number.isInteger(config.recallLimit) || config.recallLimit < 1 || config.recallLimit > 5) {
    throw new Error("recallLimit must be an integer from 1 to 5");
  }
  if (config.mode === "evaluation") {
    if (typeof config.snapshotId !== "string" || config.snapshotId.trim() === "" || config.readOnly !== true) {
      throw new Error("evaluation memory requires a non-empty snapshotId and readOnly=true");
    }
    return {
      mode: "evaluation",
      reader: new InMemoryMemory(),
      snapshotId: config.snapshotId,
      readOnly: true,
    };
  }
  if (config.mode === "production") {
    if (config.readOnly !== true) throw new Error("production memory requires readOnly=true");
    return {
      mode: "production",
      reader: new InMemoryMemory(),
      snapshotId: config.snapshotId,
      readOnly: true,
    };
  }
  if (config.readOnly !== false || config.snapshotId !== null) {
    throw new Error("training memory requires snapshotId=null and readOnly=false");
  }
  const memory = new InMemoryMemory();
  return {
    mode: "training",
    reader: memory,
    writer: memory,
    snapshotId: null,
    readOnly: false,
  };
}
