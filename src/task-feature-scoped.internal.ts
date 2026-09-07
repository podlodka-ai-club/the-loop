import { UnparseableOutputError } from "./agent.ts";
import type { Guess } from "./agent.ts";
import { buildAttemptMetrics } from "./benchmark-metrics.ts";
import type { RetrievalFixtureCase } from "./benchmark-metrics.ts";
import { haversineKm } from "./geo.ts";
import { locateWithRuntime, resolveBindingWithPolicy } from "./locate-runtime.internal.ts";
import type { LocateDeps } from "./locate.ts";
import { readLocatePartialResult } from "./locate-partial.internal.ts";
import {
  createMemorySourceBinding,
  createMemorySourceResolver,
  createFrozenMemorySnapshotBinding,
  MemoryBindingError,
  sharedMemoryPrompt,
  validateMemoryBinding,
  type MemoryBinding,
} from "./memory/memory.ts";
import type { Hint, MemoryWriter } from "./memory/memory.ts";
import { ReflectRuntimeError } from "./reflect-runtime.internal.ts";
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
  EpisodeTrace,
  LocateResult,
  MemoryHit,
  ToolEvent,
} from "./tools/memory.ts";
import { episodeCandidatesFromGroups } from "./tools/episode-ledger.internal.ts";
import { MAX_SAMPLE_ATTEMPTS, RETRY_DELAYS_MS, type SampleRetryPolicy } from "./retry-policy.ts";

export type LocateFunction = (
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
) => Promise<LocateResult>;

export type FeatureScopedTaskRuntimeInput = ExampleInput & {
  truth?: { latitude: number; longitude: number; country: string };
};

export type ReflectEpisodeFunction = (
  input: ReflectionEpisodeInput,
  deps: {
    memoryBinding: MemoryBinding;
    run: FeatureScopedTaskDeps["run"];
  },
) => Promise<ReflectionEpisodeResult>;

export type FeatureScopedTaskRuntimeDeps = FeatureScopedTaskDeps & {
  locate?: LocateFunction;
  writer?: MemoryWriter;
  reflectEpisode?: ReflectEpisodeFunction;
  sampleRetryPolicy?: SampleRetryPolicy;
};

export type FeatureScopedTrainingRunConfig = FeatureScopedTaskDeps["run"] & {
  mode: "training";
  snapshotId: null;
  readOnly: false;
};

export type FeatureScopedTrainingTaskRuntimeInput = FeatureScopedTaskRuntimeInput & {
  truth: { latitude: number; longitude: number; country: string };
};

export type FeatureScopedTrainingTaskRuntimeDeps = Omit<
  FeatureScopedTaskRuntimeDeps,
  "run" | "writer"
> & {
  run: FeatureScopedTrainingRunConfig;
  /** Writer is resolved from the unified memory binding. */
  writer?: never;
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
    attemptMetrics: buildAttemptMetrics({
      attemptId: "",
      observations: [],
      memoryGroups: [],
      episodes: [],
      validOutput: false,
      latencyMs: 0,
    }),
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
  options: {
    attemptId: string;
    validOutput: boolean;
    latencyMs: number;
    guess?: Guess;
    truth?: { latitude: number; longitude: number };
    legacyGlobalProviderIds?: readonly string[];
    fixture?: readonly RetrievalFixtureCase[];
  },
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
    attemptMetrics: buildAttemptMetrics({
      attemptId: options.attemptId,
      observations: result.observations,
      memoryGroups: result.memoryGroups,
      episodes: result.episodes,
      events: result.trace?.events,
      validOutput: options.validOutput,
      latencyMs: options.latencyMs,
      guess: options.guess,
      truth: options.truth,
      fixture: options.fixture,
      legacyGlobalProviderIds: options.legacyGlobalProviderIds,
    }),
    features: result.observations
      .map((item) => item.text)
      .filter((text) => text.trim() !== ""),
  };
}

function shouldReflect(
  input: FeatureScopedTaskRuntimeInput,
  run: FeatureScopedTaskDeps["run"],
  binding: MemoryBinding,
): input is FeatureScopedTaskRuntimeInput & {
  truth: { latitude: number; longitude: number; country: string };
} {
  return (
    run.mode === "training" &&
    run.memoryRef !== null &&
    run.readOnly === false &&
    binding.mode === "training" &&
    input.truth !== undefined
  );
}

async function resolveTaskBinding(deps: FeatureScopedTaskRuntimeDeps): Promise<MemoryBinding> {
  if (deps.memoryBinding !== undefined) {
    validateMemoryBinding(deps.memoryBinding, deps.run);
    if (
      deps.memory !== undefined ||
      deps.writer !== undefined ||
      deps.memorySourceResolver !== undefined
    ) {
      throw new MemoryBindingError(
        "memory_mismatch",
        "memoryBinding is the only memory source for the feature-scoped task",
      );
    }
    return deps.memoryBinding;
  }
  if (deps.memorySourceResolver !== undefined && (deps.memory !== undefined || deps.writer !== undefined)) {
    throw new MemoryBindingError(
      "memory_mismatch",
      "task accepts either memorySourceResolver or direct memory, not both",
    );
  }

  let resolver = deps.memorySourceResolver;
  if (resolver === undefined && deps.run.memoryRef !== null) {
    const memory = deps.memory ?? deps.writer;
    if (memory === undefined) {
      throw new MemoryBindingError("memory_not_found", `no memory binding for ${deps.run.memoryRef}`);
    }
    if (deps.memory !== undefined && deps.writer !== undefined && deps.memory !== deps.writer) {
      throw new MemoryBindingError("memory_mismatch", "task reader and writer are not one memory binding");
    }
    resolver = createMemorySourceResolver(createMemorySourceBinding({
      memoryRef: deps.run.memoryRef,
      memory,
      provider: null,
      ...(memory.loadSnapshot === undefined
        ? {}
        : {
            loadSnapshot: async (snapshotId: string) => createFrozenMemorySnapshotBinding({
              memoryRef: deps.run.memoryRef!,
              snapshotId,
              reader: await memory.loadSnapshot!(snapshotId),
            }),
          }),
    }));
  }
  if (resolver === undefined) {
    // resolveMemoryBinding handles the null-memory no-op without consulting a provider.
    resolver = {
      async resolve(): Promise<never> {
        throw new MemoryBindingError("memory_not_found", "memoryRef=null has no provider binding");
      },
    };
  }
  return resolveBindingWithPolicy(deps.run, resolver);
}

function reflectionEvent(
  attemptId: string,
  feature: FeatureMemoryGroup["feature"],
  memoryHitId: string | null,
  result: ReflectionEpisodeResult,
  sequence: number,
  memoryRef: string | null,
): ToolEvent {
  const prompt = memoryRef === null ? null : sharedMemoryPrompt("store");
  return {
    attemptId,
    phase: "reflect",
    operation: "memory_store",
    featureKey: feature.key,
    memoryHitId,
    status: result.status === "reflection_failed" ? result.failure : result.status,
    sequence,
    memoryRef,
    ...(prompt === null ? {} : { promptVersion: prompt.version, promptDigest: prompt.digest }),
  };
}

function failedReflectionEvent(
  attemptId: string,
  feature: FeatureMemoryGroup["feature"],
  memoryHitId: string | null,
  sequence: number,
  status: string,
  memoryRef: string | null,
): ToolEvent {
  const prompt = memoryRef === null ? null : sharedMemoryPrompt("store");
  return {
    attemptId,
    phase: "reflect",
    operation: "memory_store",
    featureKey: feature.key,
    memoryHitId,
    status,
    sequence,
    memoryRef,
    ...(prompt === null ? {} : { promptVersion: prompt.version, promptDigest: prompt.digest }),
  };
}

async function reflectEpisodesAfterReveal(
  input: FeatureScopedTaskRuntimeInput & {
    truth: { latitude: number; longitude: number; country: string };
  },
  result: LocateResult,
  deps: FeatureScopedTaskRuntimeDeps & { writer: MemoryWriter },
  binding: MemoryBinding & { mode: "training" },
): Promise<void> {
  const reflect = deps.reflectEpisode ?? reflectEpisode;
  let sequence = result.trace.events.length;
  const candidates = new Set(
    episodeCandidatesFromGroups(result.attemptId, result.memoryGroups).map(
      (candidate) => `${candidate.featureKey}\0${candidate.memoryHitId}`,
    ),
  );
  const observedFeatures = new Set(result.observations.map((observation) => observation.key));
  const noHitFeatures = new Set<string>();
  const distanceKm = haversineKm(result.guess, {
    latitude: input.truth.latitude,
    longitude: input.truth.longitude,
  });
  for (const group of result.memoryGroups) {
    const reflectionHits: Array<MemoryHit | null> = group.status === "hits"
      ? group.hits.filter((hit) => candidates.has(`${hit.featureKey}\0${hit.memoryHitId}`))
      : group.status === "no_hit" &&
          group.failure === null &&
          group.hits.length === 0 &&
          observedFeatures.has(group.feature.key) &&
          !noHitFeatures.has(group.feature.key)
        ? [null]
        : [];
    if (group.status === "no_hit" && reflectionHits.length === 1) noHitFeatures.add(group.feature.key);
    for (const hit of reflectionHits) {
      try {
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
          { memoryBinding: binding, run: deps.run },
        );
        const episode: EpisodeTrace = {
          attemptId: result.attemptId,
          featureKey: group.feature.key,
          memoryHitId: hit?.memoryHitId ?? null,
          effect: reflection.effect,
          reflectionStatus: reflection.status,
          lessonId: reflection.lessonId,
          ...(reflection.failure === null ? {} : { failure: reflection.failure }),
        };
        result.episodes.push(episode);
        if (result.trace.episodes !== result.episodes) result.trace.episodes.push(episode);
        sequence += 1;
        result.trace.events.push(reflectionEvent(
          result.attemptId,
          group.feature,
          hit?.memoryHitId ?? null,
          reflection,
          sequence,
          deps.run.memoryRef,
        ));
      } catch (error) {
        const bindingFailure = error instanceof MemoryBindingError ? error.code : null;
        const episode: EpisodeTrace = {
          attemptId: result.attemptId,
          featureKey: group.feature.key,
          memoryHitId: hit?.memoryHitId ?? null,
          effect: null,
          reflectionStatus: bindingFailure ?? "reflection_failed",
          lessonId: null,
          ...(bindingFailure === null ? {} : { failure: bindingFailure }),
        };
        result.episodes.push(episode);
        if (result.trace.episodes !== result.episodes) result.trace.episodes.push(episode);
        sequence += 1;
        const eventStatus = error instanceof MemoryBindingError
          ? error.code
          : error instanceof ReflectRuntimeError
            ? error.code
            : "reflection_failed";
        result.trace.events.push(failedReflectionEvent(
          result.attemptId,
          group.feature,
          hit?.memoryHitId ?? null,
          sequence,
          eventStatus,
          deps.run.memoryRef,
        ));
      }
    }
  }
}

async function runFeatureScopedTaskAttempt(
  input: FeatureScopedTaskRuntimeInput,
  deps: FeatureScopedTaskRuntimeDeps,
): Promise<TaskResult> {
  const startedAt = Date.now();
  const attemptId = input.attemptId ?? input.imageId;
  try {
    const binding = await resolveTaskBinding(deps);
    const locateDeps = {
      ...deps.locateDeps,
      run: deps.run,
      memoryBinding: binding,
    };
    const result = deps.locate === undefined
      ? await locateWithRuntime(
          { attemptId, imagePath: input.imagePath },
          { ...locateDeps, memoryBinding: binding },
        )
      : await deps.locate({ attemptId, imagePath: input.imagePath }, locateDeps);
    if (binding.mode === "training" && shouldReflect(input, deps.run, binding)) {
      await reflectEpisodesAfterReveal(
        input,
        result,
        { ...deps, writer: binding.writer } as FeatureScopedTaskRuntimeDeps & { writer: MemoryWriter },
        binding,
      );
    }
    const legacyGlobalProviderIds = deps.benchmark?.legacyGlobalProviderIds;
    const use = memoryUseFromLocate(result, {
      attemptId: result.attemptId,
      validOutput: true,
      latencyMs: Date.now() - startedAt,
      guess: result.guess as Guess,
      truth: input.truth,
      fixture: deps.benchmark?.retrievalFixture,
      legacyGlobalProviderIds,
    });
    return { ok: true, guess: result.guess as Guess, ...use };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const partial = readLocatePartialResult(error);
    const legacyGlobalProviderIds = deps.benchmark?.legacyGlobalProviderIds;
    const use = partial === null
      ? {
          ...emptyMemoryUse(),
          attemptMetrics: buildAttemptMetrics({
            attemptId,
            observations: [],
            memoryGroups: [],
            episodes: [],
            validOutput: false,
            latencyMs: Date.now() - startedAt,
            fixture: deps.benchmark?.retrievalFixture,
            legacyGlobalProviderIds,
          }),
        }
      : memoryUseFromLocate(partial, {
          attemptId: partial.attemptId,
          validOutput: false,
          latencyMs: Date.now() - startedAt,
          truth: input.truth,
          fixture: deps.benchmark?.retrievalFixture,
          legacyGlobalProviderIds,
        });
    if (error instanceof UnparseableOutputError) {
      return { ok: false, failure: "unparseable", message, ...use };
    }
    if (message.includes("ENOENT")) {
      return { ok: false, failure: "missing_image", message, ...use };
    }
    if (error instanceof MemoryBindingError) {
      return { ok: false, failure: error.code, message, ...use };
    }
    return { ok: false, failure: "api_error", message, ...use };
  }
}

function retryableSampleMemoryFailure(result: TaskResult): boolean {
  return !result.ok && (result.failure === "unavailable" || result.failure === "timeout");
}

function sampleAttemptId(baseAttemptId: string, retryIndex: number): string {
  return retryIndex === 0 ? baseAttemptId : `${baseAttemptId}:sample-retry-${retryIndex}`;
}

function sampleRetryAttemptLimit(policy: SampleRetryPolicy | undefined): number {
  const value = policy?.maxSampleAttempts ?? MAX_SAMPLE_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAMPLE_ATTEMPTS) {
    throw new Error(`maxSampleAttempts must be an integer from 1 to ${MAX_SAMPLE_ATTEMPTS}`);
  }
  return value;
}

export async function runFeatureScopedTask(
  input: FeatureScopedTaskRuntimeInput,
  deps: FeatureScopedTaskRuntimeDeps,
): Promise<TaskResult> {
  const baseAttemptId = input.attemptId ?? input.imageId;
  const maxAttempts = sampleRetryAttemptLimit(deps.sampleRetryPolicy);
  const wait = deps.sampleRetryPolicy?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result: TaskResult = await runFeatureScopedTaskAttempt(
    { ...input, attemptId: sampleAttemptId(baseAttemptId, 0) },
    deps,
  );

  for (let retryIndex = 1; retryableSampleMemoryFailure(result) && retryIndex < maxAttempts; retryIndex += 1) {
    await wait(RETRY_DELAYS_MS[retryIndex - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0);
    result = await runFeatureScopedTaskAttempt(
      { ...input, attemptId: sampleAttemptId(baseAttemptId, retryIndex) },
      deps,
    );
  }

  if (!result.ok && retryableSampleMemoryFailure(result)) {
    return {
      ...result,
      message: `${result.message}; sample retry exhausted after ${maxAttempts} attempts`,
    };
  }
  return result;
}

export function runFeatureScopedTrainingTask(
  input: FeatureScopedTrainingTaskRuntimeInput,
  deps: FeatureScopedTrainingTaskRuntimeDeps,
): Promise<TaskResult> {
  return runFeatureScopedTask(input, deps);
}
