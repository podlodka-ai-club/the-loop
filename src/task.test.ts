import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import OpenAI from "openai";
import {
  locateWithRuntime,
  type LocateRuntimeChatClient as LocateChatClient,
  type LocateRuntimeChatCompletion as LocateChatCompletion,
  type LocateRuntimeHooks,
} from "./locate-runtime.internal.ts";
import type { LocateDeps } from "./locate.ts";
import {
  createFrozenMemorySnapshotBinding,
  createMemorySourceBinding,
  createMemorySourceResolver,
  markFrozenMemoryReader,
  resolveMemoryBinding,
} from "./memory/memory.ts";
import type {
  Hint,
  LessonInput,
  MemoryBinding,
  MemoryReader,
  MemoryWriter,
  MemoryWriteResult,
} from "./memory/memory.ts";
import { type FeatureObservation, type ObserveResult } from "./observe.ts";
import { loadPrompt } from "./promts.ts";
import { ReflectRuntimeError } from "./reflect-runtime.internal.ts";
import { runTask, type FeatureScopedTaskDeps } from "./task.ts";
import {
  runTrainingTaskWithRuntime,
  runTaskWithRuntime,
  type FeatureScopedTaskRuntimeInput,
  type LocateFunction,
  type ReflectEpisodeFunction,
} from "./task-runtime.internal.ts";
import { episodeCandidatesFromGroups } from "./tools/episode-ledger.internal.ts";
import { makeMemoryHitId, type FeatureMemoryGroup, type LocateResult, type MemoryHit, type MemoryRunConfig } from "./tools/memory.ts";
import type { ReflectionEpisodeInput, ReflectionEpisodeResult } from "./reflect.ts";
import { FileMemory, MEMORY_DIR } from "./memory/file/memory.ts";

const DYNAMIC_FEATURE_KEYS = ["plates", "poles", "vegetation", "roadside_text"] as const;

const run = {
  memoryRef: "file",
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
} satisfies MemoryRunConfig;

function observed(
  overrides: Partial<Record<(typeof DYNAMIC_FEATURE_KEYS)[number], Partial<FeatureObservation>>>,
): ObserveResult {
  return {
    error: null,
    features: Object.entries(overrides).map(([key, feature]) => ({
      key,
      text: `${key} visible cue`,
      ...feature,
    })),
  };
}

class MemoryReaderSpy implements MemoryReader {
  readonly invocations: Array<{ query: string; limit: number }> = [];
  readonly emptyQueries = new Set<string>();

  async recall(query: string, limit: number): Promise<Hint[]> {
    this.invocations.push({ query, limit });
    if (this.emptyQueries.has(query)) return [];
    return [
      { lessonId: `lesson-${this.invocations.length}-a`, text: `first memory for ${query}`, effect: "helped" },
      { lessonId: `lesson-${this.invocations.length}-b`, text: `second memory for ${query}`, effect: "misleading" },
    ];
  }
}

class MemoryWriterSpy extends MemoryReaderSpy implements MemoryWriter {
  readonly rememberInvocations: Array<{ lesson: LessonInput }> = [];
  result: MemoryWriteResult = { status: "stored", lessonId: "lesson-written" };

  async remember(lesson: LessonInput): Promise<MemoryWriteResult> {
    this.rememberInvocations.push({ lesson });
    return this.result;
  }

  async snapshot(): Promise<string> {
    return "snapshot";
  }

  async restore(): Promise<void> {}
}

class WritableProjectionMemorySpy extends MemoryWriterSpy {
  asReadOnlyReader(): MemoryReader {
    return this;
  }
}

class ReflectEpisodeSpy {
  readonly invocations: Array<{ input: ReflectionEpisodeInput }> = [];
  outcomes: ReflectionEpisodeResult[] = [
    { status: "stored", effect: "helped", lessonId: "lesson-written", failure: null },
  ];

  reflect: ReflectEpisodeFunction = async (input) => {
    this.invocations.push({ input });
    return this.outcomes.shift() ?? {
      status: "stored",
      effect: "helped",
      lessonId: `lesson-${this.invocations.length}`,
      failure: null,
    };
  };
}

class LocateClientSpy implements LocateChatClient {
  readonly invocations: OpenAI.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly missingAlwaysFor = new Set<string>();
  readonly analyzeErrors: Error[] = [];
  analyzeContent: string = JSON.stringify({
    latitude: 12.5,
    longitude: 34.75,
    place: "Structured place",
    confidence: 0.6,
    reasoning: "Image and grouped memory were used as hypotheses.",
  });

  chat = {
    completions: {
      create: async (params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<LocateChatCompletion> => {
        this.invocations.push(params);
        const featureKey = activeFeatureKey(params);
        if (featureKey !== null) {
          if (this.missingAlwaysFor.has(featureKey)) {
            return { choices: [{ message: {} }] };
          }
          return {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: `call-${featureKey}`,
                      type: "function",
                      function: {
                        name: "memory_retrieve",
                        arguments: JSON.stringify({
                          feature_key: featureKey,
                          query: `${featureKey} visual cue`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        const analyzeError = this.analyzeErrors.shift();
        if (analyzeError !== undefined) throw analyzeError;
        return {
          provider: "fake",
          choices: [{ message: { content: this.analyzeContent } }],
        };
      },
    },
  };
}

const _featureScopedTaskDepsRejectRuntimeLocateDeps = {
  run,
  locateDeps: {
    // @ts-expect-error runtime hooks belong behind injected locate, not public task locateDeps.
    client: undefined as unknown as LocateRuntimeHooks["client"],
  },
} satisfies FeatureScopedTaskDeps;
void _featureScopedTaskDepsRejectRuntimeLocateDeps;

function locateWithHooks(hooks: LocateRuntimeHooks): LocateFunction {
  return (input, deps) => locateWithRuntime(input, { ...deps, ...hooks });
}

async function makeResolvedBinding(
  memory: MemoryWriter,
  config: MemoryRunConfig = run,
  loadSnapshot?: (snapshotId: string) => Promise<MemoryReader>,
): Promise<MemoryBinding> {
  if (config.memoryRef === null) assert.fail("feature-scoped fixture requires a memory reference");
  const source = createMemorySourceBinding({
    memoryRef: config.memoryRef,
    memory,
    loadSnapshot: async (snapshotId) => createFrozenMemorySnapshotBinding({
      memoryRef: config.memoryRef!,
      snapshotId,
      reader: markFrozenMemoryReader(
        loadSnapshot === undefined
          ? memory.loadSnapshot === undefined
            ? memory
            : await memory.loadSnapshot(snapshotId)
          : await loadSnapshot(snapshotId),
        snapshotId,
      ),
    }),
  });
  return resolveMemoryBinding(config, createMemorySourceResolver(source));
}

const _featureScopedTaskDepsRejectLocateOverride = {
  run,
  // @ts-expect-error locate override is internal-only; public runTask always uses canonical locate.
  locate: locateWithHooks({}),
} satisfies FeatureScopedTaskDeps;
void _featureScopedTaskDepsRejectLocateOverride;

test("public runTask ignores hidden locate on widened feature-scoped deps", async () => {
  let injectedLocateCalls = 0;
  const injectedLocate: LocateFunction = async (input): Promise<LocateResult> => {
    injectedLocateCalls += 1;
    return {
      attemptId: input.attemptId,
      guess: {
        latitude: 1,
        longitude: 2,
        place: "Injected bypass",
        confidence: 1,
        reasoning: "This result must never escape public runTask.",
        provider: "injected",
      },
      observations: [],
      memoryGroups: [],
      episodes: [],
      trace: { attemptId: input.attemptId, groups: [], episodes: [], events: [] },
    };
  };
  const widenedDeps = {
    run,
    memoryBinding: await makeResolvedBinding(new MemoryWriterSpy()),
    locate: injectedLocate,
  } satisfies FeatureScopedTaskDeps & { locate: LocateFunction };
  const publicDeps: FeatureScopedTaskDeps = widenedDeps;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";

  try {
    const result = await runTask(
      {
        imageId: "image-public-boundary",
        imagePath: "tmp/does-not-exist/public-run-task-boundary.jpg",
        attemptId: "attempt-public-boundary",
      },
      publicDeps,
    );

    assert.equal(injectedLocateCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.failure, "api_error");
    assert.match(result.message, /Input file is missing: tmp\/does-not-exist\/public-run-task-boundary\.jpg/);
    assert.deepEqual(result.memoryGroups, []);
    assert.deepEqual(result.episodes, []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "episodeCandidates"), false);
  } finally {
    if (previousOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
  }
});

function activeFeatureKey(params: OpenAI.ChatCompletionCreateParamsNonStreaming): string | null {
  const tool = params.tools?.[0];
  if (tool?.type !== "function") return null;
  const schema = tool.function.parameters as {
    properties?: { feature_key?: { enum?: unknown[] } };
  };
  const values = schema.properties?.feature_key?.enum;
  return Array.isArray(values) && typeof values[0] === "string" ? values[0] : null;
}

function analyzeText(request: OpenAI.ChatCompletionCreateParamsNonStreaming): string {
  const message = request.messages.at(-1);
  const content = message?.content;
  assert.ok(Array.isArray(content));
  const part = content.find((item) => typeof item === "object" && item !== null && "text" in item) as
    | { text?: unknown }
    | undefined;
  if (typeof part?.text !== "string") assert.fail("expected analyze text");
  return part.text;
}

test("runTask feature-scoped path keeps a valid guess with failed and no-hit groups and creates candidates only for hits", async () => {
  const memory = new MemoryWriterSpy();
  const client = new LocateClientSpy();
  client.missingAlwaysFor.add("plates");
  memory.emptyQueries.add("vegetation visual cue");

  const result = await runTaskWithRuntime(
    { imageId: "image-1", imagePath: "image-1.jpg", attemptId: "attempt-1" },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            poles: { text: "wooden poles" },
            vegetation: { text: "dry scrub" },
          }),
      }),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected a valid Guess");
  assert.deepEqual(result.guess, {
    latitude: 12.5,
    longitude: 34.75,
    place: "Structured place",
    confidence: 0.6,
    reasoning: "Image and grouped memory were used as hypotheses.",
    provider: "fake",
  });
  assert.deepEqual(memory.invocations, [
    { query: "poles visual cue", limit: 5 },
    { query: "vegetation visual cue", limit: 5 },
  ]);
  assert.deepEqual(
    result.memoryGroups.map((group) => [group.feature.key, group.status, group.failure, group.hits.length]),
    [
      ["plates", "failed", "missing_tool_call", 0],
      ["poles", "hits", null, 2],
      ["vegetation", "no_hit", null, 0],
    ],
  );
  assert.deepEqual(result.episodes, []);
  const episodeCandidates = episodeCandidatesFromGroups("attempt-1", result.memoryGroups);
  assert.deepEqual(
    episodeCandidates.map((episode) => [episode.attemptId, episode.featureKey, episode.memoryHitId]),
    result.memoryGroups[1]?.hits.map((hit) => ["attempt-1", "poles", hit.memoryHitId]),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(result, "episodeCandidates"), false);
  assert.ok(result.trace);
  assert.equal(Object.prototype.hasOwnProperty.call(result.trace, "episodeCandidates"), false);
  assert.deepEqual(result.trace?.episodes, []);
  assert.deepEqual(
    result.trace?.groups.map((group) => [group.feature.key, group.status]),
    [
      ["plates", "failed"],
      ["poles", "hits"],
      ["vegetation", "no_hit"],
    ],
  );
  assert.equal(result.hintCount, 2);
  assert.deepEqual(result.hintIds, ["lesson-1-a", "lesson-1-b"]);

  const analyze = client.invocations.at(-1);
  assert.ok(analyze);
  assert.equal(analyze.tool_choice, "none");
  assert.equal(analyze.tools, undefined);
  assert.equal(analyze.parallel_tool_calls, false);
  const text = analyzeText(analyze);
  const analyzePrompt = loadPrompt("analyze");
  assert.equal(text.startsWith(analyzePrompt), true);
  assert.equal(text.includes('"memory_groups"'), true);
  assert.equal(text.includes("treat them as hypotheses"), true);
  assert.equal(text.includes("use them only where they match the image"), true);
  assert.equal(text.includes("hints"), false);
  assert.equal(text.includes("lesson-1-a"), true);
});

test("runTask feature-scoped path does not allow locateDeps to override authoritative memory or run config", async () => {
  const authoritativeMemory = new MemoryWriterSpy();
  const authoritativeBinding = await makeResolvedBinding(authoritativeMemory);
  let capturedDeps: LocateDeps | null = null;
  const locateSpy: LocateFunction = async (input, deps): Promise<LocateResult> => {
    capturedDeps = deps;
    return {
      attemptId: input.attemptId,
      guess: {
        latitude: 12.5,
        longitude: 34.75,
        place: "Structured place",
        confidence: 0.6,
        reasoning: "Injected locate returned a structured result.",
        provider: "fake",
      },
      observations: [],
      memoryGroups: [],
      episodes: [],
      trace: { attemptId: input.attemptId, groups: [], episodes: [], events: [] },
    };
  };

  const result = await runTaskWithRuntime(
    { imageId: "image-authoritative-deps", imagePath: "authoritative-deps.jpg", attemptId: "attempt-authoritative-deps" },
    {
      memoryBinding: authoritativeBinding,
      run,
      locate: locateSpy,
      locateDeps: {
        maxToolAttemptsPerFeature: 1,
      },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(capturedDeps);
  const observedDeps = capturedDeps as LocateDeps;
  assert.equal(observedDeps.memoryBinding, authoritativeBinding);
  assert.equal(observedDeps.run, run);
  assert.equal(observedDeps.maxToolAttemptsPerFeature, 1);
  assert.deepEqual(authoritativeMemory.invocations, []);
});

test("runTask feature-scoped path keeps observation failures as empty canonical groups and still analyzes the image", async () => {
  const memory = new MemoryWriterSpy();
  const client = new LocateClientSpy();
  const imagePaths: string[] = [];

  const result = await runTaskWithRuntime(
    { imageId: "image-observe-failed", imagePath: "observe-failed.jpg" },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async (imagePath) => {
          imagePaths.push(imagePath);
          return "data:image/jpeg;base64,AA==";
        },
        observe: async () => ({ features: [], error: "malformed observation response" }),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.memoryGroups, []);
  assert.deepEqual(result.episodes, []);
  assert.deepEqual(result.trace, {
    attemptId: "image-observe-failed",
    groups: [],
    episodes: [],
    events: [],
  });
  assert.deepEqual(result.hints, []);
  assert.deepEqual(result.features, []);
  assert.deepEqual(memory.invocations, []);
  assert.deepEqual(imagePaths, ["observe-failed.jpg"]);
});

test("runTask feature-scoped path preserves structured unparseable failures", async () => {
  const client = new LocateClientSpy();
  client.analyzeContent = "{not-json}";

  const result = await runTaskWithRuntime(
    { imageId: "image-bad-guess", imagePath: "bad-guess.jpg" },
    {
      memoryBinding: await makeResolvedBinding(new MemoryWriterSpy()),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden poles" },
          }),
      }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected structured failure");
  assert.equal(result.failure, "unparseable");
  assert.equal(result.message, "response is not valid JSON");
  assert.deepEqual(
    result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
    [["poles", "hits", 2]],
  );
  assert.deepEqual(result.episodes, []);
  const episodeCandidates = episodeCandidatesFromGroups("image-bad-guess", result.memoryGroups);
  assert.deepEqual(
    episodeCandidates.map((episode) => [episode.featureKey, episode.memoryHitId]),
    result.memoryGroups[0]?.hits.map((hit) => ["poles", hit.memoryHitId]),
  );
  assert.ok(result.trace);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "episodeCandidates"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.trace, "episodeCandidates"), false);
  assert.deepEqual(result.trace?.episodes, []);
});

test("runTask feature-scoped path preserves grouped trace and derives episode candidates when final analyze fails", async () => {
  const client = new LocateClientSpy();
  const analyzeError = new Error("upstream analyze failed");
  Object.preventExtensions(analyzeError);
  client.analyzeErrors.push(analyzeError);

  const result = await runTaskWithRuntime(
    { imageId: "image-analyze-failed", imagePath: "analyze-failed.jpg", attemptId: "attempt-analyze-failed" },
    {
      memoryBinding: await makeResolvedBinding(new MemoryWriterSpy()),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden poles" },
            vegetation: { text: "dry scrub" },
          }),
      }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected structured failure");
  assert.equal(result.failure, "api_error");
  assert.equal(result.message, "upstream analyze failed");
  assert.deepEqual(
    result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
    [
      ["poles", "hits", 2],
      ["vegetation", "hits", 2],
    ],
  );
  const episodeCandidates = episodeCandidatesFromGroups("attempt-analyze-failed", result.memoryGroups);
  assert.deepEqual(
    episodeCandidates.map((candidate) => [candidate.attemptId, candidate.featureKey, candidate.memoryHitId]),
    result.memoryGroups.flatMap((group) =>
      group.hits.map((hit) => ["attempt-analyze-failed", group.feature.key, hit.memoryHitId]),
    ),
  );
  assert.deepEqual(result.episodes, []);
  assert.deepEqual(result.trace?.groups, result.memoryGroups);
  assert.ok(result.trace);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "episodeCandidates"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.trace, "episodeCandidates"), false);
  assert.deepEqual(result.trace?.episodes, []);
});

test("runTask feature-scoped path retries analyze rate limits without repeating retrieval", async () => {
  const memory = new MemoryWriterSpy();
  const client = new LocateClientSpy();
  const sleeps: number[] = [];
  const statusRateLimit = Object.assign(new Error("provider busy"), { status: 429 });
  const namedRateLimit = new Error("provider busy");
  namedRateLimit.name = "RateLimitError";
  client.analyzeErrors.push(statusRateLimit, namedRateLimit);

  const result = await runTaskWithRuntime(
    { imageId: "image-rate-limited", imagePath: "rate-limited.jpg", attemptId: "attempt-rate-limited" },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      locate: locateWithHooks({
        client,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            poles: { text: "wooden poles" },
          }),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(memory.invocations, [
    { query: "plates visual cue", limit: 5 },
    { query: "poles visual cue", limit: 5 },
  ]);
  assert.deepEqual(
    client.invocations
      .filter((request) => request.tools !== undefined)
      .map((request) => activeFeatureKey(request)),
    ["plates", "poles"],
  );
  assert.equal(client.invocations.filter((request) => request.tools === undefined).length, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.deepEqual(
    result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
    [
      ["plates", "hits", 2],
      ["poles", "hits", 2],
    ],
  );
  assert.deepEqual(result.trace?.events.map((event) => [event.featureKey, event.status]), [
    ["plates", "hits"],
    ["poles", "hits"],
  ]);
});

test("runTask feature-scoped training reflects one episode per hit after reveal without rollback or blind retry", async () => {
  const memory = new MemoryWriterSpy();
  const client = new LocateClientSpy();
  const reflect = new ReflectEpisodeSpy();
  reflect.outcomes = [
    { status: "stored", effect: "helped", lessonId: "lesson-first", failure: null },
    {
      status: "write_outcome_unknown",
      effect: "misleading",
      lessonId: null,
      failure: "write_outcome_unknown",
    },
  ];

  const result = await runTaskWithRuntime(
    {
      imageId: "image-reflect-training",
      imagePath: "reflect-training.jpg",
      attemptId: "attempt-reflect-training",
      truth: { latitude: -30.03, longitude: -51.23, country: "BR" },
    },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      reflectEpisode: reflect.reflect,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden poles" },
          }),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(reflect.invocations.length, 2);
  assert.deepEqual(
    reflect.invocations.map(({ input }) => ({
      attemptId: input.attemptId,
      imagePath: input.imagePath,
      feature: input.feature,
      hitId: input.memoryHit.memoryHitId,
      guess: input.guess,
      truth: input.truth,
      distanceKm: Math.round(input.distanceKm),
    })),
    result.memoryGroups[0]?.hits.map((hit) => ({
      attemptId: "attempt-reflect-training",
      imagePath: "reflect-training.jpg",
      feature: { key: "poles", text: "wooden poles" },
      hitId: hit.memoryHitId,
      guess: result.ok
        ? {
            latitude: result.guess.latitude,
            longitude: result.guess.longitude,
            place: result.guess.place,
            reasoning: result.guess.reasoning,
          }
        : assert.fail("expected ok result"),
      truth: { latitude: -30.03, longitude: -51.23, country: "BR" },
      distanceKm: 10320,
    })),
  );
  assert.deepEqual(result.episodes, [
    {
      attemptId: "attempt-reflect-training",
      featureKey: "poles",
      memoryHitId: result.memoryGroups[0]?.hits[0]?.memoryHitId,
      effect: "helped",
      reflectionStatus: "stored",
      lessonId: "lesson-first",
    },
    {
      attemptId: "attempt-reflect-training",
      featureKey: "poles",
      memoryHitId: result.memoryGroups[0]?.hits[1]?.memoryHitId,
      effect: "misleading",
      reflectionStatus: "write_outcome_unknown",
      failure: "write_outcome_unknown",
      lessonId: null,
    },
  ]);
  assert.deepEqual(result.trace?.episodes, result.episodes);
  assert.deepEqual(
    result.trace?.events.map((event) => [event.phase, event.operation, event.featureKey, event.memoryHitId, event.status]),
    [
      ["retrieve", "memory_retrieve", "poles", null, "hits"],
      ["reflect", "memory_store", "poles", result.memoryGroups[0]?.hits[0]?.memoryHitId, "stored"],
      [
        "reflect",
        "memory_store",
        "poles",
        result.memoryGroups[0]?.hits[1]?.memoryHitId,
        "write_outcome_unknown",
      ],
    ],
  );
  assert.deepEqual(memory.rememberInvocations, []);
});

test("runTask feature-scoped training keeps the first stored episode when the next reflection runtime fails", async () => {
  const memory = new MemoryWriterSpy();
  const client = new LocateClientSpy();
  const reflectInvocations: Array<{ input: ReflectionEpisodeInput }> = [];
  const reflect: ReflectEpisodeFunction = async (input) => {
    reflectInvocations.push({ input });
    if (reflectInvocations.length === 2) throw new Error("model_failed");
    return { status: "stored", effect: "helped", lessonId: "lesson-first", failure: null };
  };

  const result = await runTrainingTaskWithRuntime(
    {
      imageId: "image-reflect-runtime-failed",
      imagePath: "reflect-runtime-failed.jpg",
      attemptId: "attempt-reflect-runtime-failed",
      truth: { latitude: -30.03, longitude: -51.23, country: "BR" },
    },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      reflectEpisode: reflect,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden poles" },
          }),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(reflectInvocations.length, 2);
  assert.deepEqual(result.episodes, [
    {
      attemptId: "attempt-reflect-runtime-failed",
      featureKey: "poles",
      memoryHitId: result.memoryGroups[0]?.hits[0]?.memoryHitId,
      effect: "helped",
      reflectionStatus: "stored",
      lessonId: "lesson-first",
    },
    {
      attemptId: "attempt-reflect-runtime-failed",
      featureKey: "poles",
      memoryHitId: result.memoryGroups[0]?.hits[1]?.memoryHitId,
      effect: null,
      reflectionStatus: "reflection_failed",
      lessonId: null,
    },
  ]);
  assert.deepEqual(result.trace?.episodes, result.episodes);
  assert.deepEqual(
    result.trace?.events.map((event) => [event.phase, event.operation, event.featureKey, event.memoryHitId, event.status]),
    [
      ["retrieve", "memory_retrieve", "poles", null, "hits"],
      ["reflect", "memory_store", "poles", result.memoryGroups[0]?.hits[0]?.memoryHitId, "stored"],
      ["reflect", "memory_store", "poles", result.memoryGroups[0]?.hits[1]?.memoryHitId, "reflection_failed"],
    ],
  );
  assert.deepEqual(memory.rememberInvocations, []);
});

test("runTask feature-scoped training preserves typed reflection runtime error code in trace event", async () => {
  for (const code of ["model_failed", "image_data_uri_failed"] as const) {
    const attemptId = `attempt-reflect-${code}`;
    const feature: FeatureObservation = { key: "poles", text: "wooden poles" };
    const hit: MemoryHit = {
      attemptId,
      featureKey: "poles",
      memoryHitId: makeMemoryHitId(attemptId, "poles", "lesson-source", "wooden pole lesson", 0),
      providerId: "lesson-source",
      text: "wooden pole lesson",
      score: 1,
      effect: "helped",
    };
    const locateSpy: LocateFunction = async (input): Promise<LocateResult> => {
      const groups: FeatureMemoryGroup[] = [
        {
          attemptId: input.attemptId,
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [hit],
          failure: null,
          retryCount: 0,
        },
      ];
      const episodes: LocateResult["episodes"] = [];
      return {
        attemptId: input.attemptId,
        guess: {
          latitude: 1,
          longitude: 2,
          place: "Typed runtime failure",
          confidence: 0.4,
          reasoning: "Injected locate produced one memory hit.",
          provider: "fake",
        },
        observations: [feature],
        memoryGroups: groups,
        episodes,
        trace: { attemptId: input.attemptId, groups, episodes, events: [] },
      };
    };
    const reflect: ReflectEpisodeFunction = async () => {
      throw new ReflectRuntimeError(code, new Error(code));
    };
    const writer = new MemoryWriterSpy();

    const result = await runTrainingTaskWithRuntime(
      {
        imageId: `image-reflect-${code}`,
        imagePath: `reflect-${code}.jpg`,
        attemptId,
        truth: { latitude: 1, longitude: 2, country: "BR" },
      },
      {
        memoryBinding: await makeResolvedBinding(writer),
        run,
        locate: locateSpy,
        reflectEpisode: reflect,
      },
    );

    assert.equal(result.ok, true, code);
    assert.deepEqual(result.episodes, [
      {
        attemptId,
        featureKey: "poles",
        memoryHitId: hit.memoryHitId,
        effect: null,
        reflectionStatus: "reflection_failed",
        lessonId: null,
      },
    ]);
    const event = result.trace?.events[0];
    assert.deepEqual(
      event === undefined ? undefined : {
        attemptId: event.attemptId,
        phase: event.phase,
        operation: event.operation,
        featureKey: event.featureKey,
        memoryHitId: event.memoryHitId,
        status: event.status,
        sequence: event.sequence,
      },
      {
        attemptId,
        phase: "reflect",
        operation: "memory_store",
        featureKey: "poles",
        memoryHitId: hit.memoryHitId,
        status: code,
        sequence: 1,
      },
    );
    assert.equal(event?.memoryRef, "file");
    assert.match(event?.promptDigest ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(writer.rememberInvocations, [], code);
  }
});

test("runTask feature-scoped path skips reflection for no-hit, skipped and failed retrieval outcomes", async () => {
  const client = new LocateClientSpy();
  client.missingAlwaysFor.add("plates");
  const memory = new MemoryWriterSpy();
  memory.emptyQueries.add("vegetation visual cue");
  const reflect = new ReflectEpisodeSpy();

  const result = await runTaskWithRuntime(
    {
      imageId: "image-no-episode-reflection",
      imagePath: "no-episode-reflection.jpg",
      attemptId: "attempt-no-episode-reflection",
      truth: { latitude: -30.03, longitude: -51.23, country: "BR" },
    },
    {
      memoryBinding: await makeResolvedBinding(memory),
      run,
      reflectEpisode: reflect.reflect,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            vegetation: { text: "dry scrub" },
          }),
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
    [
      ["plates", "failed", 0],
      ["vegetation", "no_hit", 0],
    ],
  );
  assert.deepEqual(result.episodes, []);
  assert.deepEqual(reflect.invocations, []);
  assert.deepEqual(memory.rememberInvocations, []);
});

test("runTask feature-scoped reflection is training-only and memory bindings expose reader-only evaluation and production", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "loci-task-memory-"));
  const frozenLesson: LessonInput & { id: string; hits: number; wins: number } = {
    id: "lesson-0001",
    content: "Wooden crossarms match the frozen snapshot.",
    sourceAttemptId: `attempt-frozen-${randomUUID()}`,
    featureKey: "poles",
    memoryHitId: "attempt-frozen/poles/hit",
    effect: "helped",
    triggers: ["wooden crossarms"],
    region: "BR",
    idempotencyKey: `attempt-frozen:${randomUUID()}:hit`,
    hits: 0,
    wins: 0,
  };
  let snapshotPath: string | null = null;
  try {
    const locateResult = (input: { attemptId: string; imagePath: string }): LocateResult => {
      const polesFeature: FeatureObservation = { key: "poles", text: "wooden poles" };
      const hit = {
        attemptId: input.attemptId,
        featureKey: "poles" as const,
        memoryHitId: makeMemoryHitId(input.attemptId, "poles", "lesson-source", "wooden poles", 0),
        providerId: "lesson-source",
        text: "wooden poles",
        score: null,
        effect: null,
      };
      const groups = [
        {
          attemptId: input.attemptId,
          feature: polesFeature,
          query: "wooden poles",
          status: "hits" as const,
          hits: [hit],
          failure: null,
          retryCount: 0,
        },
      ];
      return {
        attemptId: input.attemptId,
        guess: {
          latitude: 1,
          longitude: 2,
          place: "Binding place",
          confidence: 0.8,
          reasoning: "Structured binding result.",
          provider: "fake",
        },
        observations: [polesFeature],
        memoryGroups: groups,
        episodes: [],
        trace: { attemptId: input.attemptId, groups, episodes: [], events: [] },
      };
    };
    const locateSpy: LocateFunction = async (input) => locateResult(input);
    const writer = new MemoryWriterSpy();

    for (const scenario of [
      { memoryRef: "file", mode: "evaluation" as const, snapshotId: "snapshot", readOnly: true },
      { memoryRef: "file", mode: "production" as const, snapshotId: null, readOnly: true },
    ]) {
      const reflect = new ReflectEpisodeSpy();
      const input: FeatureScopedTaskRuntimeInput = {
        imageId: `image-${scenario.mode}`,
        imagePath: `${scenario.mode}.jpg`,
        attemptId: "attempt-binding",
        truth: { latitude: 1, longitude: 2, country: "BR" },
      };
      const result = await runTaskWithRuntime(input, {
        memoryBinding: await makeResolvedBinding(writer, { ...scenario, recallLimit: 5 }),
        run: { ...scenario, recallLimit: 5 },
        locate: locateSpy,
        reflectEpisode: reflect.reflect,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.episodes, []);
      assert.deepEqual(reflect.invocations, [], scenario.mode);
    }

    const sourceMemory = new FileMemory(join(memoryDir, "live.jsonl"), "top", false);
    await sourceMemory.remember(frozenLesson);
    const snapshotId = await sourceMemory.snapshot();
    snapshotPath = join(MEMORY_DIR, `${snapshotId}.jsonl`);
    const resolver = createMemorySourceResolver(createMemorySourceBinding({
      memoryRef: "file",
      memory: sourceMemory,
      provider: "file",
      loadSnapshot: async (requestedSnapshotId: string) => {
        const snapshotReader = await sourceMemory.loadSnapshot(requestedSnapshotId);
        return createFrozenMemorySnapshotBinding({
          memoryRef: "file",
          snapshotId: requestedSnapshotId,
          reader: snapshotReader,
        });
      },
    }));
    const evaluation = await resolveMemoryBinding({
      memoryRef: "file",
      mode: "evaluation",
      snapshotId,
      readOnly: true,
      recallLimit: 5,
    }, resolver);
    const production = await resolveMemoryBinding({
      memoryRef: "file",
      mode: "production",
      snapshotId: null,
      readOnly: true,
      recallLimit: 5,
    }, resolver);
    const training = await resolveMemoryBinding({
      memoryRef: "file",
      mode: "training",
      snapshotId: null,
      readOnly: false,
      recallLimit: 5,
    }, resolver);

    assert.equal(evaluation.mode, "evaluation");
    assert.equal(Object.prototype.hasOwnProperty.call(evaluation, "writer"), false);
    assert.equal("remember" in evaluation.reader, false);
    assert.equal("restore" in evaluation.reader, false);
    assert.equal(production.mode, "production");
    assert.equal(Object.prototype.hasOwnProperty.call(production, "writer"), false);
    assert.equal("remember" in production.reader, false);
    assert.equal("restore" in production.reader, false);
    assert.equal(training.mode, "training");
    assert.equal(typeof training.writer.remember, "function");
    await assert.rejects(
      resolveMemoryBinding({ memoryRef: "file", mode: "evaluation", snapshotId: "", readOnly: true, recallLimit: 5 }, resolver),
      /evaluation memory requires/,
    );
    await assert.rejects(
      resolveMemoryBinding({ memoryRef: "file", mode: "production", snapshotId: null, readOnly: false, recallLimit: 5 }, resolver),
      /production memory requires/,
    );
    await assert.rejects(
      resolveMemoryBinding({ memoryRef: "file", mode: "training", snapshotId: "snapshot", readOnly: false, recallLimit: 5 }, resolver),
      /training memory requires/,
    );

    assert.deepEqual(await evaluation.reader.recall("wooden crossarms", 5), [
      {
        lessonId: "lesson-0001",
        text: "BR: Wooden crossarms match the frozen snapshot.",
        featureKey: "poles",
        effect: "helped",
      },
    ]);
    assert.match(await readFile(snapshotPath, "utf8"), /Wooden crossarms match the frozen snapshot/);
  } finally {
    if (snapshotPath !== null) await unlink(snapshotPath).catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runTask evaluation and production strip writable methods from read-only adapter projection", async () => {
  for (const scenario of [
    { memoryRef: "file", mode: "evaluation" as const, snapshotId: "snapshot-writable-projection", readOnly: true },
    { memoryRef: "file", mode: "production" as const, snapshotId: null, readOnly: true },
  ]) {
    const memory = new WritableProjectionMemorySpy();
    let receivedMemory: MemoryReader | null = null;
    const locateSpy: LocateFunction = async (input, deps): Promise<LocateResult> => {
      const memory = deps.memoryBinding?.reader;
      assert.ok(memory, scenario.mode);
      receivedMemory = memory;
      assert.equal("remember" in memory, false, scenario.mode);
      assert.equal("restore" in memory, false, scenario.mode);
      assert.deepEqual(await memory.recall("wooden poles", 5), [
        { lessonId: "lesson-1-a", text: "first memory for wooden poles", effect: "helped" },
        { lessonId: "lesson-1-b", text: "second memory for wooden poles", effect: "misleading" },
      ]);
      return {
        attemptId: input.attemptId,
        guess: {
          latitude: 1,
          longitude: 2,
          place: "Writable projection",
          confidence: 0.5,
          reasoning: "Projected memory was reader-only.",
          provider: "fake",
        },
        observations: [],
        memoryGroups: [],
        episodes: [],
        trace: { attemptId: input.attemptId, groups: [], episodes: [], events: [] },
      };
    };

    const result = await runTaskWithRuntime(
      {
        imageId: `image-writable-projection-${scenario.mode}`,
        imagePath: `writable-projection-${scenario.mode}.jpg`,
        attemptId: `attempt-writable-projection-${scenario.mode}`,
        truth: { latitude: 1, longitude: 2, country: "BR" },
      },
      {
        memoryBinding: await makeResolvedBinding(memory, { ...scenario, recallLimit: 5 }),
        run: { ...scenario, recallLimit: 5 },
        locate: locateSpy,
        reflectEpisode: new ReflectEpisodeSpy().reflect,
      },
    );

    assert.equal(result.ok, true, scenario.mode);
    assert.ok(receivedMemory, scenario.mode);
    assert.equal("remember" in receivedMemory, false, scenario.mode);
    assert.equal("restore" in receivedMemory, false, scenario.mode);
    assert.deepEqual(memory.invocations, [{ query: "wooden poles", limit: 5 }], scenario.mode);
    assert.deepEqual(memory.rememberInvocations, [], scenario.mode);
  }
});

test("runTask evaluation uses the frozen MemoryBinding before feature-scoped retrieval", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "loci-task-direct-file-memory-"));
  const memoryPath = join(memoryDir, "live.jsonl");
  const snapshotId = "snapshot-direct";
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  const storedLesson: LessonInput & { id: string; hits: number; wins: number } = {
    id: "lesson-0001",
    content: "Wooden poles line up with the revealed country.",
    sourceAttemptId: "attempt-file-memory",
    featureKey: "poles",
    memoryHitId: "attempt-file-memory/poles/hit",
    effect: "helped",
    triggers: ["wooden poles"],
    region: "BR",
    idempotencyKey: "attempt-file-memory:poles:hit",
    hits: 0,
    wins: 0,
  };
  await writeFile(memoryPath, `${JSON.stringify(storedLesson)}\n`, "utf8");
  await writeFile(snapshotPath, `${JSON.stringify(storedLesson)}\n`, "utf8");
  const client = new LocateClientSpy();

  try {
    const sourceMemory = new FileMemory(memoryPath, "top", false);
    const binding = await makeResolvedBinding(
      sourceMemory,
      { memoryRef: "file", mode: "evaluation", snapshotId, readOnly: true, recallLimit: 5 },
      async (requestedSnapshotId) => new FileMemory(join(memoryDir, `${requestedSnapshotId}.jsonl`), "top", true),
    );
    const result = await runTaskWithRuntime(
      {
        imageId: "image-direct-file-memory",
        imagePath: "direct-file-memory.jpg",
        attemptId: "attempt-direct-file-memory",
      },
      {
        memoryBinding: binding,
        run: { memoryRef: "file", mode: "evaluation", snapshotId, readOnly: true, recallLimit: 5 },
        locate: locateWithHooks({
          client,
          imageDataUri: async () => "data:image/jpeg;base64,AA==",
          observe: async () =>
            observed({
              poles: { text: "wooden poles" },
            }),
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
      [["poles", "hits", 1]],
    );
    assert.equal(await readFile(memoryPath, "utf8"), `${JSON.stringify(storedLesson)}\n`);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runTask production uses a read-only MemoryBinding before feature-scoped retrieval", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "loci-task-production-file-memory-"));
  const memoryPath = join(memoryDir, "live.jsonl");
  const storedLesson: LessonInput & { id: string; hits: number; wins: number } = {
    id: "lesson-0001",
    content: "Wooden poles line up with the production reader.",
    sourceAttemptId: "attempt-file-memory-production",
    featureKey: "poles",
    memoryHitId: "attempt-file-memory-production/poles/hit",
    effect: "helped",
    triggers: ["wooden poles"],
    region: "BR",
    idempotencyKey: "attempt-file-memory-production:poles:hit",
    hits: 0,
    wins: 0,
  };
  await writeFile(memoryPath, `${JSON.stringify(storedLesson)}\n`, "utf8");
  const client = new LocateClientSpy();

  try {
    const binding = await makeResolvedBinding(
      new FileMemory(memoryPath, "top", false),
      { memoryRef: "file", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
    );
    const result = await runTaskWithRuntime(
      {
        imageId: "image-production-file-memory",
        imagePath: "production-file-memory.jpg",
        attemptId: "attempt-production-file-memory",
      },
      {
        memoryBinding: binding,
        run: { memoryRef: "file", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
        locate: locateWithHooks({
          client,
          imageDataUri: async () => "data:image/jpeg;base64,AA==",
          observe: async () =>
            observed({
              poles: { text: "wooden poles" },
            }),
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
      [["poles", "hits", 1]],
    );
    assert.equal(await readFile(memoryPath, "utf8"), `${JSON.stringify(storedLesson)}\n`);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runTask legacy path rejects a feature-scoped MemoryReader when deps.run is absent", async () => {
  const deps = { memory: new MemoryReaderSpy() } as unknown as Parameters<typeof runTask>[1];

  await assert.rejects(
    () => runTask({ imageId: "image-legacy-reader", imagePath: "legacy-reader.jpg" }, deps),
    /legacy runTask path requires LegacyMemory; pass deps\.run for feature-scoped MemoryReader/,
  );
});
