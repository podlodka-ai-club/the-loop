/**
 * The experiment task: run the agent on one dataset example and never throw.
 *
 * A throwing task loses the row, which silently shrinks the denominator. Returning a
 * structured failure keeps the item in the run so the failure rate stays honest.
 */
import { UnparseableOutputError, geolocate } from "./agent.ts";
import type { Guess } from "./agent.ts";
import { buildAttemptMetrics } from "./benchmark-metrics.ts";
import type { RetrievalFixtureCase } from "./benchmark-metrics.ts";
import type { LocateDeps } from "./locate.ts";
import { NullMemory } from "./memory/null/memory.ts";
import { observe } from "./observe.ts";
import type { FeatureObservation } from "./observe.ts";
import { RECALL_LIMIT, parseRecallLimit } from "./memory/memory.ts";
import type {
  Hint,
  LegacyMemory,
  MemoryBinding,
  MemoryReader,
  MemorySourceResolver,
} from "./memory/memory.ts";
import { runFeatureScopedTask } from "./task-feature-scoped.internal.ts";
import type { SampleRetryPolicy } from "./retry-policy.ts";
import { RETRY_DELAYS_MS } from "./retry-policy.ts";
import type {
  AttemptTrace,
  AttemptMetrics,
  EpisodeTrace,
  FeatureMemoryGroup,
  MemoryRunConfig,
} from "./tools/memory.ts";

export type FailureKind =
  | "unparseable"
  | "api_error"
  | "missing_image"
  | "memory_not_found"
  | "memory_mismatch"
  | "unavailable"
  | "timeout";

/**
 * Every result carries what memory put into the prompt: how many lessons, which ones
 * by id, and roughly what they cost in tokens. Without those three, a better number
 * is just a better number - there is nothing tying it to the lessons.
 */
export type MemoryUse = {
  observations: FeatureObservation[];
  memoryGroups: FeatureMemoryGroup[];
  episodes: EpisodeTrace[];
  trace: AttemptTrace | null;
  hints: Hint[];
  hintCount: number;
  hintIds: string[];
  hintTokens: number;
  attemptMetrics: AttemptMetrics;
  /** The query recall was given. Empty means the search ran blind. */
  features: string[];
};

export type TaskResult =
  | ({ ok: true; guess: Guess } & MemoryUse)
  | ({ ok: false; failure: FailureKind; message: string } & MemoryUse);

export type ExampleInput = {
  imageId: string;
  imagePath: string;
  attemptId?: string;
  truth?: { latitude: number; longitude: number; country: string };
  /**
   * Observed features to rank lessons against, when something has already looked at
   * the image. The single-call agent has none, and recall falls back to a global
   * prior - see `FileMemory.recall`.
   */
  features?: string[];
};

export type BenchmarkTaskMetricsConfig = {
  retrievalFixture: readonly RetrievalFixtureCase[];
  legacyGlobalProviderIds?: readonly string[];
};

/**
 * What a task may do with memory. Evaluation passes a store and no learner, so it
 * reads lessons and never writes one. Training passes both.
 */
export type FeatureScopedTaskDeps = {
  /**
   * New feature-scoped path. When present, runTask delegates observe/retrieve/analyze
   * to locate and keeps flattened hints only as a telemetry projection.
   */
  run: MemoryRunConfig;
  /** The single resolved source of reader, writer, prompt port and snapshot policy. */
  memoryBinding?: MemoryBinding;
  memory?: MemoryReader;
  memorySourceResolver?: MemorySourceResolver;
  locateDeps?: Partial<Pick<LocateDeps, "maxToolAttemptsPerFeature">>;
  benchmark?: BenchmarkTaskMetricsConfig;
  sampleRetryPolicy?: SampleRetryPolicy;
  recallLimit?: never;
  twoStep?: never;
  learn?: never;
};

export type LegacyTaskDeps = {
  memory?: LegacyMemory;
  recallLimit?: number;
  benchmark?: BenchmarkTaskMetricsConfig;
  /**
   * Look at the image first and use what it sees as the recall query.
   *
   * Off by default: it costs a second vision call per item, and a run with no
   * memory has nothing to search for. On, it is the only way ranking gets an input
   * at all - and the only way a query-based backend can work.
   */
  twoStep?: boolean;
  run?: undefined;
  locateDeps?: never;
  /**
   * Called after a successful guess, with the hints that were in the prompt. This is
   * where training turns an outcome into a lesson; it is absent during evaluation.
   */
  learn?: (guess: Guess, input: ExampleInput, hints: Hint[]) => Promise<void>;
};

export type TaskDeps = FeatureScopedTaskDeps | LegacyTaskDeps;

/**
 * Novita rate-limits per minute, and a sequential 200-image run still trips it: half
 * the first OpenRouter baseline came back `429 Provider returned error`. Retrying is
 * not optional here - `allow_fallbacks: false` means a 429 cannot be answered by
 * routing elsewhere, which is the trade we accepted to keep the quantization pinned.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit");
}

async function geolocateWithBackoff(imagePath: string, hints: readonly Hint[]): Promise<Guess> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await geolocate(imagePath, hints);
    } catch (error) {
      lastError = error;
      // Only a rate limit is worth waiting out. A malformed response or a missing
      // file will fail again identically, and retrying it just burns the clock.
      if (!isRateLimit(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt] ?? 60_000);
    }
  }
  throw lastError;
}

/** Rough token cost of the hints, at the usual ~4 characters per token. */
export function estimateHintTokens(hints: readonly Hint[]): number {
  return Math.ceil(hints.reduce((sum, hint) => sum + hint.text.length, 0) / 4);
}

export async function runTask(input: ExampleInput, deps: TaskDeps = {}): Promise<TaskResult> {
  const startedAt = Date.now();
  if (deps.run !== undefined) {
    const featureScopedDeps: FeatureScopedTaskDeps = { run: deps.run };
    if (deps.memoryBinding !== undefined) featureScopedDeps.memoryBinding = deps.memoryBinding;
    if (deps.memory !== undefined) featureScopedDeps.memory = deps.memory;
    if (deps.memorySourceResolver !== undefined) featureScopedDeps.memorySourceResolver = deps.memorySourceResolver;
    if (deps.locateDeps !== undefined) featureScopedDeps.locateDeps = deps.locateDeps;
    if (deps.benchmark !== undefined) featureScopedDeps.benchmark = deps.benchmark;
    if (deps.sampleRetryPolicy !== undefined) featureScopedDeps.sampleRetryPolicy = deps.sampleRetryPolicy;
    return runFeatureScopedTask(input, featureScopedDeps);
  }

  const memory = deps.memory ?? new NullMemory();
  if (!isLegacyMemory(memory)) {
    throw new Error("legacy runTask path requires LegacyMemory; pass deps.run for feature-scoped MemoryReader");
  }

  // Observation runs before recall because recall needs a query. Its output is used
  // for search only: the solver below still receives the image, so anything this
  // step misses is not lost to the answer.
  const recallLimit =
    deps.recallLimit === undefined ? RECALL_LIMIT : parseRecallLimit(deps.recallLimit, "recallLimit");
  const features =
    input.features ??
    (deps.twoStep === true
      ? (await observe(input.imagePath)).features
          .filter((item) => item.text.trim() !== "")
          .map((item) => item.text)
      : []);

  const hints = await memory.recall(features, recallLimit);
  const use: MemoryUse = {
    observations: [],
    memoryGroups: [],
    episodes: [],
    trace: null,
    hints: [...hints],
    hintCount: hints.length,
    hintIds: hints.map((hint) => hint.lessonId),
    hintTokens: estimateHintTokens(hints),
    attemptMetrics: buildAttemptMetrics({
      attemptId: input.attemptId ?? input.imageId,
      observations: [],
      memoryGroups: [],
      episodes: [],
      validOutput: false,
      latencyMs: Date.now() - startedAt,
      truth: input.truth,
      fixture: deps.benchmark?.retrievalFixture,
      legacyGlobalProviderIds: deps.benchmark?.legacyGlobalProviderIds ?? hints.map((hint) => hint.lessonId),
    }),
    features,
  };
  try {
    const guess = await geolocateWithBackoff(input.imagePath, hints);
    if (deps.learn) await deps.learn(guess, input, hints);
    return {
      ok: true,
      guess,
      ...use,
      attemptMetrics: buildAttemptMetrics({
        attemptId: input.attemptId ?? input.imageId,
        observations: [],
        memoryGroups: [],
        episodes: [],
        validOutput: true,
        latencyMs: Date.now() - startedAt,
        guess,
        truth: input.truth,
        fixture: deps.benchmark?.retrievalFixture,
        legacyGlobalProviderIds: deps.benchmark?.legacyGlobalProviderIds ?? hints.map((hint) => hint.lessonId),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedUse = {
      ...use,
      attemptMetrics: {
        ...use.attemptMetrics,
        latencyMs: Date.now() - startedAt,
      },
    };
    if (error instanceof UnparseableOutputError) {
      return { ok: false, failure: "unparseable", message, ...failedUse };
    }
    if (message.includes("ENOENT")) {
      return { ok: false, failure: "missing_image", message, ...failedUse };
    }
    return { ok: false, failure: "api_error", message, ...failedUse };
  }
}

function isLegacyMemory(value: unknown): value is LegacyMemory {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.recall === "function" &&
    typeof candidate.remember === "function" &&
    typeof candidate.snapshot === "function" &&
    typeof candidate.restore === "function"
  );
}
