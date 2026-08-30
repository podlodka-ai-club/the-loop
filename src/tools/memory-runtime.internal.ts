import type { Hint, MemoryReader } from "../memory/memory.ts";
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
  };
}

function finiteFloor(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

function capReader(reader: MemoryReader, remainingHits: number | undefined): MemoryReader {
  if (remainingHits === undefined) return reader;
  return {
    featureScope: reader.featureScope,
    asFeatureScopedReader: reader.asFeatureScopedReader?.bind(reader),
    recall: async (query: string, limit: number): Promise<Hint[]> => {
      const hints = await reader.recall(query, limit);
      return hints.slice(0, remainingHits);
    },
  };
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

  return executeMemoryRetrieve(
    {
      ...context,
      reader: capReader(context.reader, memoryHitsRemaining),
    },
    args,
  );
}
