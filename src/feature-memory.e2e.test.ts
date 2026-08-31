import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { geoEvaluators } from "./evaluators.ts";
import { FEATURE_KEYS, type FeatureObservation } from "./observe.ts";
import type { Guess } from "./agent.ts";
import type { RetrievalFixtureCase } from "./benchmark-metrics.ts";
import type { Hint, LegacyMemory, LegacyLessonInput, MemoryWriteResult } from "./memory/memory.ts";
import { executeMemoryRetrieve, executeMemoryStore, makeMemoryHitId, type FeatureMemoryGroup, type LocateResult, type MemoryHit, type ToolEvent } from "./tools/memory.ts";
import type { ReflectEpisodeFunction } from "./task-feature-scoped.internal.ts";
import { runTrainingTaskWithRuntime, runTaskWithRuntime } from "./task-runtime.internal.ts";

const memoryDir = await mkdtemp(join(tmpdir(), "loci-feature-memory-e2e-"));
process.env.MEMORY_DIR = memoryDir;
const { FileMemory, FrozenMemory } = await import("./memory/file/memory.ts");

test.after(async () => rm(memoryDir, { recursive: true, force: true }));

test("twelve-feature mixed-failure attempt preserves cardinality budgets duplicate store and frozen read-only evaluation", async () => {
  const attemptId = "attempt-e2e";
  const groups = makeTwelveFeatureGroups(attemptId);
  const events = groups.map((group, index): ToolEvent => ({
    attemptId,
    phase: "retrieve",
    operation: "memory_retrieve",
    featureKey: group.feature.key,
    memoryHitId: null,
    status: group.status === "failed" ? group.failure ?? "failed" : group.status,
    sequence: index + 1,
  }));
  const locateResult: LocateResult = {
    attemptId,
    guess: guess(),
    observations: groups.map((group) => group.feature),
    memoryGroups: groups,
    episodes: [],
    trace: { attemptId, groups, episodes: [], events },
  };
  const retrievalFixture = [
    { featureKey: "visible_text", class: "rare", expectedProviderIds: ["visible_text-provider-0"] },
    { featureKey: "road_surface", class: "broad", expectedProviderIds: ["road_surface-provider-0"] },
  ] satisfies readonly RetrievalFixtureCase[];
  const legacyGlobalMemory = new LegacyGlobalMemorySpy([
    { lessonId: "road_surface-provider-0", text: "legacy global road surface prior" },
  ]);
  const memory = new FileMemory(join(memoryDir, "live.jsonl"), "top", false);
  let duplicateStatus: string | null = null;
  let reflectionCalls = 0;
  const reflectEpisode: ReflectEpisodeFunction = async (input, deps) => {
    reflectionCalls += 1;
    const args = {
      feature_key: input.feature.key,
      memory_hit_id: input.memoryHit.memoryHitId,
      effect: reflectionCalls % 4 === 0 ? "misleading" : "helped",
      content: `Lesson ${reflectionCalls} stays grounded in ${input.feature.key}.`,
      triggers: [input.feature.text],
      region: input.truth.country,
    } as const;
    const context = {
      attemptId: input.attemptId,
      reader: deps.writer,
      writer: deps.writer,
      phase: "reflect" as const,
      run: deps.run,
      activeFeature: input.feature,
      activeMemoryHit: input.memoryHit,
    };
    const result = await executeMemoryStore(context, args);
    if (reflectionCalls === 1) {
      duplicateStatus = (await executeMemoryStore(context, args)).status;
    }
    switch (result.status) {
      case "stored":
      case "already_stored":
        return { status: result.status, effect: args.effect, lessonId: result.lessonId, failure: null };
      case "write_failed":
      case "write_outcome_unknown":
        return { status: result.status, effect: args.effect, lessonId: null, failure: result.failure };
    }
  };

  const result = await runTrainingTaskWithRuntime(
    {
      imageId: "image-e2e",
      imagePath: "image-e2e.jpg",
      attemptId,
      truth: { latitude: 1, longitude: 2, country: "BR" },
    },
    {
      memory,
      writer: memory,
      run: { mode: "training", snapshotId: null, readOnly: false, recallLimit: 5 },
      locate: async () => locateResult,
      reflectEpisode,
      benchmark: { retrievalFixture, legacyGlobalMemory },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.memoryGroups.length, FEATURE_KEYS.length);
  assert.deepEqual(result.memoryGroups.map((group) => group.feature.key), FEATURE_KEYS);
  assert.equal(result.memoryGroups.filter((group) => group.status === "failed").length, 1);
  assert.equal(result.memoryGroups.filter((group) => group.status === "no_hit").length, 1);
  assert.equal(Math.max(...result.memoryGroups.map((group) => group.hits.length)), 5);
  assert.equal(result.attemptMetrics.retrievalOutcomes, 12);
  assert.equal(result.attemptMetrics.memoryHits, 50);
  assert.equal(result.episodes.length, 50);
  assert.equal(result.attemptMetrics.episodesByEffect.helped, 38);
  assert.equal(result.attemptMetrics.episodesByEffect.misleading, 12);
  assert.equal(result.attemptMetrics.rareCueHitRate, 1);
  assert.equal(result.attemptMetrics.broadCueHitRate, 1);
  assert.equal(result.attemptMetrics.featureScopedRareCueHitRate, 1);
  assert.equal(result.attemptMetrics.legacyGlobalTopKRareCueHitRate, 0);
  assert.equal(result.attemptMetrics.geoscore, 5000);
  assert.deepEqual(legacyGlobalMemory.invocations, [
    { features: groups.map((group) => group.feature.text), limit: 5 },
  ]);
  assert.equal(await evaluatorScore("rare_cue_hit_rate", result), 1);
  assert.equal(await evaluatorScore("broad_cue_hit_rate", result), 1);
  assert.equal(await evaluatorScore("legacy_global_topk_rare_cue_hit_rate", result), 0);
  assert.equal(await evaluatorScore("feature_scoped_rare_cue_hit_rate", result), 1);
  assert.equal(await evaluatorScore("geoscore", result, { latitude: 1, longitude: 2, country: "BR" }), 5000);
  assert.equal(await evaluatorScore("episodes_helped", result), 38);
  assert.equal(reflectionCalls, 50);
  assert.equal(duplicateStatus, "already_stored");
  assert.equal(await memory.size(), 50);

  const retrievalEvents = result.trace?.events.filter((event) => event.operation === "memory_retrieve") ?? [];
  const storeEvents = result.trace?.events.filter((event) => event.operation === "memory_store") ?? [];
  assert.equal(retrievalEvents.length, 12);
  assert.equal(storeEvents.length, 50);
  assert.ok(retrievalEvents.length <= 24);
  assert.ok(result.attemptMetrics.memoryHits <= 60);
  assert.ok(result.episodes.length <= 60);
  assert.ok(storeEvents.length <= 60);
  assert.equal(Object.prototype.hasOwnProperty.call(result.memoryGroups[2], "hints"), false);

  const snapshotId = await memory.snapshot();
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  const beforeRecall = await readFile(snapshotPath, "utf8");
  const frozen = new FrozenMemory(snapshotId, "top");
  const evalGroup = await executeMemoryRetrieve(
    {
      attemptId: "attempt-eval",
      reader: frozen,
      phase: "retrieve",
      run: { mode: "evaluation", snapshotId, readOnly: true, recallLimit: 5 },
      activeFeature: { key: "poles", state: "visible", text: "poles cue 2" },
    },
    { feature_key: "poles", query: "poles cue 2" },
  );
  assert.equal(evalGroup.status, "hits");
  assert.equal(await readFile(snapshotPath, "utf8"), beforeRecall);
  await assert.rejects(
    () =>
      executeMemoryStore(
        {
          attemptId: "attempt-eval",
          reader: frozen,
          writer: frozen,
          phase: "reflect",
          run: { mode: "evaluation", snapshotId, readOnly: true, recallLimit: 5 },
          activeFeature: { key: "poles", state: "visible", text: "poles cue 2" },
          activeMemoryHit: evalGroup.hits[0],
        },
        {
          feature_key: "poles",
          memory_hit_id: evalGroup.hits[0]?.memoryHitId ?? "",
          effect: "helped",
          content: "Evaluation must not store this lesson.",
          triggers: ["poles cue 2"],
          region: "BR",
        },
      ),
    /memory_store is not enabled/,
  );

  const evalResult = await runTaskWithRuntime(
    { imageId: "image-eval", imagePath: "image-eval.jpg", attemptId: "attempt-eval-readonly" },
    {
      memory: frozen,
      run: { mode: "evaluation", snapshotId, readOnly: true, recallLimit: 5 },
      locate: async (_input, deps) => {
        assert.equal("remember" in deps.memory, false);
        return {
          attemptId: "attempt-eval-readonly",
          guess: guess(),
          observations: [],
          memoryGroups: [],
          episodes: [],
          trace: { attemptId: "attempt-eval-readonly", groups: [], episodes: [], events: [] },
        };
      },
    },
  );
  assert.equal(evalResult.ok, true);
});

function makeTwelveFeatureGroups(attemptId: string): FeatureMemoryGroup[] {
  return FEATURE_KEYS.map((featureKey, index): FeatureMemoryGroup => {
    const feature: FeatureObservation = {
      key: featureKey,
      state: "visible",
      text: `${featureKey} cue ${index}`,
    };
    if (index === 0) {
      return { attemptId, feature, query: `${featureKey} query`, status: "failed", hits: [], failure: "memory_error" };
    }
    if (index === 1) {
      return { attemptId, feature, query: `${featureKey} query`, status: "no_hit", hits: [], failure: null };
    }
    const hits = Array.from({ length: 5 }, (_value, hitIndex): MemoryHit => {
      const providerId = `${featureKey}-provider-${hitIndex}`;
      const text = `${featureKey} lesson ${hitIndex}`;
      return {
        attemptId,
        featureKey,
        memoryHitId: makeMemoryHitId(attemptId, featureKey, providerId, text, hitIndex),
        providerId,
        text,
        score: null,
        effect: null,
      };
    });
    return { attemptId, feature, query: `${featureKey} query`, status: "hits", hits, failure: null };
  });
}

async function evaluatorScore(name: string, output: unknown, expected?: unknown): Promise<number | null> {
  const evaluator = geoEvaluators.find((item) => item.name === name);
  if (evaluator === undefined) assert.fail(`missing evaluator ${name}`);
  const result = await evaluator.evaluate({ output, expected } as Parameters<typeof evaluator.evaluate>[0]);
  return result.score ?? null;
}

class LegacyGlobalMemorySpy implements LegacyMemory {
  readonly invocations: Array<{ features: string[]; limit?: number }> = [];
  private readonly hints: Hint[];

  constructor(hints: Hint[]) {
    this.hints = hints;
  }

  async recall(features: string[], limit?: number): Promise<Hint[]> {
    this.invocations.push({ features: [...features], limit });
    return this.hints.slice(0, limit);
  }

  async remember(_lesson: LegacyLessonInput): Promise<MemoryWriteResult> {
    throw new Error("legacy benchmark control must not write");
  }

  async snapshot(): Promise<string> {
    return "legacy-global";
  }

  async restore(): Promise<void> {}
}

function guess(): Guess {
  return {
    latitude: 1,
    longitude: 2,
    place: "Fixture",
    confidence: 0.8,
    reasoning: "Fixture guess",
    provider: "fake",
  };
}
