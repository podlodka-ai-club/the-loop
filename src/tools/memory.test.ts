import assert from "node:assert/strict";
import test from "node:test";
import type { FeatureObservation } from "../observe.ts";
import {
  MemoryBindingError,
  MemoryWriteError,
  sharedMemoryPrompt,
  sharedMemoryPromptMetadata,
  type Hint,
  type MemoryBindingRequest,
  type MemoryReader,
  type MemoryWriter,
  type MemoryWriteResult,
} from "../memory/memory.ts";
import { HindsightMemoryError } from "../memory/hindsight/error.ts";
import { episodeCandidatesFromGroups } from "./episode-ledger.internal.ts";
import { executeMemoryRetrieveWithRuntimeBudget } from "./memory-runtime.internal.ts";
import {
  MEMORY_RETRIEVE_TOOL,
  MEMORY_STORE_TOOL,
  MemoryToolValidationError,
  executeMemoryRetrieve,
  executeMemoryStore,
  makeIdempotencyKey,
  makeMemoryHitId,
  memoryToolsForPhase,
  type FeatureMemoryGroup,
  type MemoryHit,
  type MemoryRunConfig,
  type MemoryToolContext,
} from "./memory.ts";

const FEATURE_KEYS = [
  "traffic_side",
  "script_and_language",
  "visible_text",
  "plates",
  "poles",
  "bollards_and_barriers",
  "road_markings",
  "road_surface",
  "vegetation",
  "terrain_and_soil",
  "built_environment",
  "vehicles",
] as const;

const run: MemoryRunConfig = {
  memoryRef: "file",
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
};

const feature: FeatureObservation = {
  key: "poles",

  text: "wooden utility poles with crossarms",
};

class FakeReader implements MemoryReader {
  calls: Array<{ query: string; limit: number }> = [];
  hints: Hint[] = [];
  output?: unknown;
  featureScope?: MemoryReader["featureScope"];
  promptPort?: MemoryReader["promptPort"];
  error?: Error;

  async recall(query: string, limit: number): Promise<Hint[]> {
    this.calls.push({ query, limit });
    if (this.error !== undefined) throw this.error;
    if (this.output !== undefined) return this.output as Hint[];
    return this.hints;
  }
}

class FakeWriter extends FakeReader implements MemoryWriter {
  lessons: unknown[] = [];
  result: MemoryWriteResult = { status: "stored", lessonId: "lesson-1" };
  writeError?: Error;

  async remember(lesson: unknown): Promise<{ status: "stored" | "already_stored"; lessonId: string }> {
    this.lessons.push(lesson);
    if (this.writeError !== undefined) throw this.writeError;
    return this.result;
  }

  async snapshot(): Promise<string> {
    return "snapshot";
  }

  async restore(): Promise<void> {}
}

function context(reader = new FakeReader()): MemoryToolContext {
  return {
    attemptId: "attempt-1",
    reader,
    phase: "retrieve",
    run,
    activeFeature: feature,
  };
}

const _publicMemoryToolContextRejectsBudget = {
  attemptId: "attempt-type",
  reader: new FakeReader(),
  phase: "retrieve",
  run,
  activeFeature: feature,
  // @ts-expect-error budget is internal-only; use memory-runtime.internal for runtime budget tests.
  budget: { retrievalCallsRemaining: 0 },
} satisfies MemoryToolContext;
void _publicMemoryToolContextRejectsBudget;

function hit(overrides: Partial<MemoryHit> = {}): MemoryHit {
  return {
    attemptId: "attempt-1",
    featureKey: "poles",
    memoryHitId: "attempt-1/poles/hit",
    providerId: "lesson-source",
    text: "wooden poles",
    score: null,
    effect: null,
    ...overrides,
  };
}

function candidateHit(overrides: Partial<MemoryHit> = {}, occurrence = 0): MemoryHit {
  const value = {
    attemptId: "attempt-1",
    featureKey: "poles",
    providerId: "lesson-source",
    text: "wooden poles",
    score: null,
    effect: null,
    ...overrides,
  } satisfies Omit<MemoryHit, "memoryHitId"> & { memoryHitId?: string };
  return {
    ...value,
    memoryHitId:
      overrides.memoryHitId ??
      makeMemoryHitId(value.attemptId, value.featureKey, value.providerId, value.text, occurrence),
  };
}

function storeContext(writer = new FakeWriter(), activeMemoryHit = hit()): MemoryToolContext {
  return {
    ...context(writer),
    writer,
    phase: "reflect",
    activeMemoryHit,
  };
}

const validStoreArgs = {
  feature_key: "poles",
  memory_hit_id: "attempt-1/poles/hit",
  effect: "misleading",
  content: "The cue was too broad for the revealed country.",
  triggers: ["wooden poles"],
  region: "BR",
} as const;

function assertNoEpisodeOutcome(group: object & { hits: unknown[] }, name: string): void {
  assert.deepEqual(group.hits, [], name);
  assert.equal(Object.prototype.hasOwnProperty.call(group, "episode"), false, name);
  assert.equal(Object.prototype.hasOwnProperty.call(group, "episodes"), false, name);
}

test("tool definitions are strict, complete and phase gated", () => {
  assert.equal(MEMORY_RETRIEVE_TOOL.function.strict, true);
  assert.equal(MEMORY_STORE_TOOL.function.strict, true);
  assert.equal(MEMORY_RETRIEVE_TOOL.function.parameters.type, "object");
  assert.equal(MEMORY_STORE_TOOL.function.parameters.type, "object");
  assert.equal(MEMORY_RETRIEVE_TOOL.function.parameters.additionalProperties, false);
  assert.equal(MEMORY_STORE_TOOL.function.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(MEMORY_RETRIEVE_TOOL.function.parameters.properties), ["feature_key", "query"]);
  assert.deepEqual(Object.keys(MEMORY_STORE_TOOL.function.parameters.properties), [
    "feature_key",
    "memory_hit_id",
    "effect",
    "content",
    "triggers",
    "region",
  ]);
  assert.deepEqual(MEMORY_RETRIEVE_TOOL.function.parameters.required, ["feature_key", "query"]);
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.required, [
    "feature_key",
    "memory_hit_id",
    "effect",
    "content",
    "triggers",
    "region",
  ]);
  assert.deepEqual(MEMORY_RETRIEVE_TOOL.function.parameters.properties.feature_key, {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
  });
  assert.equal(MEMORY_RETRIEVE_TOOL.function.parameters.properties.query.type, "string");
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.feature_key, {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
  });
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.effect.enum, [
    "helped",
    "irrelevant",
    "misleading",
    "insufficient",
  ]);
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.memory_hit_id, {
    type: "string",
    minLength: 1,
  });
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.content, {
    type: "string",
    minLength: 1,
    maxLength: 2_000,
  });
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.triggers, {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: { type: "string", minLength: 1, maxLength: 128 },
  });
  assert.deepEqual(MEMORY_STORE_TOOL.function.parameters.properties.region, {
    type: "string",
    minLength: 2,
    maxLength: 2,
    pattern: "^[A-Z]{2}$",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(MEMORY_RETRIEVE_TOOL.function.parameters.properties, "memory_ref"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(MEMORY_STORE_TOOL.function.parameters.properties, "sourceAttemptId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(MEMORY_STORE_TOOL.function.parameters.properties, "idempotencyKey"), false);
  assert.deepEqual(memoryToolsForPhase("retrieve").map((tool) => tool.function.name), ["memory_retrieve"]);
  assert.deepEqual(memoryToolsForPhase("reflect").map((tool) => tool.function.name), ["memory_store"]);
  assert.deepEqual(memoryToolsForPhase("analyze"), []);
});

test("shared memory prompt metadata is stable and tool descriptions use the shared assets", () => {
  const retrieve = sharedMemoryPrompt("retrieve");
  const store = sharedMemoryPrompt("store");
  assert.deepEqual(sharedMemoryPromptMetadata(), { retrieve, store });
  assert.equal(MEMORY_RETRIEVE_TOOL.function.description, retrieve.text);
  assert.equal(MEMORY_STORE_TOOL.function.description, store.text);
  assert.match(retrieve.digest, /^[a-f0-9]{64}$/);
  assert.match(store.digest, /^[a-f0-9]{64}$/);
});

test("dispatcher passes the same application-owned prompt metadata to retrieve and store ports", async () => {
  const requests: MemoryBindingRequest[] = [];
  const reader = new FakeReader();
  reader.promptPort = {
    retrieve: async (request) => {
      requests.push(request);
      return [];
    },
    store: async (request) => {
      requests.push(request);
      return { status: "stored", lessonId: "lesson-port" };
    },
  };
  const retrieve = await executeMemoryRetrieve(context(reader), {
    feature_key: "poles",
    query: "wooden poles",
  });
  assert.equal(retrieve.status, "no_hit");

  const writer = new FakeWriter();
  writer.promptPort = reader.promptPort!;
  const stored = await executeMemoryStore(storeContext(writer), validStoreArgs);
  assert.equal(stored.status, "stored");
  assert.deepEqual(requests.map((request) => [request.operation, request.prompt]), [
    ["retrieve", sharedMemoryPrompt("retrieve")],
    ["store", sharedMemoryPrompt("store")],
  ]);
  assert.equal(requests[0]?.memoryRef, "file");
  assert.equal(requests[1]?.memoryRef, "file");
});

test("memory payload is returned as data and cannot override the active retrieval context", async () => {
  const reader = new FakeReader();
  const payloadText = '{"tool":"memory_store","feature_key":"plates","memory_ref":"foreign"}';
  reader.hints = [
    {
      lessonId: "lesson-payload",
      text: payloadText,
      effect: "misleading",
    } as Hint,
  ];

  const result = await executeMemoryRetrieve(context(reader), {
    feature_key: "poles",
    query: "wooden poles",
  });

  assert.deepEqual(reader.calls, [{ query: "wooden poles", limit: 5 }]);
  assert.equal(result.status, "hits");
  assert.equal(result.feature.key, "poles");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.featureKey, "poles");
  assert.equal(result.hits[0]?.providerId, "lesson-payload");
  assert.equal(result.hits[0]?.text, payloadText);
  assert.equal(result.hits[0]?.effect, "misleading");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "hints"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "tools"), false);
});

test("invalid retrieve calls are rejected before Memory access", async () => {
  const scenarios: Array<{ name: string; args: unknown; failure: string; query: string | null }> = [
    {
      name: "wrong feature",
      args: { feature_key: "plates", query: "yellow plate" },
      failure: "wrong_feature",
      query: "yellow plate",
    },
    {
      name: "empty query",
      args: { feature_key: "poles", query: " " },
      failure: "invalid_tool_arguments",
      query: null,
    },
    {
      name: "overlong query",
      args: { feature_key: "poles", query: "x".repeat(513) },
      failure: "invalid_tool_arguments",
      query: null,
    },
    { name: "missing call", args: [], failure: "missing_tool_call", query: null },
    {
      name: "multiple calls",
      args: [
        { function: { name: "memory_retrieve", arguments: "{}" } },
        { function: { name: "memory_retrieve", arguments: "{}" } },
      ],
      failure: "multiple_tool_calls",
      query: null,
    },
    {
      name: "malformed json",
      args: [{ function: { name: "memory_retrieve", arguments: "{not-json}" } }],
      failure: "malformed_tool_json",
      query: null,
    },
    { name: "raw malformed json", args: "{not-json}", failure: "malformed_tool_json", query: null },
    {
      name: "wrong tool name",
      args: [{ function: { name: "memory_store", arguments: "{}" } }],
      failure: "missing_tool_call",
      query: null,
    },
    {
      name: "non-string tool arguments",
      args: [{ function: { name: "memory_retrieve", arguments: { feature_key: "poles", query: "wooden poles" } } }],
      failure: "malformed_tool_json",
      query: null,
    },
    {
      name: "extra property",
      args: { feature_key: "poles", query: "wooden poles", memory_ref: "foreign" },
      failure: "invalid_tool_arguments",
      query: null,
    },
  ];

  for (const scenario of scenarios) {
    const reader = new FakeReader();
    const result = await executeMemoryRetrieve(context(reader), scenario.args);
    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.failure, scenario.failure, scenario.name);
    assert.equal(result.query, scenario.query, scenario.name);
    assert.deepEqual(result.hits, [], scenario.name);
    assert.deepEqual(reader.calls, [], scenario.name);
  }
});

test("retrieval calls Memory once with a bounded query and returns stable application-owned hit ids", async () => {
  const reader = new FakeReader();
  reader.hints = Array.from({ length: 6 }, (_value, index) => ({
    lessonId: `lesson-${index}`,
    text: `Wooden pole cue ${index}`,
    effect: index === 0 ? "helped" : undefined,
  }));

  const result = await executeMemoryRetrieve(context(reader), {
    feature_key: "poles",
    query: "  wooden   crossarms  ",
  });

  assert.deepEqual(reader.calls, [{ query: "wooden crossarms", limit: 5 }]);
  assert.equal(result.status, "hits");
  assert.equal(result.failure, null);
  assert.equal(result.hits.length, 5);
  assert.deepEqual(
    result.hits.map((memoryHit) => memoryHit.memoryHitId),
    Array.from({ length: 5 }, (_value, index) =>
      makeMemoryHitId("attempt-1", "poles", `lesson-${index}`, `Wooden pole cue ${index}`, index),
    ),
  );
  assert.equal(new Set(result.hits.map((memoryHit) => memoryHit.memoryHitId)).size, 5);
  assert.deepEqual(result.hits[0], {
    attemptId: "attempt-1",
    featureKey: "poles",
    memoryHitId: makeMemoryHitId("attempt-1", "poles", "lesson-0", "Wooden pole cue 0", 0),
    providerId: "lesson-0",
    text: "Wooden pole cue 0",
    score: null,
    effect: "helped",
  });
  assert.equal(
    makeMemoryHitId("attempt-1", "poles", "lesson-0", " Wooden   Pole Cue 0 ", 0),
    result.hits[0]?.memoryHitId,
  );
});

test("all recall mode is rejected and grouped retrieval is not globally merged", async () => {
  const reader = new FakeReader();
  reader.featureScope = "global";
  const rejected = await executeMemoryRetrieve(context(reader), {
    feature_key: "poles",
    query: "wooden poles",
  });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.failure, "invalid_tool_arguments");
  assert.deepEqual(reader.calls, []);

  const first = new FakeReader();
  first.hints = [{ lessonId: "z", text: "first group" }];
  const second = new FakeReader();
  second.hints = [{ lessonId: "a", text: "second group" }];

  const poles = await executeMemoryRetrieve(context(first), {
    feature_key: "poles",
    query: "poles",
  });
  const plates = await executeMemoryRetrieve(
    { ...context(second), activeFeature: { key: "plates", text: "white plate" } },
    { feature_key: "plates", query: "plates" },
  );

  assert.equal(poles.hits[0]?.featureKey, "poles");
  assert.equal(plates.hits[0]?.featureKey, "plates");
  assert.notEqual(poles.hits[0]?.memoryHitId, plates.hits[0]?.memoryHitId);
  assert.equal(Object.prototype.hasOwnProperty.call(poles, "hints"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(plates, "hints"), false);
});

test("retrieve dispatchers reject invalid run config before scope or budget outcomes", async () => {
  const invalidRuns: MemoryRunConfig[] = [
    { memoryRef: "file", mode: "production", snapshotId: null, readOnly: false, recallLimit: 5 },
    { memoryRef: "file", mode: "evaluation", snapshotId: null, readOnly: true, recallLimit: 5 },
    { memoryRef: "file", mode: "training", snapshotId: null, readOnly: true, recallLimit: 5 },
  ];

  for (const invalidRun of invalidRuns) {
    const globalReader = new FakeReader();
    globalReader.featureScope = "global";
    await assert.rejects(
      () =>
        executeMemoryRetrieve(
          { ...context(globalReader), run: invalidRun },
          { feature_key: "poles", query: "wooden poles" },
        ),
      MemoryToolValidationError,
      invalidRun.mode,
    );
    assert.deepEqual(globalReader.calls, [], invalidRun.mode);

    const budgetedReader = new FakeReader();
    await assert.rejects(
      () =>
        executeMemoryRetrieveWithRuntimeBudget(
          {
            ...context(budgetedReader),
            run: invalidRun,
            budget: { retrievalCallsRemaining: 0, memoryHitsRemaining: 0 },
          },
          { feature_key: "poles", query: "wooden poles" },
        ),
      MemoryToolValidationError,
      invalidRun.mode,
    );
    assert.deepEqual(budgetedReader.calls, [], invalidRun.mode);
  }
});

test("empty result, provider errors, timeout, skipped feature and exhausted budget are distinct no-episode outcomes", async () => {
  const empty = await executeMemoryRetrieve(context(), { feature_key: "poles", query: "wooden poles" });
  assert.equal(empty.status, "no_hit");
  assert.equal(empty.failure, null);
  assertNoEpisodeOutcome(empty, "empty result");

  const providerError = new FakeReader();
  providerError.error = new Error("provider rejected");
  const failed = await executeMemoryRetrieve(context(providerError), {
    feature_key: "poles",
    query: "wooden poles",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure, "memory_error");
  assertNoEpisodeOutcome(failed, "provider error");

  const timeout = new FakeReader();
  timeout.error = new HindsightMemoryError("timeout", "read");
  await assert.rejects(
    () =>
      executeMemoryRetrieve(context(timeout), {
        feature_key: "poles",
        query: "wooden poles",
      }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryBindingError);
      assert.equal(error.code, "timeout");
      assert.equal(error.name, "MemoryBindingError");
      return true;
    },
    "typed timeout",
  );
  assert.deepEqual(timeout.calls, [{ query: "wooden poles", limit: 5 }], "typed timeout provider call");

  const messageOnlyTimeout = new FakeReader();
  messageOnlyTimeout.error = new Error("request timeout");
  const messageOnlyFailed = await executeMemoryRetrieve(context(messageOnlyTimeout), {
    feature_key: "poles",
    query: "wooden poles",
  });
  assert.equal(messageOnlyFailed.status, "failed");
  assert.equal(messageOnlyFailed.failure, "memory_error");
  assertNoEpisodeOutcome(messageOnlyFailed, "message-only timeout");

  const skipped = await executeMemoryRetrieve(
    { ...context(), phase: "reflect", activeFeature: { key: "poles", text: "wooden poles" } },
    { feature_key: "poles", query: "wooden poles" },
  );
  assert.equal(skipped.status, "failed");
  assert.equal(skipped.failure, "skipped");
  assert.equal(skipped.query, null);
  assertNoEpisodeOutcome(skipped, "skipped feature");

  const exhausted = await executeMemoryRetrieveWithRuntimeBudget(
    { ...context(), budget: { retrievalCallsRemaining: 0 } },
    { feature_key: "poles", query: "wooden poles" },
  );
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.failure, "budget_exhausted");
  assert.equal(exhausted.query, null);
  assertNoEpisodeOutcome(exhausted, "retrieval call budget exhausted");

  const hitBudgetExhausted = new FakeReader();
  hitBudgetExhausted.hints = [{ lessonId: "lesson-1", text: "would otherwise match" }];
  const exhaustedHits = await executeMemoryRetrieveWithRuntimeBudget(
    { ...context(hitBudgetExhausted), budget: { memoryHitsRemaining: 0 } },
    { feature_key: "poles", query: "wooden poles" },
  );
  assert.equal(exhaustedHits.status, "failed");
  assert.equal(exhaustedHits.failure, "budget_exhausted");
  assert.equal(exhaustedHits.query, null);
  assertNoEpisodeOutcome(exhaustedHits, "memory hit budget exhausted");
  assert.deepEqual(hitBudgetExhausted.calls, []);
});

test("runtime hit cap remains effective when the reader has its own prompt port", async () => {
  const reader = new FakeReader();
  reader.hints = [
    { lessonId: "lesson-1", text: "first cue" },
    { lessonId: "lesson-2", text: "second cue" },
  ];
  let promptPortCalls = 0;
  reader.promptPort = {
    retrieve: async (request) => {
      promptPortCalls += 1;
      return reader.recall(request.query!, request.limit ?? 5);
    },
    store: async () => ({ status: "stored", lessonId: "unused" }),
  };

  const result = await executeMemoryRetrieveWithRuntimeBudget(
    { ...context(reader), budget: { memoryHitsRemaining: 1 } },
    { feature_key: "poles", query: "wooden poles" },
  );

  assert.equal(result.status, "hits");
  assert.equal(result.hits.length, 1);
  assert.equal(promptPortCalls, 1);
});

test("public memory retrieval ignores runtime budget on widened context", async () => {
  const reader = new FakeReader();
  reader.hints = [{ lessonId: "lesson-1", text: "wooden pole match" }];
  const widenedContext = {
    ...context(reader),
    budget: {
      retrievalCallsRemaining: 0,
      memoryHitsRemaining: 0,
    },
  } satisfies MemoryToolContext & {
    budget: {
      retrievalCallsRemaining: number;
      memoryHitsRemaining: number;
    };
  };
  const publicContext: MemoryToolContext = widenedContext;

  const result = await executeMemoryRetrieve(publicContext, {
    feature_key: "poles",
    query: "wooden poles",
  });

  assert.equal(result.status, "hits");
  assert.equal(result.failure, null);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(reader.calls, [{ query: "wooden poles", limit: 5 }]);
});

test("episode candidates are created only for returned hits in model-order groups", () => {
  const firstHit = candidateHit({ providerId: "lesson-pole-a", text: "wooden poles" }, 0);
  const secondHit = candidateHit({ providerId: null, text: "crossarms" }, 1);
  const groups: FeatureMemoryGroup[] = [
    {
      attemptId: "attempt-1",
      feature: { key: "plates", text: "white plate" },
      query: "white plate",
      status: "no_hit",
      hits: [],
      failure: null,
      retryCount: 0,
    },
    {
      attemptId: "attempt-1",
      feature,
      query: "wooden poles",
      status: "hits",
      hits: [firstHit, secondHit],
      failure: null,
      retryCount: 0,
    },
    {
      attemptId: "attempt-1",
      feature: { key: "vegetation", text: "dry scrub" },
      query: null,
      status: "failed",
      hits: [],
      failure: "memory_error",
      retryCount: 0,
    },
  ];

  const candidates = episodeCandidatesFromGroups("attempt-1", groups);

  assert.deepEqual(candidates, [
    { attemptId: "attempt-1", featureKey: "poles", memoryHitId: firstHit.memoryHitId },
    { attemptId: "attempt-1", featureKey: "poles", memoryHitId: secondHit.memoryHitId },
  ]);
  assert.deepEqual(
    candidates.map((candidate) => Object.keys(candidate)),
    [
      ["attemptId", "featureKey", "memoryHitId"],
      ["attemptId", "featureKey", "memoryHitId"],
    ],
  );
  for (const candidate of candidates) {
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, "pending"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, "reflectionStatus"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, "effect"), false);
  }
});

test("episode candidate ledger accepts valid failed and skipped no-episode groups", () => {
  const groups: FeatureMemoryGroup[] = [
    {
      attemptId: "attempt-1",
      feature: { key: "plates", text: "white plate" },
      query: null,
      status: "failed",
      hits: [],
      failure: "skipped",
      retryCount: 0,
    },
    {
      attemptId: "attempt-1",
      feature,
      query: "bounded failure query",
      status: "failed",
      hits: [],
      failure: "memory_error",
      retryCount: 0,
    },
    {
      attemptId: "attempt-1",
      feature: { key: "road_markings", text: "single center line" },
      query: "bounded wrong feature query",
      status: "failed",
      hits: [],
      failure: "wrong_feature",
      retryCount: 0,
    },
    {
      attemptId: "attempt-1",
      feature: { key: "vegetation", text: "dry scrub" },
      query: null,
      status: "failed",
      hits: [],
      failure: "skipped",
      retryCount: 0,
    },
  ];

  assert.deepEqual(episodeCandidatesFromGroups("attempt-1", groups), []);
});

test("episode candidate ledger accepts null provider ids but rejects empty provider ids", () => {
  const providerlessHit = candidateHit({ providerId: null, text: "providerless cue" });
  assert.deepEqual(
    episodeCandidatesFromGroups("attempt-1", [
      {
        attemptId: "attempt-1",
        feature,
        query: "providerless cue",
        status: "hits",
        hits: [providerlessHit],
        failure: null,
        retryCount: 0,
      },
    ]),
    [{ attemptId: "attempt-1", featureKey: "poles", memoryHitId: providerlessHit.memoryHitId }],
  );

  for (const providerId of ["", " "]) {
    assert.throws(
      () =>
        episodeCandidatesFromGroups("attempt-1", [
          {
            attemptId: "attempt-1",
            feature,
            query: "wooden poles",
            status: "hits",
            hits: [candidateHit({ providerId })],
            failure: null,
            retryCount: 0,
          },
        ]),
      (error) => error instanceof MemoryToolValidationError && error.failure === "foreign_hit",
      `providerId=${JSON.stringify(providerId)}`,
    );
  }
});

test("episode candidate ledger rejects duplicate and oversized groups while preserving dynamic order", () => {
  const platesGroup: FeatureMemoryGroup = {
    attemptId: "attempt-1",
    feature: { key: "plates", text: "white plate" },
    query: "white plate",
    status: "no_hit",
    hits: [],
    failure: null,
    retryCount: 0,
  };
  const polesGroup: FeatureMemoryGroup = {
    attemptId: "attempt-1",
    feature,
    query: "wooden poles",
    status: "hits",
    hits: [candidateHit()],
    failure: null,
    retryCount: 0,
  };
  const tooManyHits: FeatureMemoryGroup = {
    attemptId: "attempt-1",
    feature,
    query: "wooden poles",
    status: "hits",
    hits: Array.from({ length: 6 }, (_value, index) =>
      candidateHit({ providerId: `lesson-${index}`, text: `wooden poles ${index}` }, index),
    ),
    failure: null,
    retryCount: 0,
  };

  const scenarios: Array<{ name: string; groups: readonly FeatureMemoryGroup[] }> = [
    { name: "duplicate feature group", groups: [platesGroup, platesGroup] },
    { name: "more than five hits in one group", groups: [tooManyHits] },
    {
      name: "more groups than the maximum feature budget",
      groups: Array.from({ length: FEATURE_KEYS.length + 1 }, (_value, index) => ({
        ...platesGroup,
        feature: { key: FEATURE_KEYS[index % FEATURE_KEYS.length], text: "visible cue" },
      })) as FeatureMemoryGroup[],
    },
  ];

  for (const scenario of scenarios) {
    assert.throws(
      () => episodeCandidatesFromGroups("attempt-1", scenario.groups),
      (error) => error instanceof MemoryToolValidationError && error.failure === "foreign_hit",
      scenario.name,
    );
  }

  assert.deepEqual(
    episodeCandidatesFromGroups("attempt-1", [polesGroup, platesGroup]),
    [{ attemptId: "attempt-1", featureKey: "poles", memoryHitId: polesGroup.hits[0]!.memoryHitId }],
  );
});

test("episode candidate ledger rejects inconsistent group and hit envelopes", () => {
  const malformedScenarios: Array<{ name: string; groups: readonly unknown[] }> = [
    { name: "malformed group object", groups: [null as unknown as FeatureMemoryGroup] },
    {
      name: "extra group property",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit()],
          failure: null,
          episode: {},
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "missing feature object",
      groups: [
        {
          attemptId: "attempt-1",
          query: null,
          status: "failed",
          hits: [],
          failure: "memory_error",
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "hits group with null query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: null,
          status: "hits",
          hits: [candidateHit()],
          failure: null,
        },
      ],
    },
    {
      name: "hits group with empty query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "",
          status: "hits",
          hits: [candidateHit()],
          failure: null,
        },
      ],
    },
    {
      name: "no-hit group with whitespace query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: " ",
          status: "no_hit",
          hits: [],
          failure: null,
        },
      ],
    },
    {
      name: "no-hit group with oversized query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "x".repeat(513),
          status: "no_hit",
          hits: [],
          failure: null,
        },
      ],
    },
    {
      name: "failed group with empty query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "",
          status: "failed",
          hits: [],
          failure: "memory_error",
        },
      ],
    },
    {
      name: "failed group with oversized query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "x".repeat(513),
          status: "failed",
          hits: [],
          failure: "memory_error",
        },
      ],
    },
    {
      name: "invalid tool arguments group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "parsed but invalid query",
          status: "failed",
          hits: [],
          failure: "invalid_tool_arguments",
        },
      ],
    },
    {
      name: "missing tool call group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "query that should not exist",
          status: "failed",
          hits: [],
          failure: "missing_tool_call",
        },
      ],
    },
    {
      name: "multiple tool calls group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "query that should not exist",
          status: "failed",
          hits: [],
          failure: "multiple_tool_calls",
        },
      ],
    },
    {
      name: "malformed tool json group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "query that should not exist",
          status: "failed",
          hits: [],
          failure: "malformed_tool_json",
        },
      ],
    },
    {
      name: "extra feature property",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { ...feature, country: "BR" } as unknown as FeatureObservation,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit()],
          failure: null,
        },
      ],
    },
    {
      name: "invalid empty-feature no-hit group",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { key: "poles", text: "" },
          query: null,
          status: "no_hit",
          hits: [],
          failure: null,
        },
      ],
    },
    {
      name: "non-array hits",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: {},
          failure: null,
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "malformed hit object",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [null],
          failure: null,
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "extra hit property",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [{ ...candidateHit(), sourceAttemptId: "attempt-1" } as unknown as MemoryHit],
          failure: null,
        },
      ],
    },
    {
      name: "empty memory hit id",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ memoryHitId: "" })],
          failure: null,
        },
      ],
    },
    {
      name: "invalid provider id",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ providerId: 42 as unknown as string })],
          failure: null,
        },
      ],
    },
    {
      name: "empty hit text",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ text: " " })],
          failure: null,
        },
      ],
    },
    {
      name: "invalid hit score",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ score: Number.NaN })],
          failure: null,
        },
      ],
    },
    {
      name: "invalid hit effect",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ effect: "unknown" as unknown as MemoryHit["effect"] })],
          failure: null,
        },
      ],
    },
    {
      name: "unknown feature key",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { key: "unknown", text: "unknown cue" },
          query: "unknown cue",
          status: "no_hit",
          hits: [],
          failure: null,
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "extra feature property",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { key: "poles", text: "wooden poles", state: "unknown" },
          query: null,
          status: "failed",
          hits: [],
          failure: "memory_error",
        } as unknown as FeatureMemoryGroup,
      ],
    },
    {
      name: "foreign group attempt",
      groups: [
        {
          attemptId: "attempt-2",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit()],
          failure: null,
        },
      ],
    },
    {
      name: "foreign hit attempt",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ attemptId: "attempt-2" })],
          failure: null,
        },
      ],
    },
    {
      name: "foreign hit feature",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit({ featureKey: "plates" })],
          failure: null,
        },
      ],
    },
    {
      name: "no-hit group with hits",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "no_hit",
          hits: [candidateHit()],
          failure: null,
        },
      ],
    },
    {
      name: "failed group with hits",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "failed",
          hits: [candidateHit()],
          failure: "memory_error",
        },
      ],
    },
    {
      name: "skipped group with hits",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { key: "poles", text: "poles are absent from the frame" },
          query: null,
          status: "failed",
          hits: [candidateHit()],
          failure: "skipped",
        },
      ],
    },
    {
      name: "skipped group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature: { key: "poles", text: "poles are absent from the frame" },
          query: "should not have queried a hidden feature",
          status: "failed",
          hits: [],
          failure: "skipped",
        },
      ],
    },
    {
      name: "visible skipped group with query",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "should not have queried a skipped feature",
          status: "failed",
          hits: [],
          failure: "skipped",
        },
      ],
    },
    {
      name: "no-hit group with failure",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "no_hit",
          hits: [],
          failure: "memory_error",
        },
      ],
    },
    {
      name: "failed group without failure",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "failed",
          hits: [],
          failure: null,
        },
      ],
    },
    {
      name: "hits group with failure",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit()],
          failure: "memory_error",
        },
      ],
    },
    {
      name: "duplicate hit identity",
      groups: [
        {
          attemptId: "attempt-1",
          feature,
          query: "wooden poles",
          status: "hits",
          hits: [candidateHit(), candidateHit({ memoryHitId: candidateHit().memoryHitId }, 1)],
          failure: null,
        },
      ],
    },
  ];

  for (const scenario of malformedScenarios) {
    assert.throws(
      () => episodeCandidatesFromGroups("attempt-1", scenario.groups),
      (error) => error instanceof MemoryToolValidationError && error.failure === "foreign_hit",
      scenario.name,
    );
  }
});

test("episode candidate ledger rejects memoryHitId foreign prefixes and identity mismatches", () => {
  const scenarios: Array<{ name: string; memoryHitId: string }> = [
    {
      name: "foreign attempt prefix",
      memoryHitId: makeMemoryHitId("attempt-2", "poles", "lesson-source", "wooden poles", 0),
    },
    {
      name: "foreign feature prefix",
      memoryHitId: makeMemoryHitId("attempt-1", "plates", "lesson-source", "wooden poles", 0),
    },
    {
      name: "same prefix wrong digest",
      memoryHitId: "attempt-1/poles/000000000000",
    },
  ];

  for (const scenario of scenarios) {
    assert.throws(
      () =>
        episodeCandidatesFromGroups("attempt-1", [
          {
            attemptId: "attempt-1",
            feature,
            query: "wooden poles",
            status: "hits",
            hits: [candidateHit({ memoryHitId: scenario.memoryHitId })],
            failure: null,
          },
        ]),
      (error) => error instanceof MemoryToolValidationError && error.failure === "foreign_hit",
      scenario.name,
    );
  }
});

test("malformed recall outputs fail as memory errors without leaking invalid hits", async () => {
  const sparse = new Array(1);
  const malformed: unknown[] = [
    null,
    {},
    sparse,
    [null],
    [{ lessonId: "lesson-1" }],
    [{ lessonId: 1, text: "valid text" }],
    [{ lessonId: "lesson-1", text: "" }],
    [{ lessonId: "lesson-1", text: "valid text", featureKey: "unknown" }],
    [{ lessonId: "lesson-1", text: "valid text", effect: "unknown" }],
    [{ lessonId: "lesson-1", text: "valid text", score: Number.NaN }],
    [
      { lessonId: "lesson-1", text: "valid text" },
      { lessonId: "lesson-2", text: " " },
    ],
  ];

  for (const [index, output] of malformed.entries()) {
    const reader = new FakeReader();
    reader.output = output;
    const result = await executeMemoryRetrieve(context(reader), {
      feature_key: "poles",
      query: "wooden poles",
    });
    assert.equal(result.status, "failed", `case ${index}`);
    assert.equal(result.failure, "memory_error", `case ${index}`);
    assert.deepEqual(result.hits, [], `case ${index}`);
    assert.deepEqual(reader.calls, [{ query: "wooden poles", limit: 5 }], `case ${index}`);
  }
});

test("store dispatcher binds app-owned provenance and maps write outcomes", async () => {
  const writer = new FakeWriter();
  const memoryContext = storeContext(writer);

  const result = await executeMemoryStore(memoryContext, validStoreArgs);

  assert.deepEqual(result, { status: "stored", lessonId: "lesson-1", failure: null });
  assert.deepEqual(writer.lessons, [
    {
      content: "The cue was too broad for the revealed country.",
      sourceAttemptId: "attempt-1",
      featureKey: "poles",
      memoryHitId: "attempt-1/poles/hit",
      effect: "misleading",
      triggers: ["wooden poles"],
      region: "BR",
      idempotencyKey: makeIdempotencyKey("attempt-1", "poles", "attempt-1/poles/hit"),
    },
  ]);

  await assert.rejects(
    executeMemoryStore(memoryContext, {
      feature_key: "poles",
      memory_hit_id: "foreign",
      effect: "helped",
      content: "Valid content",
      triggers: ["wooden poles"],
      region: "BR",
    }),
    MemoryToolValidationError,
  );

  writer.writeError = new MemoryWriteError("write_failed");
  const writeFailed = await executeMemoryStore(memoryContext, {
    feature_key: "poles",
    memory_hit_id: "attempt-1/poles/hit",
    effect: "helped",
    content: "Valid content",
    triggers: ["wooden poles"],
    region: "BR",
  });
  assert.deepEqual(writeFailed, { status: "write_failed", lessonId: null, failure: "write_failed" });
});

test("store dispatcher preserves already_stored and unknown write outcomes without fabricating success", async () => {
  const duplicate = new FakeWriter();
  duplicate.result = { status: "already_stored", lessonId: "lesson-existing" };
  assert.deepEqual(await executeMemoryStore(storeContext(duplicate), validStoreArgs), {
    status: "already_stored",
    lessonId: "lesson-existing",
    failure: null,
  });

  const unknown = new FakeWriter();
  unknown.writeError = new MemoryWriteError("write_outcome_unknown");
  assert.deepEqual(await executeMemoryStore(storeContext(unknown), validStoreArgs), {
    status: "write_outcome_unknown",
    lessonId: null,
    failure: "write_outcome_unknown",
  });

  const voidWriter = new FakeWriter();
  Object.defineProperty(voidWriter, "remember", {
    value: async (lesson: unknown) => {
      voidWriter.lessons.push(lesson);
      return undefined;
    },
  });
  assert.deepEqual(await executeMemoryStore(storeContext(voidWriter), validStoreArgs), {
    status: "write_outcome_unknown",
    lessonId: null,
    failure: "write_outcome_unknown",
  });
  assert.equal(voidWriter.lessons.length, 1);
});

test("store dispatcher rejects unavailable store phases and read-only modes before writing", async () => {
  const scenarios: MemoryToolContext[] = [
    { ...storeContext(), phase: "retrieve" },
    { ...storeContext(), writer: undefined },
    { ...storeContext(), activeMemoryHit: undefined },
    {
      ...storeContext(),
      run: { memoryRef: "file", mode: "evaluation", snapshotId: "snapshot-1", readOnly: true, recallLimit: 5 },
    },
    {
      ...storeContext(),
      run: { memoryRef: "file", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
    },
  ];

  for (const scenario of scenarios) {
    const writer = scenario.writer;
    await assert.rejects(executeMemoryStore(scenario, validStoreArgs), MemoryToolValidationError);
    assert.deepEqual(writer instanceof FakeWriter ? writer.lessons : [], []);
  }
});

test("store dispatcher rejects bounded payload violations before writing", async () => {
  const scenarios: unknown[] = [
    { ...validStoreArgs, content: "" },
    { ...validStoreArgs, content: "x".repeat(2_001) },
    { ...validStoreArgs, content: "One. Two. Three." },
    { ...validStoreArgs, triggers: [] },
    { ...validStoreArgs, triggers: Array.from({ length: 9 }, (_value, index) => `trigger ${index}`) },
    { ...validStoreArgs, triggers: [" "] },
    { ...validStoreArgs, triggers: ["x".repeat(129)] },
    { ...validStoreArgs, region: "Brazil" },
    { ...validStoreArgs, region: "br" },
    { ...validStoreArgs, effect: "unknown" },
    { ...validStoreArgs, memory_ref: "foreign" },
  ];

  for (const args of scenarios) {
    const writer = new FakeWriter();
    await assert.rejects(executeMemoryStore(storeContext(writer), args), MemoryToolValidationError);
    assert.deepEqual(writer.lessons, []);
  }
});

test("store dispatcher shares sentence validation for abbreviations and compact boundaries", async () => {
  for (const content of ["One sentence.", "One sentence. Two sentence!", "Use e.g. this. Fine."]) {
    const writer = new FakeWriter();
    await assert.doesNotReject(executeMemoryStore(storeContext(writer), { ...validStoreArgs, content }));
    assert.equal(writer.lessons.length, 1);
  }

  for (const content of ["One. Two.Three.", "One. two.three."]) {
    const writer = new FakeWriter();
    await assert.rejects(
      executeMemoryStore(storeContext(writer), { ...validStoreArgs, content }),
      MemoryToolValidationError,
    );
    assert.deepEqual(writer.lessons, []);
  }
});
