import { FEATURE_KEYS } from "../observe.ts";
import type { FeatureKey } from "../observe.ts";
import type { ReflectionEffect } from "../memory/memory.ts";
import {
  MemoryToolValidationError,
  makeMemoryHitId,
  type FeatureMemoryGroup,
  type RetrievalFailure,
} from "./memory.ts";

export type EpisodeCandidate = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
};

const REFLECTION_EFFECTS: readonly ReflectionEffect[] = [
  "helped",
  "irrelevant",
  "misleading",
  "insufficient",
];
const RETRIEVAL_FAILURES: readonly RetrievalFailure[] = [
  "invalid_tool_arguments",
  "wrong_feature",
  "missing_tool_call",
  "multiple_tool_calls",
  "malformed_tool_json",
  "memory_error",
  "timeout",
  "budget_exhausted",
  "skipped",
];

function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

function isReflectionEffect(value: unknown): value is ReflectionEffect {
  return typeof value === "string" && (REFLECTION_EFFECTS as readonly string[]).includes(value);
}

function isRetrievalFailure(value: unknown): value is RetrievalFailure {
  return typeof value === "string" && (RETRIEVAL_FAILURES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectForeignHit(): never {
  throw new MemoryToolValidationError("foreign_hit");
}

function validateExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) rejectForeignHit();
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) rejectForeignHit();
  }
}

function validateQueryForStatus(status: unknown, query: unknown): void {
  if (status === "hits" || status === "no_hit") {
    if (typeof query !== "string" || query.trim() === "" || query.length > 512) rejectForeignHit();
    return;
  }
  if (query !== null && (typeof query !== "string" || query.trim() === "" || query.length > 512)) {
    rejectForeignHit();
  }
}

export function episodeCandidatesFromGroups(
  attemptId: string,
  groups: readonly FeatureMemoryGroup[],
): EpisodeCandidate[] {
  if (!Array.isArray(groups) || groups.length > FEATURE_KEYS.length) rejectForeignHit();

  const candidates: EpisodeCandidate[] = [];
  const seenHits = new Set<string>();
  const seenFeatures = new Set<FeatureKey>();
  let previousFeatureIndex = -1;
  let totalHits = 0;

  for (const rawGroup of groups) {
    if (!isRecord(rawGroup)) rejectForeignHit();
    validateExactKeys(rawGroup, ["attemptId", "feature", "query", "status", "hits", "failure"]);
    if (rawGroup.attemptId !== attemptId) rejectForeignHit();
    validateQueryForStatus(rawGroup.status, rawGroup.query);

    const rawFeature = rawGroup.feature;
    if (!isRecord(rawFeature)) rejectForeignHit();
    validateExactKeys(rawFeature, ["key", "state", "text"]);
    if (!isFeatureKey(rawFeature.key)) rejectForeignHit();
    if (rawFeature.state !== "visible" && rawFeature.state !== "not_visible") rejectForeignHit();
    if (typeof rawFeature.text !== "string") rejectForeignHit();
    if (seenFeatures.has(rawFeature.key)) rejectForeignHit();
    seenFeatures.add(rawFeature.key);
    const featureIndex = FEATURE_KEYS.indexOf(rawFeature.key);
    if (featureIndex <= previousFeatureIndex) rejectForeignHit();
    previousFeatureIndex = featureIndex;

    if (!Array.isArray(rawGroup.hits)) rejectForeignHit();

    const hits = rawGroup.hits;
    if (hits.length > 5) rejectForeignHit();
    totalHits += hits.length;
    if (totalHits > 60) rejectForeignHit();

    const status = rawGroup.status;
    if (status === "hits") {
      if (rawFeature.state !== "visible") rejectForeignHit();
      if (rawGroup.failure !== null || hits.length === 0) rejectForeignHit();
    } else if (status === "no_hit") {
      if (rawFeature.state !== "visible") rejectForeignHit();
      if (rawGroup.failure !== null || hits.length !== 0) rejectForeignHit();
    } else if (status === "failed") {
      if (!isRetrievalFailure(rawGroup.failure) || hits.length !== 0) rejectForeignHit();
      if (
        (rawGroup.failure === "skipped" ||
          rawGroup.failure === "missing_tool_call" ||
          rawGroup.failure === "multiple_tool_calls" ||
          rawGroup.failure === "malformed_tool_json" ||
          rawGroup.failure === "invalid_tool_arguments") &&
        rawGroup.query !== null
      ) {
        rejectForeignHit();
      }
      if (rawFeature.state === "not_visible" && (rawGroup.failure !== "skipped" || rawGroup.query !== null)) {
        rejectForeignHit();
      }
    } else {
      rejectForeignHit();
    }
    if (status !== "hits") continue;
    for (const [occurrence, hit] of hits.entries()) {
      if (!isRecord(hit)) rejectForeignHit();
      validateExactKeys(hit, ["attemptId", "featureKey", "memoryHitId", "providerId", "text", "score", "effect"]);
      if (!isFeatureKey(hit.featureKey) || hit.attemptId !== attemptId || hit.featureKey !== rawFeature.key) {
        rejectForeignHit();
      }
      if (typeof hit.memoryHitId !== "string" || hit.memoryHitId.trim() === "") rejectForeignHit();
      if (hit.providerId !== null && (typeof hit.providerId !== "string" || hit.providerId.trim() === "")) {
        rejectForeignHit();
      }
      if (typeof hit.text !== "string" || hit.text.trim() === "") rejectForeignHit();
      if (hit.score !== null && (typeof hit.score !== "number" || !Number.isFinite(hit.score))) rejectForeignHit();
      if (hit.effect !== null && !isReflectionEffect(hit.effect)) rejectForeignHit();
      if (hit.memoryHitId !== makeMemoryHitId(attemptId, rawFeature.key, hit.providerId, hit.text, occurrence)) {
        rejectForeignHit();
      }

      const key = `${attemptId}\0${hit.featureKey}\0${hit.memoryHitId}`;
      if (seenHits.has(key)) rejectForeignHit();
      seenHits.add(key);
      candidates.push({
        attemptId,
        featureKey: rawFeature.key,
        memoryHitId: hit.memoryHitId,
      });
    }
  }
  return candidates;
}
