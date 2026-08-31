import type { Guess } from "./agent.ts";
import { FEATURE_KEYS, type FeatureKey, type FeatureObservation } from "./observe.ts";
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
  validOutput: boolean;
  latencyMs: number;
  guess?: Guess;
  truth?: { latitude: number; longitude: number };
  fixture?: readonly RetrievalFixtureCase[];
  legacyGlobalProviderIds?: readonly string[];
};

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
    input.fixture === undefined || input.legacyGlobalProviderIds === undefined
      ? []
      : retrievalMetricsFromLegacyGlobalProviderIds(input.legacyGlobalProviderIds, input.fixture);
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
    visibleFeatures: input.observations.filter((feature) => feature.state === "visible").length,
    retrievalOutcomes: input.memoryGroups.length,
    memoryHits: input.memoryGroups.reduce((sum, group) => sum + group.hits.length, 0),
    episodesByEffect,
    rareCueHitRate: hitRate(featureScopedMetrics, "rare"),
    broadCueHitRate: hitRate(featureScopedMetrics, "broad"),
    legacyGlobalTopKRareCueHitRate: hitRate(legacyMetrics, "rare"),
    featureScopedRareCueHitRate: hitRate(featureScopedMetrics, "rare"),
    geoscore,
    validOutput: input.validOutput,
    toolCalls: input.events?.length ?? input.memoryGroups.length + input.episodes.length,
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

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const MAX_FEATURE_SCOPED_FEATURES = FEATURE_KEYS.length;
