import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import {
  locateWithRuntime,
  type LocateRuntimeChatClient as LocateChatClient,
  type LocateRuntimeChatCompletion as LocateChatCompletion,
  type LocateRuntimeHooks,
} from "./locate-runtime.internal.ts";
import type { LocateDeps } from "./locate.ts";
import { resolveMemoryBinding } from "./memory/memory.ts";
import type {
  Hint,
  LessonInput,
  MemoryReader,
  MemoryWriter,
  MemoryWriteResult,
} from "./memory/memory.ts";
import { FEATURE_KEYS, type FeatureObservation, type ObserveResult } from "./observe.ts";
import { runTask, type FeatureScopedTaskDeps } from "./task.ts";
import {
  runTaskWithRuntime,
  type FeatureScopedTaskRuntimeInput,
  type LocateFunction,
  type ReflectEpisodeFunction,
} from "./task-runtime.internal.ts";
import { episodeCandidatesFromGroups } from "./tools/episode-ledger.internal.ts";
import { makeMemoryHitId, type LocateResult, type MemoryRunConfig } from "./tools/memory.ts";
import type { ReflectionEpisodeInput, ReflectionEpisodeResult } from "./reflect.ts";

const run: MemoryRunConfig = {
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
};

function observed(
  overrides: Partial<Record<(typeof FEATURE_KEYS)[number], Partial<FeatureObservation>>>,
): ObserveResult {
  return {
    error: null,
    features: FEATURE_KEYS.map((key) => ({
      key,
      state: "not_visible",
      text: "",
      ...overrides[key],
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
    memory: new MemoryReaderSpy(),
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
  const memory = new MemoryReaderSpy();
  const client = new LocateClientSpy();
  client.missingAlwaysFor.add("plates");
  memory.emptyQueries.add("vegetation visual cue");

  const result = await runTaskWithRuntime(
    { imageId: "image-1", imagePath: "image-1.jpg", attemptId: "attempt-1" },
    {
      memory,
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "visible", text: "wooden poles" },
            vegetation: { state: "visible", text: "dry scrub" },
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
  assert.equal(text.includes("Memory groups:"), true);
  assert.equal(text.includes("treat them as hypotheses"), true);
  assert.equal(text.includes("use them only where they match the image"), true);
  assert.equal(text.includes("hints"), false);
  assert.equal(text.includes("lesson-1-a"), true);
});

test("runTask feature-scoped path does not allow locateDeps to override authoritative memory or run config", async () => {
  const authoritativeMemory = new MemoryReaderSpy();
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
      memory: authoritativeMemory,
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
  assert.equal(observedDeps.memory, authoritativeMemory);
  assert.equal(observedDeps.run, run);
  assert.equal(observedDeps.maxToolAttemptsPerFeature, 1);
  assert.deepEqual(authoritativeMemory.invocations, []);
});

test("runTask feature-scoped path keeps observation failures as empty canonical groups and still analyzes the image", async () => {
  const memory = new MemoryReaderSpy();
  const client = new LocateClientSpy();
  const imagePaths: string[] = [];

  const result = await runTaskWithRuntime(
    { imageId: "image-observe-failed", imagePath: "observe-failed.jpg" },
    {
      memory,
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
      memory: new MemoryReaderSpy(),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { state: "visible", text: "wooden poles" },
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
      memory: new MemoryReaderSpy(),
      run,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { state: "visible", text: "wooden poles" },
            vegetation: { state: "visible", text: "dry scrub" },
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
  const memory = new MemoryReaderSpy();
  const client = new LocateClientSpy();
  const sleeps: number[] = [];
  const statusRateLimit = Object.assign(new Error("provider busy"), { status: 429 });
  const namedRateLimit = new Error("provider busy");
  namedRateLimit.name = "RateLimitError";
  client.analyzeErrors.push(statusRateLimit, namedRateLimit);

  const result = await runTaskWithRuntime(
    { imageId: "image-rate-limited", imagePath: "rate-limited.jpg", attemptId: "attempt-rate-limited" },
    {
      memory,
      run,
      locate: locateWithHooks({
        client,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "visible", text: "wooden poles" },
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
  const memory = new MemoryReaderSpy();
  const writer = new MemoryWriterSpy();
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
      memory,
      writer,
      run,
      reflectEpisode: reflect.reflect,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { state: "visible", text: "wooden poles" },
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
      feature: { key: "poles", state: "visible", text: "wooden poles" },
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
      lessonId: null,
    },
  ]);
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
  assert.deepEqual(writer.rememberInvocations, []);
});

test("runTask feature-scoped path skips reflection for no-hit, not-visible and failed retrieval outcomes", async () => {
  const client = new LocateClientSpy();
  client.missingAlwaysFor.add("plates");
  const memory = new MemoryReaderSpy();
  memory.emptyQueries.add("vegetation visual cue");
  const writer = new MemoryWriterSpy();
  const reflect = new ReflectEpisodeSpy();

  const result = await runTaskWithRuntime(
    {
      imageId: "image-no-episode-reflection",
      imagePath: "no-episode-reflection.jpg",
      attemptId: "attempt-no-episode-reflection",
      truth: { latitude: -30.03, longitude: -51.23, country: "BR" },
    },
    {
      memory,
      writer,
      run,
      reflectEpisode: reflect.reflect,
      locate: locateWithHooks({
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "not_visible", text: "" },
            vegetation: { state: "visible", text: "dry scrub" },
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
  assert.deepEqual(writer.rememberInvocations, []);
});

test("runTask feature-scoped reflection is training-only and memory bindings expose reader-only evaluation and production", async () => {
  const locateResult = (input: { attemptId: string; imagePath: string }): LocateResult => {
    const polesFeature: FeatureObservation = { key: "poles", state: "visible", text: "wooden poles" };
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
    { mode: "evaluation" as const, snapshotId: "snapshot", readOnly: true },
    { mode: "production" as const, snapshotId: null, readOnly: true },
  ]) {
    const reflect = new ReflectEpisodeSpy();
    const input: FeatureScopedTaskRuntimeInput = {
      imageId: `image-${scenario.mode}`,
      imagePath: `${scenario.mode}.jpg`,
      attemptId: "attempt-binding",
      truth: { latitude: 1, longitude: 2, country: "BR" },
    };
    const result = await runTaskWithRuntime(input, {
      memory: writer,
      writer,
      run: { ...scenario, recallLimit: 5 },
      locate: locateSpy,
      reflectEpisode: reflect.reflect,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.episodes, []);
    assert.deepEqual(reflect.invocations, [], scenario.mode);
  }

  const evaluation = await resolveMemoryBinding({
    mode: "evaluation",
    snapshotId: "frozen-snapshot",
    readOnly: true,
    recallLimit: 5,
  });
  const production = await resolveMemoryBinding({
    mode: "production",
    snapshotId: null,
    readOnly: true,
    recallLimit: 5,
  });
  const training = await resolveMemoryBinding({
    mode: "training",
    snapshotId: null,
    readOnly: false,
    recallLimit: 5,
  });

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
    resolveMemoryBinding({ mode: "evaluation", snapshotId: "", readOnly: true, recallLimit: 5 }),
    /evaluation memory requires/,
  );
  await assert.rejects(
    resolveMemoryBinding({ mode: "production", snapshotId: null, readOnly: false, recallLimit: 5 }),
    /production memory requires/,
  );
  await assert.rejects(
    resolveMemoryBinding({ mode: "training", snapshotId: "snapshot", readOnly: false, recallLimit: 5 }),
    /training memory requires/,
  );
});

test("runTask legacy path rejects a feature-scoped MemoryReader when deps.run is absent", async () => {
  const deps = { memory: new MemoryReaderSpy() } as unknown as Parameters<typeof runTask>[1];

  await assert.rejects(
    () => runTask({ imageId: "image-legacy-reader", imagePath: "legacy-reader.jpg" }, deps),
    /legacy runTask path requires LegacyMemory; pass deps\.run for feature-scoped MemoryReader/,
  );
});
