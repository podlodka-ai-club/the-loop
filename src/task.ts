/**
 * The experiment task: run the agent on one dataset example and never throw.
 *
 * A throwing task loses the row, which silently shrinks the denominator. Returning a
 * structured failure keeps the item in the run so the failure rate stays honest.
 */
import { UnparseableOutputError, geolocate } from "./agent.ts";
import type { Guess } from "./agent.ts";
import { NullMemory } from "./memory/null/memory.ts";
import { observe } from "./observe.ts";
import { RECALL_LIMIT } from "./memory/memory.ts";
import type { Hint, LegacyMemory } from "./memory/memory.ts";

export type FailureKind = "unparseable" | "api_error" | "missing_image";

/**
 * Every result carries what memory put into the prompt: how many lessons, which ones
 * by id, and roughly what they cost in tokens. Without those three, a better number
 * is just a better number - there is nothing tying it to the lessons.
 */
export type MemoryUse = {
  hints: Hint[];
  hintCount: number;
  hintIds: string[];
  hintTokens: number;
  /** The query recall was given. Empty means the search ran blind. */
  features: string[];
};

export type TaskResult =
  | ({ ok: true; guess: Guess } & MemoryUse)
  | ({ ok: false; failure: FailureKind; message: string } & MemoryUse);

export type ExampleInput = {
  imageId: string;
  imagePath: string;
  /**
   * Observed features to rank lessons against, when something has already looked at
   * the image. The single-call agent has none, and recall falls back to a global
   * prior - see `FileMemory.recall`.
   */
  features?: string[];
};

/**
 * What a task may do with memory. Evaluation passes a store and no learner, so it
 * reads lessons and never writes one. Training passes both.
 */
export type TaskDeps = {
  memory?: LegacyMemory;
  recallLimit?: number;
  /**
   * Look at the image first and use what it sees as the recall query.
   *
   * Off by default: it costs a second vision call per item, and a run with no
   * memory has nothing to search for. On, it is the only way ranking gets an input
   * at all - and the only way a query-based backend can work.
   */
  twoStep?: boolean;
  /**
   * Called after a successful guess, with the hints that were in the prompt. This is
   * where training turns an outcome into a lesson; it is absent during evaluation.
   */
  learn?: (guess: Guess, input: ExampleInput, hints: Hint[]) => Promise<void>;
};

/**
 * Novita rate-limits per minute, and a sequential 200-image run still trips it: half
 * the first OpenRouter baseline came back `429 Provider returned error`. Retrying is
 * not optional here - `allow_fallbacks: false` means a 429 cannot be answered by
 * routing elsewhere, which is the trade we accepted to keep the quantization pinned.
 */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

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
  const memory = deps.memory ?? new NullMemory();

  // Observation runs before recall because recall needs a query. Its output is used
  // for search only: the solver below still receives the image, so anything this
  // step misses is not lost to the answer.
  const features =
    input.features ??
    (deps.twoStep === true
      ? (await observe(input.imagePath)).features
          .filter((item) => item.state === "visible" && item.text.trim() !== "")
          .map((item) => item.text)
      : []);

  const hints = await memory.recall(features, deps.recallLimit ?? RECALL_LIMIT);
  const use: MemoryUse = {
    hints: [...hints],
    hintCount: hints.length,
    hintIds: hints.map((hint) => hint.lessonId),
    hintTokens: estimateHintTokens(hints),
    features,
  };
  try {
    const guess = await geolocateWithBackoff(input.imagePath, hints);
    if (deps.learn) await deps.learn(guess, input, hints);
    return { ok: true, guess, ...use };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnparseableOutputError) {
      return { ok: false, failure: "unparseable", message, ...use };
    }
    if (message.includes("ENOENT")) {
      return { ok: false, failure: "missing_image", message, ...use };
    }
    return { ok: false, failure: "api_error", message, ...use };
  }
}
