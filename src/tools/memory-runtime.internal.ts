import {
  executeMemoryRetrieve,
  validateMemoryRunConfig,
  type FeatureMemoryGroup,
  type MemoryToolContext,
  type RetrievalFailure,
} from "./memory.ts";

export type MemoryRetrieveRuntimeBudget = {
  retrievalCallsRemaining?: number;
  memoryHitsRemaining?: number;
};

export type MemoryRetrieveRuntimeContext = MemoryToolContext & {
  budget?: MemoryRetrieveRuntimeBudget;
};

function failedGroup(
  context: MemoryToolContext,
  failure: RetrievalFailure,
): FeatureMemoryGroup {
  return {
    attemptId: context.attemptId,
    feature: context.activeFeature,
    query: null,
    status: "failed",
    hits: [],
    failure,
    retryCount: 0,
  };
}

function finiteFloor(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

export async function executeMemoryRetrieveWithRuntimeBudget(
  context: MemoryRetrieveRuntimeContext,
  args: unknown,
): Promise<FeatureMemoryGroup> {
  validateMemoryRunConfig(context.run);

  const retrievalCallsRemaining = finiteFloor(context.budget?.retrievalCallsRemaining);
  if (retrievalCallsRemaining !== undefined && retrievalCallsRemaining <= 0) {
    return failedGroup(context, "budget_exhausted");
  }

  const memoryHitsRemaining = finiteFloor(context.budget?.memoryHitsRemaining);
  if (memoryHitsRemaining !== undefined && memoryHitsRemaining <= 0) {
    return failedGroup(context, "budget_exhausted");
  }

  const recallLimit = memoryHitsRemaining === undefined
    ? context.run.recallLimit
    : Math.min(context.run.recallLimit, memoryHitsRemaining) as 1 | 2 | 3 | 4 | 5;
  const group = await executeMemoryRetrieve({
    ...context,
    run: { ...context.run, recallLimit },
  }, args);
  if (memoryHitsRemaining === undefined || group.hits.length <= memoryHitsRemaining) return group;
  const hits = group.hits.slice(0, memoryHitsRemaining);
  return { ...group, hits, status: hits.length === 0 ? "no_hit" : "hits" };
}
