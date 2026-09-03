import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBenchmarkPairContract, buildAttemptMetrics, buildBenchmarkExperimentMetadata, loadRetrievalFixture, parseBenchmarkMemoryMode, retrievalMetricsFromGroups, retrievalMetricsFromLegacyGlobalProviderIds, summarizeAttemptMetrics } from "./benchmark-metrics.ts";
import type { RetrievalFixtureCase } from "./benchmark-metrics.ts";
import { parseNonNegativeSafeIntegerOption, parsePositiveSafeIntegerOption, readCliOption } from "./cli-options.ts";
import type { FeatureObservation } from "./observe.ts";
import { createMem0Memory } from "./memory/mem0/memory.ts";
import type { Mem0PlatformPort, Mem0SearchRequest } from "./memory/mem0/platform.ts";
import { selectFeatureScopedEvaluationMemory, selectMemory } from "./memory/select.ts";
import { encodeMemoryRetrieveQuery, MemoryBindingError, sharedMemoryPrompt } from "./memory/memory.ts";
import { locateWithRuntime, type LocateRuntimeChatClient } from "./locate-runtime.internal.ts";
import { executeMemoryRetrieve, type FeatureMemoryGroup } from "./tools/memory.ts";

test("experiment metrics use fixed fixture labels and compare feature-scoped with legacy global rare cue rates", () => {
  const fixture = [
    { featureKey: "visible_text", class: "rare" as const, expectedProviderIds: ["rare-sign-lesson"] },
    { featureKey: "road_surface", class: "broad" as const, expectedProviderIds: ["broad-road-lesson"] },
  ] satisfies readonly RetrievalFixtureCase[];
  const groups: FeatureMemoryGroup[] = [
    group({
      feature: { key: "visible_text", text: "small tunnel sign" },
      providerIds: ["rare-sign-lesson"],
    }),
    group({
      feature: { key: "road_surface", text: "broad paved road" },
      providerIds: ["broad-road-lesson"],
    }),
  ];

  const featureScoped = retrievalMetricsFromGroups(groups, fixture);
  const legacyGlobal = retrievalMetricsFromLegacyGlobalProviderIds(["broad-road-lesson"], fixture);
  const metrics = buildAttemptMetrics({
    attemptId: "attempt-metrics",
    observations: groups.map((item) => item.feature),
    memoryGroups: groups,
    episodes: [
      {
        attemptId: "attempt-metrics",
        featureKey: "visible_text",
        memoryHitId: groups[0]?.hits[0]?.memoryHitId ?? "",
        effect: "helped",
        reflectionStatus: "stored",
        lessonId: "lesson-helped",
      },
    ],
    events: [
      { attemptId: "attempt-metrics", phase: "retrieve", operation: "memory_retrieve", featureKey: "visible_text", memoryHitId: null, status: "hits", sequence: 1, memoryRef: "file" },
      { attemptId: "attempt-metrics", phase: "retrieve", operation: "memory_retrieve", featureKey: "road_surface", memoryHitId: null, status: "hits", sequence: 2, memoryRef: "file" },
    ],
    validOutput: true,
    latencyMs: 42,
    guess: { latitude: 1, longitude: 1, place: "nearby", confidence: 0.8, reasoning: "fixture", provider: "fake" },
    truth: { latitude: 1, longitude: 1 },
    fixture,
    legacyGlobalProviderIds: legacyGlobal[1]?.returnedProviderIds,
  });
  const summary = summarizeAttemptMetrics([metrics]);

  assert.deepEqual(featureScoped.map((item) => [item.featureKey, item.class, item.hit]), [
    ["visible_text", "rare", true],
    ["road_surface", "broad", true],
  ]);
  assert.deepEqual(legacyGlobal.map((item) => [item.featureKey, item.class, item.hit]), [
    ["visible_text", "rare", false],
    ["road_surface", "broad", true],
  ]);
  assert.equal(metrics.featureScopedRareCueHitRate, 1);
  assert.equal(metrics.legacyGlobalTopKRareCueHitRate, 0);
  assert.equal(metrics.rareCueHitRate, 1);
  assert.equal(metrics.broadCueHitRate, 1);
  assert.equal(metrics.geoscore, 5000);
  assert.equal(metrics.validOutput, true);
  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.latencyMs, 42);
  assert.equal(summary.featureScopedRareCueHitRate, 1);
  assert.equal(summary.legacyGlobalTopKRareCueHitRate, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(groups[0], "hints"), false);
});

test("benchmark toolCalls ignore no-memory bookkeeping events", () => {
  const metrics = buildAttemptMetrics({
    attemptId: "attempt-cold-metrics",
    observations: [],
    memoryGroups: [],
    episodes: [],
    events: [
      {
        attemptId: "attempt-cold-metrics",
        phase: "retrieve",
        operation: "memory_retrieve",
        featureKey: "road_surface",
        memoryHitId: null,
        status: "no_hit",
        sequence: 1,
        memoryRef: null,
      },
      {
        attemptId: "attempt-cold-metrics",
        phase: "retrieve",
        operation: "memory_retrieve",
        featureKey: "road_surface",
        memoryHitId: null,
        status: "hits",
        sequence: 2,
        memoryRef: "file",
      },
    ],
    validOutput: true,
    latencyMs: 1,
  });

  assert.equal(metrics.toolCalls, 1);
});

test("benchmark toolCalls count only successful provider-backed memory operations", () => {
  const event = (operation: "memory_retrieve" | "memory_store", status: string, memoryRef: string | null = "file") => ({
    attemptId: "attempt-call-metrics",
    phase: operation === "memory_retrieve" ? "retrieve" as const : "reflect" as const,
    operation,
    featureKey: "road_surface",
    memoryHitId: null,
    status,
    sequence: 1,
    memoryRef,
  });
  const metrics = buildAttemptMetrics({
    attemptId: "attempt-call-metrics",
    observations: [],
    memoryGroups: [],
    episodes: [],
    events: [
      event("memory_retrieve", "hits"),
      event("memory_retrieve", "no_hit"),
      event("memory_retrieve", "memory_error"),
      event("memory_retrieve", "budget_exhausted"),
      event("memory_retrieve", "no_hit", null),
      event("memory_store", "stored"),
      event("memory_store", "already_stored"),
      event("memory_store", "write_failed"),
    ],
    validOutput: true,
    latencyMs: 1,
  });

  assert.equal(metrics.toolCalls, 4);

  const ambiguous = buildAttemptMetrics({
    attemptId: "attempt-ambiguous-event",
    observations: [],
    memoryGroups: [],
    episodes: [],
    events: [{
      attemptId: "attempt-ambiguous-event",
      phase: "retrieve",
      operation: "memory_retrieve",
      featureKey: "road_surface",
      memoryHitId: null,
      status: "hits",
      sequence: 1,
    }],
    validOutput: true,
    latencyMs: 1,
  });
  assert.equal(ambiguous.toolCalls, 0);
});

test("benchmark fallback metrics ignore synthetic no-hit groups and preserve legacy recall calls", () => {
  const groupWithNoMemory: FeatureMemoryGroup = {
    attemptId: "attempt-cold-fallback",
    feature: { key: "road_surface", text: "paved road" },
    query: null,
    status: "no_hit",
    hits: [],
    failure: null,
    retryCount: 0,
  };
  assert.equal(buildAttemptMetrics({
    attemptId: "attempt-cold-fallback",
    observations: [groupWithNoMemory.feature],
    memoryGroups: [groupWithNoMemory],
    episodes: [],
    validOutput: true,
    latencyMs: 1,
  }).toolCalls, 0);
  assert.equal(buildAttemptMetrics({
    attemptId: "attempt-legacy-warm",
    observations: [],
    memoryGroups: [],
    episodes: [],
    successfulMemoryCalls: 1,
    validOutput: true,
    latencyMs: 1,
  }).toolCalls, 1);
});

test("legacy warm file selection rejects a missing snapshot before evaluation starts", async () => {
  await assert.rejects(
    selectMemory({ backend: "file", snapshotId: "ffffffffffff", recall: "top", snapshotMode: "legacy" }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_not_found",
  );
});

test("benchmark pair contract pins sample order cache key and explicit cold or warm mode", () => {
  assert.equal(parseBenchmarkMemoryMode("cold"), "cold");
  assert.equal(parseBenchmarkMemoryMode("warm"), "warm");
  assert.throws(() => parseBenchmarkMemoryMode("live"), /expected cold\|warm/);

  const contract = buildBenchmarkPairContract({
    sampleIds: ["img-1", "img-2"],
    sampleFingerprint: "abc123",
    manifestPath: "benchmark/samples/osv5m-v1-n200.txt",
    observationPromptVersion: "dynamic-features-v2",
    memoryMode: "cold",
  });

  assert.deepEqual(contract.control.sampleIds, ["img-1", "img-2"]);
  assert.deepEqual(contract.memoryOn.sampleIds, ["img-1", "img-2"]);
  assert.equal(contract.control.observationCacheKey, contract.memoryOn.observationCacheKey);
  assert.match(contract.observationCacheKey, /abc123:dynamic-features-v2:cold$/);
});

test("retrieval fixture loader requires fixed rare and broad provider ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loci-retrieval-fixture-"));
  const path = join(directory, "fixture.jsonl");
  try {
    await writeFile(
      path,
      [
        JSON.stringify({ featureKey: "visible_text", class: "rare", expectedProviderIds: ["rare-1"] }),
        JSON.stringify({ featureKey: "vegetation", class: "broad", expectedProviderIds: ["broad-1"] }),
      ].join("\n") + "\n",
      "utf8",
    );

    assert.deepEqual(await loadRetrievalFixture(path), [
      { featureKey: "visible_text", class: "rare", expectedProviderIds: ["rare-1"] },
      { featureKey: "vegetation", class: "broad", expectedProviderIds: ["broad-1"] },
    ]);
    await writeFile(path, "", "utf8");
    await assert.rejects(() => loadRetrievalFixture(path), /at least one retrieval fixture case/);
    await writeFile(
      path,
      JSON.stringify({ featureKey: "visible_text", class: "rare", expectedProviderIds: ["rare-1"] }) + "\n",
      "utf8",
    );
    await assert.rejects(() => loadRetrievalFixture(path), /at least one broad retrieval fixture case/);
    await writeFile(
      path,
      JSON.stringify({ featureKey: "vegetation", class: "broad", expectedProviderIds: ["broad-1"] }) + "\n",
      "utf8",
    );
    await assert.rejects(() => loadRetrievalFixture(path), /at least one rare retrieval fixture case/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("benchmark CLI numeric and memory-mode contracts fail fast", async () => {
  assert.equal(parsePositiveSafeIntegerOption("limit", "1"), 1);
  assert.equal(parsePositiveSafeIntegerOption("concurrency", "8"), 8);
  assert.equal(parseNonNegativeSafeIntegerOption("head", "0"), 0);
  assert.throws(() => parsePositiveSafeIntegerOption("limit", "-1"), /--limit must be a safe integer/);
  assert.throws(() => parsePositiveSafeIntegerOption("snapshot-every", "0"), /--snapshot-every must be a safe integer/);
  assert.throws(() => parseNonNegativeSafeIntegerOption("head", "-1"), /--head must be a safe integer/);
  for (const name of ["limit", "snapshot-every", "concurrency", "head", "size"]) {
    assert.throws(() => readCliOption(name, "fallback", ["node", "script.ts", `--${name}`]), new RegExp(`--${name} requires a value`));
  }
  assert.throws(
    () => readCliOption("concurrency", "8", ["node", "src/experiment.ts", "--concurrency", "--head", "10"]),
    /--concurrency requires a value/,
  );

  await assert.rejects(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "snapshot", recall: "off", memoryMode: "warm" }),
    /warm evaluation requires --recall top/,
  );
  await assert.rejects(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "", recall: "top", memoryMode: "warm" }),
    /warm evaluation requires --snapshot/,
  );
  await assert.rejects(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "", recall: "top", memoryMode: "cold" }),
    /cold evaluation requires --recall off/,
  );
});

test("feature-scoped warm evaluation rejects a missing snapshot before provider calls", async () => {
  let providerCalls = 0;
  const client: LocateRuntimeChatClient = {
    chat: {
      completions: {
        create: async () => {
          providerCalls += 1;
          return { choices: [{ message: { content: JSON.stringify({
            latitude: 1,
            longitude: 2,
            place: "should not run",
            confidence: 0.5,
            reasoning: "should not run",
          }) } }] };
        },
      },
    },
  };

  await assert.rejects(
    async () => {
      const selection = await selectFeatureScopedEvaluationMemory({
        backend: "file",
        snapshotId: "deadbeefdead",
        recall: "top",
        memoryMode: "warm",
      });
      await locateWithRuntime(
        { attemptId: "missing-snapshot", imagePath: "missing-snapshot.jpg" },
        {
          memoryBinding: selection.memoryBinding,
          run: selection.run,
          client,
          observe: async () => ({ features: [{ key: "road_surface", text: "paved road" }], error: null }),
          imageDataUri: async () => "data:image/jpeg;base64,AA==",
        },
      );
    },
    (error) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "memory_not_found",
  );
  assert.equal(providerCalls, 0);
});

test("experiment metadata reports requested and effective memory backends", () => {
  const metadataInput = {
    model: "model",
    seed: "seed",
    fingerprint: "fingerprint",
    sampleSize: 2,
    requestedMemoryBackend: "mem0",
    snapshotId: "",
    memoryFrozen: true,
    memoryMode: "cold",
    flow: "feature-scoped",
    observationCacheKey: "cache",
    recallMode: "off",
    twoStep: false,
    recallLimit: 5,
    retrievalFixturePath: "fixture.jsonl",
  } as const;
  const cold = buildBenchmarkExperimentMetadata(metadataInput);
  const warm = buildBenchmarkExperimentMetadata({
    ...metadataInput,
    requestedMemoryBackend: "file",
    snapshotId: "snapshot-1",
    memoryMode: "warm",
    recallMode: "top",
  });

  assert.equal(cold.memoryBackend, "mem0");
  assert.equal(cold.requestedMemoryBackend, "mem0");
  assert.equal(cold.effectiveMemoryBackend, "off");
  assert.equal(cold.memorySnapshot, "none");
  assert.equal(warm.requestedMemoryBackend, "file");
  assert.equal(warm.effectiveMemoryBackend, "file");
  assert.equal(warm.memorySnapshot, "snapshot-1");
});

test("FileMemory and Mem0 readers both enter feature-scoped retrieval through the dispatcher", async () => {
  const fileReader = {
    recallCalls: [] as Array<{ query: string; limit: number }>,
    async recall(query: string, limit: number) {
      this.recallCalls.push({ query, limit });
      return [{ lessonId: "file-provider-id", text: "file lesson" }];
    },
  };
  const mem0Platform = new Mem0PlatformSpy([
    { id: "mem0-provider-id", memory: "mem0 lesson", metadata: { loci_feature_key: "poles", loci_effect: "helped" } },
  ]);
  const mem0 = createMem0Memory(
    { snapshots: false },
    { apiKey: "key", agentId: "agent", ingestionTimeoutMs: 1000, pollIntervalMs: 1 },
    { platform: mem0Platform },
  ).asReadOnlyReader();

  const fileResult = await executeMemoryRetrieve(
    {
      attemptId: "attempt-file",
      reader: fileReader,
      phase: "retrieve",
      run: { memoryRef: "file", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      activeFeature: { key: "poles", text: "wooden poles" },
    },
    { feature_key: "poles", query: "wooden poles" },
  );
  const mem0Result = await executeMemoryRetrieve(
    {
      attemptId: "attempt-mem0",
      reader: mem0,
      phase: "retrieve",
      run: { memoryRef: "file", mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      activeFeature: { key: "poles", text: "wooden poles" },
    },
    { feature_key: "poles", query: "wooden poles" },
  );

  assert.equal(fileResult.hits[0]?.providerId, "file-provider-id");
  assert.equal(mem0Result.hits[0]?.providerId, "mem0-provider-id");
  assert.deepEqual(fileReader.recallCalls, [{ query: "wooden poles", limit: 5 }]);
  assert.deepEqual(mem0Platform.searchInvocations, [
    {
      query: encodeMemoryRetrieveQuery(sharedMemoryPrompt("retrieve"), "wooden poles"),
      filters: { agent_id: "agent" },
      topK: 5,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    },
  ]);
});

function group(input: { feature: FeatureObservation; providerIds: string[] }): FeatureMemoryGroup {
  return {
    attemptId: "attempt-metrics",
    feature: input.feature,
    query: input.feature.text,
    status: "hits",
    hits: input.providerIds.map((providerId, index) => ({
      attemptId: "attempt-metrics",
      featureKey: input.feature.key,
      memoryHitId: `attempt-metrics/${input.feature.key}/${index}`,
      providerId,
      text: `${providerId} text`,
      score: null,
      effect: null,
    })),
    failure: null,
    retryCount: 0,
  };
}

class Mem0PlatformSpy implements Mem0PlatformPort {
  readonly searchInvocations: Mem0SearchRequest[] = [];
  private readonly records: Awaited<ReturnType<Mem0PlatformPort["search"]>>;

  constructor(records: Awaited<ReturnType<Mem0PlatformPort["search"]>>) {
    this.records = records;
  }

  async add(): Promise<{ eventId: string; status: "PENDING" }> {
    throw new Error("add should not be called");
  }

  async getEvent(): Promise<{ eventId: string; status: "SUCCEEDED"; memoryIds: string[] }> {
    throw new Error("getEvent should not be called");
  }

  async get(): Promise<null> {
    throw new Error("get should not be called");
  }

  async list(): Promise<[]> {
    throw new Error("list should not be called");
  }

  async search(request: Mem0SearchRequest): Promise<Awaited<ReturnType<Mem0PlatformPort["search"]>>> {
    this.searchInvocations.push(request);
    return this.records;
  }
}
