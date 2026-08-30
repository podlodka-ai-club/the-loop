import { UnparseableOutputError } from "./agent.ts";
import type { Guess } from "./agent.ts";
import { locate } from "./locate.ts";
import type { LocateDeps } from "./locate.ts";
import { readLocatePartialResult } from "./locate-partial.internal.ts";
import { NullMemory } from "./memory/null/memory.ts";
import type { Hint } from "./memory/memory.ts";
import type {
  ExampleInput,
  FeatureScopedTaskDeps,
  MemoryUse,
  TaskResult,
} from "./task.ts";
import type {
  FeatureMemoryGroup,
  LocateResult,
} from "./tools/memory.ts";

export type LocateFunction = (
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
) => Promise<LocateResult>;

export type FeatureScopedTaskRuntimeDeps = FeatureScopedTaskDeps & {
  locate?: LocateFunction;
};

function estimateHintTokens(hints: readonly Hint[]): number {
  return Math.ceil(hints.reduce((sum, hint) => sum + hint.text.length, 0) / 4);
}

function emptyMemoryUse(): MemoryUse {
  return {
    observations: [],
    memoryGroups: [],
    episodes: [],
    trace: null,
    hints: [],
    hintCount: 0,
    hintIds: [],
    hintTokens: 0,
    features: [],
  };
}

function projectLegacyHints(groups: readonly FeatureMemoryGroup[]): Hint[] {
  return groups.flatMap((group) =>
    group.hits.map((hit) => {
      const hint: Hint = {
        lessonId: hit.providerId ?? hit.memoryHitId,
        text: hit.text,
        featureKey: hit.featureKey,
      };
      if (hit.effect !== null) hint.effect = hit.effect;
      return hint;
    }),
  );
}

function memoryUseFromLocate(
  result: Pick<LocateResult, "observations" | "memoryGroups" | "episodes" | "trace">,
): MemoryUse {
  const hints = projectLegacyHints(result.memoryGroups);
  return {
    observations: result.observations,
    memoryGroups: result.memoryGroups,
    episodes: result.episodes,
    trace: result.trace,
    hints,
    hintCount: hints.length,
    hintIds: hints.map((hint) => hint.lessonId),
    hintTokens: estimateHintTokens(hints),
    features: result.observations
      .filter((item) => item.state === "visible")
      .map((item) => item.text)
      .filter((text) => text.trim() !== ""),
  };
}

export async function runFeatureScopedTask(
  input: ExampleInput,
  deps: FeatureScopedTaskRuntimeDeps,
): Promise<TaskResult> {
  try {
    const result = await (deps.locate ?? locate)(
      { attemptId: input.attemptId ?? input.imageId, imagePath: input.imagePath },
      {
        ...deps.locateDeps,
        memory: deps.memory ?? new NullMemory(),
        run: deps.run,
      },
    );
    const use = memoryUseFromLocate(result);
    return { ok: true, guess: result.guess as Guess, ...use };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const partial = readLocatePartialResult(error);
    const use = partial === null ? emptyMemoryUse() : memoryUseFromLocate(partial);
    if (error instanceof UnparseableOutputError) {
      return { ok: false, failure: "unparseable", message, ...use };
    }
    if (message.includes("ENOENT")) {
      return { ok: false, failure: "missing_image", message, ...use };
    }
    return { ok: false, failure: "api_error", message, ...use };
  }
}
