import { UnparseableOutputError } from "./agent.ts";
import type { Guess } from "./agent.ts";
import { haversineKm } from "./geo.ts";
import { locate } from "./locate.ts";
import type { LocateDeps } from "./locate.ts";
import { readLocatePartialResult } from "./locate-partial.internal.ts";
import { NullMemory } from "./memory/null/memory.ts";
import type { Hint, MemoryWriter } from "./memory/memory.ts";
import { reflectEpisode } from "./reflect.ts";
import type {
  ReflectionEpisodeInput,
  ReflectionEpisodeResult,
} from "./reflect.ts";
import type {
  ExampleInput,
  FeatureScopedTaskDeps,
  MemoryUse,
  TaskResult,
} from "./task.ts";
import type {
  FeatureMemoryGroup,
  LocateResult,
  MemoryHit,
  ToolEvent,
} from "./tools/memory.ts";
import { episodeCandidatesFromGroups } from "./tools/episode-ledger.internal.ts";

export type LocateFunction = (
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
) => Promise<LocateResult>;

export type FeatureScopedTaskRuntimeInput = ExampleInput & {
  truth?: { latitude: number; longitude: number; country: string };
};

export type ReflectEpisodeFunction = (
  input: ReflectionEpisodeInput,
  deps: { writer: MemoryWriter; run: FeatureScopedTaskDeps["run"] },
) => Promise<ReflectionEpisodeResult>;

export type FeatureScopedTaskRuntimeDeps = FeatureScopedTaskDeps & {
  locate?: LocateFunction;
  writer?: MemoryWriter;
  reflectEpisode?: ReflectEpisodeFunction;
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

function shouldReflect(
  input: FeatureScopedTaskRuntimeInput,
  deps: FeatureScopedTaskRuntimeDeps,
): input is FeatureScopedTaskRuntimeInput & {
  truth: { latitude: number; longitude: number; country: string };
} {
  return (
    deps.run.mode === "training" &&
    deps.run.readOnly === false &&
    deps.writer !== undefined &&
    input.truth !== undefined
  );
}

function reflectionEvent(
  attemptId: string,
  hit: MemoryHit,
  result: ReflectionEpisodeResult,
  sequence: number,
): ToolEvent {
  return {
    attemptId,
    phase: "reflect",
    operation: "memory_store",
    featureKey: hit.featureKey,
    memoryHitId: hit.memoryHitId,
    status: result.status === "reflection_failed" ? result.failure : result.status,
    sequence,
  };
}

async function reflectEpisodesAfterReveal(
  input: FeatureScopedTaskRuntimeInput & {
    truth: { latitude: number; longitude: number; country: string };
  },
  result: LocateResult,
  deps: FeatureScopedTaskRuntimeDeps & { writer: MemoryWriter },
): Promise<void> {
  const reflect = deps.reflectEpisode ?? reflectEpisode;
  let sequence = result.trace.events.length;
  const candidates = new Set(
    episodeCandidatesFromGroups(result.attemptId, result.memoryGroups).map(
      (candidate) => `${candidate.featureKey}\0${candidate.memoryHitId}`,
    ),
  );
  const distanceKm = haversineKm(result.guess, {
    latitude: input.truth.latitude,
    longitude: input.truth.longitude,
  });
  for (const group of result.memoryGroups) {
    if (group.status !== "hits") continue;
    for (const hit of group.hits) {
      if (!candidates.has(`${hit.featureKey}\0${hit.memoryHitId}`)) continue;
      const reflection = await reflect(
        {
          attemptId: result.attemptId,
          imagePath: input.imagePath,
          feature: group.feature,
          memoryHit: hit,
          guess: {
            latitude: result.guess.latitude,
            longitude: result.guess.longitude,
            place: result.guess.place,
            reasoning: result.guess.reasoning,
          },
          truth: input.truth,
          distanceKm,
        },
        { writer: deps.writer, run: deps.run },
      ).catch((): ReflectionEpisodeResult => ({
        status: "reflection_failed",
        effect: null,
        lessonId: null,
        failure: "invalid_tool_arguments",
      }));
      result.episodes.push({
        attemptId: result.attemptId,
        featureKey: hit.featureKey,
        memoryHitId: hit.memoryHitId,
        effect: reflection.effect,
        reflectionStatus: reflection.status,
        lessonId: reflection.lessonId,
      });
      sequence += 1;
      result.trace.events.push(reflectionEvent(result.attemptId, hit, reflection, sequence));
    }
  }
}

export async function runFeatureScopedTask(
  input: FeatureScopedTaskRuntimeInput,
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
    if (shouldReflect(input, deps)) {
      await reflectEpisodesAfterReveal(input, result, deps as FeatureScopedTaskRuntimeDeps & { writer: MemoryWriter });
    }
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
