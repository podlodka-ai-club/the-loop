import { readFile } from "node:fs/promises";
import type { Guess } from "./agent.ts";
import { isNormalizedFeatureKey, MAX_FEATURES, type FeatureKey, type FeatureObservation } from "./observe.ts";
import { geoScore, haversineKm } from "./geo.ts";
import type {
  AttemptMetrics,
  EpisodeTrace,
  FeatureMemoryGroup,
  RetrievalMetric,
  ToolEvent,
} from "./tools/memory.ts";

export type BenchmarkMemoryMode = "cold" | "warm";

export type RetrievalFixtureCase = {
  featureKey: FeatureKey;
  class: "rare" | "broad";
  expectedProviderIds: readonly string[];
};

export const DEFAULT_RETRIEVAL_FIXTURE = "benchmark/samples/feature-memory-retrieval-fixture.jsonl";

export type BenchmarkPairContract = {
  sampleIds: string[];
  sampleFingerprint: string;
  observationCacheKey: string;
  memoryMode: BenchmarkMemoryMode;
  control: { sampleIds: string[]; observationCacheKey: string };
  memoryOn: { sampleIds: string[]; observationCacheKey: string };
};

export type AttemptMetricsInput = {
  attemptId: string;
  observations: readonly FeatureObservation[];
  memoryGroups: readonly FeatureMemoryGroup[];
  episodes: readonly EpisodeTrace[];
  events?: readonly ToolEvent[];
  /** Successful legacy recall/store operations when no dynamic events exist. */
  successfulMemoryCalls?: number;
  validOutput: boolean;
  latencyMs: number;
  guess?: Guess;
  truth?: { latitude: number; longitude: number };
  fixture?: readonly RetrievalFixtureCase[];
  legacyGlobalProviderIds?: readonly string[];
};

function isSuccessfulMemoryToolEvent(event: ToolEvent): boolean {
  // A provider-backed call must carry an explicit binding reference. Both
  // `null` and the legacy omitted field are bookkeeping/ambiguous events and
  // must not inflate the memory-call metric.
  if (typeof event.memoryRef !== "string" || event.memoryRef.trim() === "") return false;
  if (event.operation === "memory_retrieve") {
    return event.status === "hits" || event.status === "no_hit";
  }
  if (event.operation === "memory_store") {
    return event.status === "stored" || event.status === "already_stored";
  }
  return false;
}

function successfulMemoryCallsWithoutEvents(input: AttemptMetricsInput): number {
  // Without events there is no binding provenance to distinguish a real
  // provider operation from synthetic/no-memory groups. Legacy callers must
  // opt in with the explicit successful call count.
  return input.successfulMemoryCalls ?? 0;
}

export type BenchmarkExperimentMetadata = {
  model: string;
  seed: string;
  fingerprint: string;
  sampleSize: number;
  memoryBackend: string;
  requestedMemoryBackend: string;
  effectiveMemoryBackend: string;
  memorySnapshot: string;
  memoryFrozen: boolean;
  memoryMode: BenchmarkMemoryMode;
  flow: string;
  observationCacheKey: string;
  recallMode: string;
  twoStep: boolean;
  recallLimit: number;
  retrievalFixture: string;
};

export async function loadRetrievalFixture(
  path = DEFAULT_RETRIEVAL_FIXTURE,
): Promise<RetrievalFixtureCase[]> {
  const body = await readFile(path, "utf8");
  const cases: RetrievalFixtureCase[] = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    cases.push(parseRetrievalFixtureCase(parsed, `${path}:${index + 1}`));
  }
  if (cases.length === 0) throw new Error(`${path} must contain at least one retrieval fixture case`);
  if (!cases.some((item) => item.class === "rare")) {
    throw new Error(`${path} must contain at least one rare retrieval fixture case`);
  }
  if (!cases.some((item) => item.class === "broad")) {
    throw new Error(`${path} must contain at least one broad retrieval fixture case`);
  }
  return cases;
}

export type AttemptMetricsSummary = {
  attempts: number;
  geoscore: number | null;
  validOutputRate: number | null;
  featureScopedRareCueHitRate: number | null;
  legacyGlobalTopKRareCueHitRate: number | null;
  rareCueHitRate: number | null;
  broadCueHitRate: number | null;
  toolCalls: number | null;
  latencyMs: number | null;
};

export function parseBenchmarkMemoryMode(value: string): BenchmarkMemoryMode {
  if (value === "cold" || value === "warm") return value;
  throw new Error(`unknown memory mode "${value}", expected cold|warm`);
}

export function buildBenchmarkPairContract(input: {
  sampleIds: readonly string[];
  sampleFingerprint: string;
  manifestPath: string;
  observationPromptVersion: string;
  memoryMode: BenchmarkMemoryMode;
}): BenchmarkPairContract {
  const sampleIds = [...input.sampleIds];
  const observationCacheKey = [
    input.manifestPath,
    input.sampleFingerprint,
    input.observationPromptVersion,
    input.memoryMode,
  ].join(":");
  return {
    sampleIds,
    sampleFingerprint: input.sampleFingerprint,
    observationCacheKey,
    memoryMode: input.memoryMode,
    control: { sampleIds: [...sampleIds], observationCacheKey },
    memoryOn: { sampleIds: [...sampleIds], observationCacheKey },
  };
}

export function buildBenchmarkExperimentMetadata(input: {
  model: string;
  seed: string;
  fingerprint: string;
  sampleSize: number;
  requestedMemoryBackend: string;
  snapshotId: string;
  memoryFrozen: boolean;
  memoryMode: BenchmarkMemoryMode;
  flow: string;
  observationCacheKey: string;
  recallMode: string;
  twoStep: boolean;
  recallLimit: number;
  retrievalFixturePath: string;
}): BenchmarkExperimentMetadata {
  const effectiveMemoryBackend = input.memoryMode === "cold" ? "off" : input.requestedMemoryBackend;
  return {
    model: input.model,
    seed: input.seed,
    fingerprint: input.fingerprint,
    sampleSize: input.sampleSize,
    memoryBackend: input.requestedMemoryBackend,
    requestedMemoryBackend: input.requestedMemoryBackend,
    effectiveMemoryBackend,
    memorySnapshot: input.snapshotId === "" ? "none" : input.snapshotId,
    memoryFrozen: input.memoryFrozen,
    memoryMode: input.memoryMode,
    flow: input.flow,
    observationCacheKey: input.observationCacheKey,
    recallMode: input.recallMode,
    twoStep: input.twoStep,
    recallLimit: input.recallLimit,
    retrievalFixture: input.retrievalFixturePath,
  };
}

export function retrievalMetricsFromGroups(
  groups: readonly FeatureMemoryGroup[],
  fixture: readonly RetrievalFixtureCase[],
): RetrievalMetric[] {
  const byFeature = new Map(groups.map((group) => [group.feature.key, group]));
  return fixture.map((item) => {
    const returnedProviderIds = (byFeature.get(item.featureKey)?.hits ?? [])
      .map((hit) => hit.providerId)
      .filter((id): id is string => id !== null);
    return retrievalMetric(item, returnedProviderIds);
  });
}

export function retrievalMetricsFromLegacyGlobalProviderIds(
  providerIds: readonly string[],
  fixture: readonly RetrievalFixtureCase[],
): RetrievalMetric[] {
  return fixture.map((item) => retrievalMetric(item, providerIds));
}

export function hitRate(
  metrics: readonly RetrievalMetric[],
  cueClass: "rare" | "broad",
): number | null {
  const scoped = metrics.filter((metric) => metric.class === cueClass);
  if (scoped.length === 0) return null;
  return scoped.filter((metric) => metric.hit).length / scoped.length;
}

export function buildAttemptMetrics(input: AttemptMetricsInput): AttemptMetrics {
  const featureScopedMetrics =
    input.fixture === undefined ? [] : retrievalMetricsFromGroups(input.memoryGroups, input.fixture);
  const legacyMetrics =
    input.fixture === undefined
      ? []
      : retrievalMetricsFromLegacyGlobalProviderIds(input.legacyGlobalProviderIds ?? [], input.fixture);
  const episodesByEffect = {
    helped: 0,
    irrelevant: 0,
    misleading: 0,
    insufficient: 0,
  };
  for (const episode of input.episodes) {
    if (episode.effect !== null) episodesByEffect[episode.effect] += 1;
  }
  const geoscore =
    input.validOutput && input.guess !== undefined && input.truth !== undefined
      ? geoScore(haversineKm(input.guess, input.truth))
      : null;
  return {
    attemptId: input.attemptId,
    visibleFeatures: input.observations.length,
    retrievalOutcomes: input.memoryGroups.length,
    memoryHits: input.memoryGroups.reduce((sum, group) => sum + group.hits.length, 0),
    episodesByEffect,
    rareCueHitRate: hitRate(featureScopedMetrics, "rare"),
    broadCueHitRate: hitRate(featureScopedMetrics, "broad"),
    legacyGlobalTopKRareCueHitRate: hitRate(legacyMetrics, "rare"),
    featureScopedRareCueHitRate: hitRate(featureScopedMetrics, "rare"),
    geoscore,
    validOutput: input.validOutput,
    // Count only successful provider-backed memory operations. Failed retries,
    // budget outcomes and `memoryRef: null` synthetic events are bookkeeping,
    // not successful memory calls.
    toolCalls: input.events === undefined
      ? successfulMemoryCallsWithoutEvents(input)
      : input.events.filter(isSuccessfulMemoryToolEvent).length,
    latencyMs: Math.max(0, Math.floor(input.latencyMs)),
  };
}

export function summarizeAttemptMetrics(metrics: readonly AttemptMetrics[]): AttemptMetricsSummary {
  return {
    attempts: metrics.length,
    geoscore: mean(metrics.map((metric) => metric.geoscore).filter(isNumber)),
    validOutputRate: mean(metrics.map((metric) => (metric.validOutput ? 1 : 0))),
    featureScopedRareCueHitRate: mean(metrics.map((metric) => metric.featureScopedRareCueHitRate).filter(isNumber)),
    legacyGlobalTopKRareCueHitRate: mean(metrics.map((metric) => metric.legacyGlobalTopKRareCueHitRate).filter(isNumber)),
    rareCueHitRate: mean(metrics.map((metric) => metric.rareCueHitRate).filter(isNumber)),
    broadCueHitRate: mean(metrics.map((metric) => metric.broadCueHitRate).filter(isNumber)),
    toolCalls: mean(metrics.map((metric) => metric.toolCalls)),
    latencyMs: mean(metrics.map((metric) => metric.latencyMs)),
  };
}

function retrievalMetric(
  item: RetrievalFixtureCase,
  returnedProviderIds: readonly string[],
): RetrievalMetric {
  const expectedProviderIds = [...item.expectedProviderIds];
  const returned = [...returnedProviderIds];
  return {
    featureKey: item.featureKey,
    class: item.class,
    expectedProviderIds,
    returnedProviderIds: returned,
    hit: expectedProviderIds.some((id) => returned.includes(id)),
  };
}

function parseRetrievalFixtureCase(value: unknown, source: string): RetrievalFixtureCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const featureKey = record.featureKey;
  const cueClass = record.class;
  const expectedProviderIds = record.expectedProviderIds;
  if (!isNormalizedFeatureKey(featureKey)) {
    throw new Error(`${source}.featureKey must be a normalized dynamic feature key`);
  }
  if (cueClass !== "rare" && cueClass !== "broad") {
    throw new Error(`${source}.class must be rare|broad`);
  }
  if (
    !Array.isArray(expectedProviderIds) ||
    expectedProviderIds.length === 0 ||
    expectedProviderIds.some((id) => typeof id !== "string" || id.trim() === "")
  ) {
    throw new Error(`${source}.expectedProviderIds must be a non-empty string array`);
  }
  return {
    featureKey: featureKey as FeatureKey,
    class: cueClass,
    expectedProviderIds: expectedProviderIds.map((id) => id.trim()),
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const MAX_FEATURE_SCOPED_FEATURES = MAX_FEATURES;
