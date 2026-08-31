import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBenchmarkPairContract, buildAttemptMetrics, loadRetrievalFixture, parseBenchmarkMemoryMode, retrievalMetricsFromGroups, retrievalMetricsFromLegacyGlobalProviderIds, summarizeAttemptMetrics } from "./benchmark-metrics.ts";
import type { RetrievalFixtureCase } from "./benchmark-metrics.ts";
import { parseNonNegativeSafeIntegerOption, parsePositiveSafeIntegerOption } from "./cli-options.ts";
import type { FeatureObservation } from "./observe.ts";
import { createMem0Memory } from "./memory/mem0/memory.ts";
import type { Mem0PlatformPort, Mem0SearchRequest } from "./memory/mem0/platform.ts";
import { selectFeatureScopedEvaluationMemory } from "./memory/select.ts";
import { executeMemoryRetrieve, type FeatureMemoryGroup } from "./tools/memory.ts";

test("experiment metrics use fixed fixture labels and compare feature-scoped with legacy global rare cue rates", () => {
  const fixture = [
    { featureKey: "visible_text", class: "rare" as const, expectedProviderIds: ["rare-sign-lesson"] },
    { featureKey: "road_surface", class: "broad" as const, expectedProviderIds: ["broad-road-lesson"] },
  ] satisfies readonly RetrievalFixtureCase[];
  const groups: FeatureMemoryGroup[] = [
    group({
      feature: { key: "visible_text", state: "visible", text: "small tunnel sign" },
      providerIds: ["rare-sign-lesson"],
    }),
    group({
      feature: { key: "road_surface", state: "visible", text: "broad paved road" },
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
      { attemptId: "attempt-metrics", phase: "retrieve", operation: "memory_retrieve", featureKey: "visible_text", memoryHitId: null, status: "hits", sequence: 1 },
      { attemptId: "attempt-metrics", phase: "retrieve", operation: "memory_retrieve", featureKey: "road_surface", memoryHitId: null, status: "hits", sequence: 2 },
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

test("benchmark pair contract pins sample order cache key and explicit cold or warm mode", () => {
  assert.equal(parseBenchmarkMemoryMode("cold"), "cold");
  assert.equal(parseBenchmarkMemoryMode("warm"), "warm");
  assert.throws(() => parseBenchmarkMemoryMode("live"), /expected cold\|warm/);

  const contract = buildBenchmarkPairContract({
    sampleIds: ["img-1", "img-2"],
    sampleFingerprint: "abc123",
    manifestPath: "benchmark/samples/osv5m-v1-n200.txt",
    observationPromptVersion: "observe-v1",
    memoryMode: "cold",
  });

  assert.deepEqual(contract.control.sampleIds, ["img-1", "img-2"]);
  assert.deepEqual(contract.memoryOn.sampleIds, ["img-1", "img-2"]);
  assert.equal(contract.control.observationCacheKey, contract.memoryOn.observationCacheKey);
  assert.match(contract.observationCacheKey, /abc123:observe-v1:cold$/);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("benchmark CLI numeric and memory-mode contracts fail fast", () => {
  assert.equal(parsePositiveSafeIntegerOption("limit", "1"), 1);
  assert.equal(parsePositiveSafeIntegerOption("concurrency", "8"), 8);
  assert.equal(parseNonNegativeSafeIntegerOption("head", "0"), 0);
  assert.throws(() => parsePositiveSafeIntegerOption("limit", "-1"), /--limit must be a safe integer/);
  assert.throws(() => parsePositiveSafeIntegerOption("snapshot-every", "0"), /--snapshot-every must be a safe integer/);
  assert.throws(() => parseNonNegativeSafeIntegerOption("head", "-1"), /--head must be a safe integer/);

  assert.throws(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "snapshot", recall: "off", memoryMode: "warm" }),
    /warm evaluation requires --recall top/,
  );
  assert.throws(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "", recall: "top", memoryMode: "warm" }),
    /warm evaluation requires --snapshot/,
  );
  assert.throws(
    () => selectFeatureScopedEvaluationMemory({ backend: "file", snapshotId: "", recall: "top", memoryMode: "cold" }),
    /cold evaluation requires --recall off/,
  );
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
      run: { mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      activeFeature: { key: "poles", state: "visible", text: "wooden poles" },
    },
    { feature_key: "poles", query: "wooden poles" },
  );
  const mem0Result = await executeMemoryRetrieve(
    {
      attemptId: "attempt-mem0",
      reader: mem0,
      phase: "retrieve",
      run: { mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
      activeFeature: { key: "poles", state: "visible", text: "wooden poles" },
    },
    { feature_key: "poles", query: "wooden poles" },
  );

  assert.equal(fileResult.hits[0]?.providerId, "file-provider-id");
  assert.equal(mem0Result.hits[0]?.providerId, "mem0-provider-id");
  assert.deepEqual(fileReader.recallCalls, [{ query: "wooden poles", limit: 5 }]);
  assert.deepEqual(mem0Platform.searchInvocations, [
    {
      query: "wooden poles",
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
