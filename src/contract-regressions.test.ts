import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_FEATURES,
  normalizeObserveResult,
  observe,
  type FeatureObservation,
} from "./observe.ts";
import {
  createMemorySourceResolver,
  createMemorySourceBinding,
  createFrozenMemorySnapshotBinding,
  MemoryBindingError,
  markFrozenMemoryReader,
  createNoopMemoryBinding,
  resolveMemoryBinding,
  validateMemoryBinding,
  type Hint,
  type MemoryReader,
  type MemoryWriter,
} from "./memory/memory.ts";
import { locate } from "./locate.ts";
import { runTaskWithRuntime } from "./task-runtime.internal.ts";
import {
  locateWithRuntime,
  type LocateRuntimeChatClient,
  type LocateRuntimeChatCompletion,
} from "./locate-runtime.internal.ts";
import {
  executeMemoryStore,
  makeMemoryHitId,
  type LocateResult,
} from "./tools/memory.ts";
import { loadXmemorySchema } from "./memory/xmemory/schema.ts";
import {
  createXmemoryMemory,
  type XmemoryMemoryConfig,
} from "./memory/xmemory/memory.ts";
import type { XmemoryPlatformPort } from "./memory/xmemory/platform-contract.ts";
import {
  createHindsightMemory,
  loadHindsightMemoryConfig,
} from "./memory/hindsight/memory.ts";
import {
  resolveHindsightMemorySource,
  type HindsightPlatformPort,
} from "./memory/hindsight/platform-contract.ts";
import type { LessonInput } from "./memory/memory.ts";
import { reflectEpisode } from "./reflect.ts";

const feature: FeatureObservation = { key: "road_marking", text: "painted center line" };

function noHitResult(attemptId: string, observed: FeatureObservation[]): LocateResult {
  const groups = observed.map((item) => ({
    attemptId,
    feature: item,
    query: null,
    status: "no_hit" as const,
    hits: [],
    failure: null,
    retryCount: 0,
  }));
  return {
    attemptId,
    guess: {
      latitude: 1,
      longitude: 2,
      place: "local result",
      confidence: 0.5,
      reasoning: "test result",
      provider: "test",
    },
    observations: observed,
    memoryGroups: groups,
    episodes: [],
    trace: { attemptId, groups, episodes: [], events: [] },
  };
}

function lesson(idempotencyKey: string): LessonInput {
  return {
    content: "The road marking was useful evidence.",
    sourceAttemptId: "attempt-regression",
    featureKey: feature.key,
    memoryHitId: "hit-regression",
    effect: "helped",
    triggers: ["painted center line"],
    region: "BR",
    idempotencyKey,
  };
}

test("dynamic observe rejects whitespace, preserves geographic-looking text and enforces injected feature budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loci-contract-observe-"));
  const imagePath = join(directory, "image.jpg");
  const cacheDir = join(directory, "cache");
  await writeFile(imagePath, "image-bytes");
  try {
    const accepted = await observe(imagePath, {
      cacheDir,
      model: async () => JSON.stringify({
        features: [
          { key: "Visible Text", text: "Kyiv street sign in Cyrillic" },
          { key: "road-marking", text: "painted center line" },
        ],
      }),
    });
    assert.deepEqual(accepted.features, [
      { key: "visible_text", text: "Kyiv street sign in Cyrillic" },
      { key: "road_marking", text: "painted center line" },
    ]);
    assert.equal(accepted.error, null);

    const whitespace = await observe(imagePath, {
      cacheDir: join(directory, "whitespace-cache"),
      model: async () => JSON.stringify({ features: [{ key: "surface", text: "   " }] }),
    });
    assert.deepEqual(whitespace.features, []);
    assert.notEqual(whitespace.error, null);

    const tooMany = normalizeObserveResult({
      error: null,
      features: Array.from({ length: MAX_FEATURES + 1 }, (_, index) => ({
        key: `marker_${index}`,
        text: "visible marker",
      })),
    });
    assert.deepEqual(tooMany.features, []);
    assert.notEqual(tooMany.error, null);
  assert.equal(existsSync("src/observe-geo-entities.json"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reflect binding, XMD schema and binding identity have explicit hard boundaries", async () => {
  const schema = readFileSync("src/memory/xmemory/schema.xmd.yml", "utf8");
  assert.doesNotMatch(schema, /Never extract|Do not interpret|Create one record|lesson text as instructions/);

  const memory: MemoryWriter = {
    recall: async () => [],
    remember: async () => ({ status: "stored", lessonId: "unused" }),
    snapshot: async () => "unused",
    restore: async () => {},
  };
  const source = createMemorySourceBinding({ memoryRef: "binding-test", memory });
  const resolver = createMemorySourceResolver(source);
  const run = { memoryRef: "binding-test", mode: "training" as const, snapshotId: null, readOnly: false, recallLimit: 5 as const };
  const binding = await resolveMemoryBinding(run, resolver);
  const tampered = { ...binding, promptPort: { ...binding.promptPort } };
  assert.throws(
    () => {
      // The copy is structurally valid but is not the composition-root binding.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      validateMemoryBinding(tampered, run);
    },
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
});

test("public reflection cannot store without the resolved MemoryBinding", async () => {
  const result = await reflectEpisode(
    {
      attemptId: "reflect-binding-test",
      imagePath: "reflect-binding-test.jpg",
      feature,
      memoryHit: {
        attemptId: "reflect-binding-test",
        featureKey: feature.key,
        memoryHitId: "hit-reflect-binding-test",
        providerId: "provider",
        text: "painted center line",
        score: null,
        effect: null,
      },
      guess: { latitude: 1, longitude: 2, place: "test", reasoning: "test" },
      truth: { latitude: 1, longitude: 2, country: "BR" },
      distanceKm: 0,
    },
    { run: { memoryRef: "binding-test", mode: "training", snapshotId: null, readOnly: false, recallLimit: 5 } } as unknown as Parameters<typeof reflectEpisode>[1],
  );
  assert.deepEqual(result, {
    status: "memory_mismatch",
    effect: null,
    lessonId: null,
    failure: "memory_mismatch",
  });
});

test("public locate uses direct memory and only accepts a resolver for that same memory", async () => {
  const run = { memoryRef: "public-locate-memory", mode: "production" as const, snapshotId: null, readOnly: true, recallLimit: 5 as const };
  const memory: MemoryReader = { recall: async () => [] };
  const otherMemory: MemoryReader = { recall: async () => [] };
  const resolver = createMemorySourceResolver(createMemorySourceBinding({
    memoryRef: run.memoryRef,
    memory,
  }));
  const missingImage = join(tmpdir(), "loci-public-locate-missing-image.jpg");

  await assert.rejects(
    locate({ attemptId: "direct-locate", imagePath: missingImage }, { memory, run }),
    (error) => !(error instanceof MemoryBindingError) && /ENOENT/.test(String(error)),
  );
  await assert.rejects(
    locate({ attemptId: "same-binding-locate", imagePath: missingImage }, { memory, memorySourceResolver: resolver, run }),
    (error) => !(error instanceof MemoryBindingError) && /ENOENT/.test(String(error)),
  );
  await assert.rejects(
    locate({ attemptId: "mismatched-locate", imagePath: missingImage }, {
      memory: otherMemory,
      memorySourceResolver: resolver,
      run,
    }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
});

test("no-memory locate creates no-hit groups without a retrieval model turn", async () => {
  let modelCalls = 0;
  const result = await locateWithRuntime(
    { attemptId: "no-memory-locate", imagePath: "not-read-by-hooks.jpg" },
    {
      memoryBinding: createNoopMemoryBinding({ mode: "production", snapshotId: null }),
      run: { memoryRef: null, mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      observe: async () => ({ features: [feature], error: null }),
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
      client: {
        chat: {
          completions: {
            create: async (params) => {
              modelCalls += 1;
              assert.equal(params.tools, undefined);
              return {
                choices: [{ message: { content: JSON.stringify({
                  latitude: 1,
                  longitude: 2,
                  place: "no-memory",
                  confidence: 1,
                  reasoning: "no memory",
                }) } }],
              };
            },
          },
        },
      },
    },
  );

  assert.equal(modelCalls, 1);
  assert.deepEqual(result.memoryGroups, [{
    attemptId: "no-memory-locate",
    feature,
    query: null,
    status: "no_hit",
    hits: [],
    failure: null,
    retryCount: 0,
  }]);
});

test("feature-scoped task requires a unified binding and does not use benchmark memory side paths", async () => {
  let locateCalls = 0;
  let directMemoryCalls = 0;
  const failed = await runTaskWithRuntime(
    { imageId: "resolver-required", imagePath: "resolver-required.jpg", attemptId: "resolver-required" },
    {
      run: { memoryRef: "missing", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      benchmark: { retrievalFixture: [], legacyGlobalProviderIds: ["explicit-control"] },
      locate: async () => {
        locateCalls += 1;
        return noHitResult("resolver-required", []);
      },
    },
  );

  assert.equal(failed.ok, false);
  if (failed.ok) assert.fail("expected missing resolver failure");
  assert.equal(failed.failure, "memory_not_found");
  assert.equal(locateCalls, 0);
  assert.equal(directMemoryCalls, 0);

  const noMemory = await runTaskWithRuntime(
    { imageId: "no-memory", imagePath: "no-memory.jpg", attemptId: "no-memory" },
    {
      run: { memoryRef: null, mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      benchmark: { retrievalFixture: [], legacyGlobalProviderIds: ["explicit-control"] },
      locate: async (_input, deps) => {
        assert.equal(deps.memory, undefined);
        return noHitResult("no-memory", [feature]);
      },
    },
  );
  assert.equal(noMemory.ok, true);
  assert.deepEqual(noMemory.memoryGroups.map((group) => group.status), ["no_hit"]);
  assert.equal(directMemoryCalls, 0);
});

test("evaluation binding never falls back to live reader when snapshot support is absent", async () => {
  const live: MemoryReader = { recall: async () => [{ lessonId: "live", text: "live" }] };
  const frozen = markFrozenMemoryReader(
    { recall: async () => [{ lessonId: "frozen", text: "frozen" }] },
    "snapshot-1",
  );
  const resolver = createMemorySourceResolver(createMemorySourceBinding({
    memoryRef: "file",
    reader: live,
    provider: "file",
    loadSnapshot: async (snapshotId) => createFrozenMemorySnapshotBinding({
      memoryRef: "file",
      snapshotId,
      reader: frozen,
    }),
  }));
  const binding = await resolveMemoryBinding({
    memoryRef: "file",
    mode: "evaluation",
    snapshotId: "snapshot-1",
    readOnly: true,
    recallLimit: 5,
  }, resolver);
  assert.deepEqual(await binding.reader.recall("cue", 1), [{ lessonId: "frozen", text: "frozen" }]);

  await assert.rejects(
    resolveMemoryBinding({
      memoryRef: "file",
      mode: "evaluation",
      snapshotId: "snapshot-2",
      readOnly: true,
      recallLimit: 5,
    }, createMemorySourceResolver(createMemorySourceBinding({ memoryRef: "file", reader: live }))),
    (error) => error instanceof MemoryBindingError && error.code === "unavailable",
  );
});

test("transient provider failure is retried by the caller with a new sample attempt", async () => {
  let recallCalls = 0;
  let sleepCalls = 0;
  let modelCalls = 0;
  const reader: MemoryReader = {
    recall: async () => {
      recallCalls += 1;
      if (recallCalls === 1) throw new MemoryBindingError("unavailable");
      return [];
    },
  };
  const toolCall = {
    id: "call-regression",
    type: "function",
    function: {
      name: "memory_retrieve",
      arguments: JSON.stringify({ feature_key: feature.key, query: feature.text }),
    },
  };
  const client: LocateRuntimeChatClient = {
    chat: {
      completions: {
        create: async (params): Promise<LocateRuntimeChatCompletion> => {
          modelCalls += 1;
          if (params.tools !== undefined) {
            return { choices: [{ message: { tool_calls: [toolCall] } }] };
          }
          return {
            choices: [{ message: { content: JSON.stringify({
              latitude: 1,
              longitude: 2,
              place: "test",
              confidence: 0.5,
              reasoning: "test",
            }) } }],
            provider: "test",
          };
        },
      },
    },
  };
  const source = createMemorySourceBinding({ memoryRef: "retry-memory", reader });
  const run = { memoryRef: "retry-memory", mode: "production" as const, snapshotId: null, readOnly: true, recallLimit: 5 as const };
  const binding = await resolveMemoryBinding(run, createMemorySourceResolver(source));
  const result = await runTaskWithRuntime(
    { imageId: "retry-image", attemptId: "retry-attempt", imagePath: "retry.jpg" },
    {
      memoryBinding: binding,
      run,
      sampleRetryPolicy: { maxSampleAttempts: 2, sleep: async () => { sleepCalls += 1; } },
      locate: async (input, deps) => locateWithRuntime(input, {
        ...deps,
        client,
        observe: async () => ({ features: [feature], error: null }),
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
      }),
    },
  );
  assert.ok(result.ok);
  assert.equal(result.memoryGroups.length, 1);
  assert.equal(result.memoryGroups[0]?.attemptId, "retry-attempt:sample-retry-1");
  assert.equal(result.memoryGroups[0]?.status, "no_hit");
  assert.ok(result.trace);
  assert.equal(result.trace.events.length, 1);
  assert.equal(recallCalls, 2);
  assert.equal(sleepCalls, 1);
  assert.equal(modelCalls, 3);
});

test("store binding errors stay typed outcomes instead of becoming unknown writes", async () => {
  const writer: MemoryWriter = {
    recall: async () => [],
    remember: async () => { throw new MemoryBindingError("unavailable"); },
    snapshot: async () => "snapshot",
    restore: async () => {},
  };
  const hit = {
    attemptId: "store-attempt",
    featureKey: feature.key,
    memoryHitId: makeMemoryHitId("store-attempt", feature.key, "provider", "painted center line", 0),
    providerId: "provider",
    text: "painted center line",
    score: null,
    effect: null,
  };
  const source = createMemorySourceBinding({ memoryRef: "store-memory", memory: writer });
  const binding = await resolveMemoryBinding(
    { memoryRef: "store-memory", mode: "training", snapshotId: null, readOnly: false, recallLimit: 5 },
    createMemorySourceResolver(source),
  );
  const result = await executeMemoryStore({
    attemptId: "store-attempt",
    reader: binding.reader,
    writer: binding.writer,
    promptPort: binding.promptPort,
    phase: "reflect",
    run: { memoryRef: "store-memory", mode: "training", snapshotId: null, readOnly: false, recallLimit: 5 },
    activeFeature: feature,
    activeMemoryHit: hit,
  }, {
    feature_key: feature.key,
    memory_hit_id: hit.memoryHitId,
    effect: "helped",
    content: "The line was useful.",
    triggers: ["painted center line"],
    region: "BR",
  });
  assert.deepEqual(result, { status: "unavailable", lessonId: null, failure: "unavailable" });
});

test("Hindsight and XMemory return already_stored across adapter instances", async () => {
  const idempotencyKey = "cross-instance-regression";
  const input = lesson(idempotencyKey);

  let hindsightWrites = 0;
  const hindsightDocuments = new Set<string>();
  const hindsightSource = resolveHindsightMemorySource({
    memoryRef: "hindsight-regression",
    bankId: "bank-regression",
    purpose: "integration",
  });
  const hindsightPlatform: HindsightPlatformPort = {
    supportsAtomicIdempotency: true,
    retain: async () => {
      hindsightWrites += 1;
      hindsightDocuments.add(idempotencyKey);
      return { success: true, bankId: hindsightSource.bankId, itemsCount: 1, async: false, operationId: null, usage: null };
    },
    recall: async () => ({ results: [] }),
    getDocument: async ({ documentId }) => hindsightDocuments.has(documentId) ? { documentId } : null,
    getVersion: async () => ({ apiVersion: "test" }),
    listDocuments: async () => ({ total: 0 }),
  };
  const hindsightConfig = loadHindsightMemoryConfig(hindsightSource, { HINDSIGHT_API_KEY: "test" });
  const hindsightA = createHindsightMemory({ snapshots: false }, hindsightConfig, { platform: hindsightPlatform });
  const hindsightB = createHindsightMemory({ snapshots: false }, hindsightConfig, { platform: hindsightPlatform });
  assert.equal((await hindsightA.remember(input)).status, "stored");
  assert.equal((await hindsightB.remember(input)).status, "already_stored");
  assert.equal(hindsightWrites, 1);

  const schema = await loadXmemorySchema();
  const changes = {
    created: { objects: [], relations: [] },
    updated: { objects: [], relations: [] },
    deleted: { objects: [], relations: [] },
  };
  let xmemoryWrites = 0;
  const xmemoryKeys = new Set<string>();
  const xmemoryPlatform: XmemoryPlatformPort = {
    supportsAtomicIdempotency: true,
    getSchema: async () => schema.value,
    write: async (request) => {
      xmemoryWrites += 1;
      const key = /^idempotency_key: ([^\n]*)$/m.exec(request.text)?.[1];
      if (key !== undefined && key !== "") xmemoryKeys.add(key);
      return { writeId: "xmemory-write-regression", traceId: null, changes };
    },
    read: async () => ({
      traceId: null,
      readerResult: {
        columns: [{ name: "idempotency_key", type: "str" }],
        rows: [...xmemoryKeys].map((key) => [key]),
      },
    }),
  };
  const xmemoryConfig: XmemoryMemoryConfig = {
    apiKey: "test",
    instanceId: "xmemory-regression",
    writeTimeoutMs: 1_000,
    readTimeoutMs: 1_000,
  };
  const xmemoryA = await createXmemoryMemory({ snapshots: false }, xmemoryConfig, { platform: xmemoryPlatform });
  const xmemoryB = await createXmemoryMemory({ snapshots: false }, xmemoryConfig, { platform: xmemoryPlatform });
  assert.equal((await xmemoryA.remember(input)).status, "stored");
  assert.equal((await xmemoryB.remember(input)).status, "already_stored");
  assert.equal(xmemoryWrites, 1);
});
