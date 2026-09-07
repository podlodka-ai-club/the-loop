import type { LocateResult } from "./tools/memory.ts";
import type { EpisodeCandidate } from "./tools/episode-ledger.internal.ts";

export type LocatePartialResult = Omit<LocateResult, "guess">;
export type LocatePartialState = LocatePartialResult & {
  readonly episodeCandidates: readonly EpisodeCandidate[];
};

const partialResults = new WeakMap<object, LocatePartialState>();

export function attachLocatePartialResult(error: unknown, result: LocatePartialState): void {
  if (typeof error !== "object" || error === null) return;
  partialResults.set(error, result);
}

export function readLocatePartialResult(error: unknown): LocatePartialResult | null {
  if (typeof error !== "object" || error === null) return null;
  const state = partialResults.get(error);
  if (state === undefined) return null;
  return {
    attemptId: state.attemptId,
    observations: state.observations,
    memoryGroups: state.memoryGroups,
    episodes: state.episodes,
    trace: state.trace,
  };
}
