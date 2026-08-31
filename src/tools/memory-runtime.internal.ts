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
    retryCount: 0,
  };
}

function finiteFloor(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

function capReader(reader: MemoryReader, remainingHits: number | undefined): MemoryReader {
  if (remainingHits === undefined) return reader;
  const basePromptPort = reader.promptPort;
  const capped: MemoryReader = {
    featureScope: reader.featureScope,
    promptMetadata: reader.promptMetadata,
    recall: async (query: string, limit: number, prompt): Promise<Hint[]> => {
      const hints = await reader.recall(query, limit, prompt);
      return hints.slice(0, remainingHits);
    },
  };
  capped.promptPort = {
    retrieve: async (request) => {
      if (request.query === undefined) throw new Error("memory retrieve query is required");
      const hints = basePromptPort === undefined
        ? await capped.recall(request.query, request.limit ?? 5, request.prompt)
        : await basePromptPort.retrieve(request);
      return hints.slice(0, remainingHits);
    },
    store: async () => {
      throw new Error("capped retrieve reader cannot store lessons");
    },
  };
  return capped;
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

  const reader = capReader(context.reader, memoryHitsRemaining);
  const group = await executeMemoryRetrieve({
    ...context,
    reader,
    ...(reader.promptPort === undefined ? {} : { promptPort: reader.promptPort }),
  }, args);
  if (memoryHitsRemaining === undefined || group.hits.length <= memoryHitsRemaining) return group;
  const hits = group.hits.slice(0, memoryHitsRemaining);
  return { ...group, hits, status: hits.length === 0 ? "no_hit" : "hits" };
}
