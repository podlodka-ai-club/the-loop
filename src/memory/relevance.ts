/**
 * Relevance gate for feature-scoped recall.
 *
 * Providers return a ranked list for one query. The list is not yet something the
 * analyze step may read: the first eval run showed that 78% of served hits carried an
 * `irrelevant` verdict, that generic lessons answered unrelated features, and that
 * every hit came back unconditionally with `score: null`. The gate is the one place
 * where those three defects are handled, so every adapter is treated the same way.
 *
 * Order of the filters matters only for the counters; a hint has to pass all of them.
 */
import type { FeatureKey } from "../observe.ts";
import type { Hint, ReflectionEffect } from "./memory.ts";

/**
 * Verdicts a stored lesson may carry and still reach the analyze prompt. The second
 * eval run served `insufficient` and `misleading` too, and every one of them added a
 * country tag without adding a cue: the paired comparison lost 13 frames to drift
 * toward trained countries and won 7. Only a rule that separated countries once is
 * evidence for a blind attempt; the rest stays in the bank for statistics.
 */
export const SERVED_EFFECTS: readonly ReflectionEffect[] = ["helped"];

/**
 * How many candidates one recall asks the provider for, per served hit. The gate drops
 * candidates after the provider ranked them, so the request has to be wider than the
 * served cap or a feature whose first candidates are `irrelevant` would answer with
 * nothing even when a good lesson sits at rank six.
 */
export const RECALL_FETCH_MULTIPLIER = 4;

/** Upper bound on one provider request, whatever the multiplier says. */
export const RECALL_FETCH_CAP = 20;

/** Minimum provider score, on the provider's own scale, when a provider returns one. */
export const MIN_PROVIDER_SCORE = parseMinProviderScore(process.env.MEMORY_MIN_SCORE ?? "0.5");

/** Minimum number of shared content tokens between query and lesson when no score exists. */
export const MIN_TRIGGER_OVERLAP = 1;

export function parseMinProviderScore(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new Error("MEMORY_MIN_SCORE must be a finite number");
  return parsed;
}

export function recallFetchLimit(servedLimit: number): number {
  return Math.min(RECALL_FETCH_CAP, Math.max(servedLimit, servedLimit * RECALL_FETCH_MULTIPLIER));
}

export type RelevanceGateInput = {
  featureKey: FeatureKey;
  query: string;
  limit: number;
};

export type RelevanceGateDrops = {
  /** Verdict outside SERVED_EFFECTS: `irrelevant`, `insufficient` or `misleading`. */
  effect: number;
  /** Stored under another feature key. Unlabelled lessons are not counted here. */
  feature: number;
  /** Provider score under MIN_PROVIDER_SCORE, or no shared token with the query. */
  unrelated: number;
  /** Same lesson text twice in one answer. */
  duplicate: number;
  /** Passed every filter but did not fit into the served limit. */
  overflow: number;
};

export type RelevanceGateResult = {
  served: Hint[];
  drops: RelevanceGateDrops;
};

/**
 * Words that carry no cue on their own. They are removed before overlap counting so a
 * query and a lesson do not match on "with" or "and".
 */
const STOP_WORDS = new Set([
  "the", "and", "with", "from", "that", "this", "are", "for", "not", "was", "were", "has",
  "have", "its", "into", "over", "under", "near", "some", "very", "more", "most", "also",
  "than", "which", "what", "where", "when", "there", "here", "along", "across", "between",
  "visible", "seen", "shows", "shown", "image", "photo", "scene", "area", "side", "both",
  "one", "two", "several", "many", "few", "any", "all", "each", "may", "can", "but", "off",
]);

export function contentTokens(values: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2 && !STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function hintScore(hint: Hint): number | null {
  const value = hint.score;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedText(hint: Hint): string {
  return hint.text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when the lesson has something to do with the query. A provider score decides
 * when it exists; otherwise the stored triggers (or, without triggers, the lesson text)
 * must share at least MIN_TRIGGER_OVERLAP content tokens with the query.
 */
export function isRelatedToQuery(hint: Hint, queryTokens: ReadonlySet<string>): boolean {
  const score = hintScore(hint);
  if (score !== null) return score >= MIN_PROVIDER_SCORE;
  const source = hint.triggers !== undefined && hint.triggers.length > 0 ? hint.triggers : [hint.text];
  let overlap = 0;
  for (const token of contentTokens(source)) {
    if (queryTokens.has(token)) overlap += 1;
    if (overlap >= MIN_TRIGGER_OVERLAP) return true;
  }
  return false;
}

export function applyRelevanceGate(hints: readonly Hint[], input: RelevanceGateInput): RelevanceGateResult {
  const drops: RelevanceGateDrops = { effect: 0, feature: 0, unrelated: 0, duplicate: 0, overflow: 0 };
  const served: Hint[] = [];
  const seen = new Set<string>();
  const queryTokens = contentTokens([input.query]);
  for (const hint of hints) {
    if (hint.effect !== undefined && !SERVED_EFFECTS.includes(hint.effect)) {
      drops.effect += 1;
      continue;
    }
    if (hint.featureKey !== undefined && hint.featureKey !== input.featureKey) {
      drops.feature += 1;
      continue;
    }
    if (!isRelatedToQuery(hint, queryTokens)) {
      drops.unrelated += 1;
      continue;
    }
    const key = normalizedText(hint);
    if (seen.has(key)) {
      drops.duplicate += 1;
      continue;
    }
    seen.add(key);
    if (served.length >= input.limit) {
      drops.overflow += 1;
      continue;
    }
    served.push(hint);
  }
  return { served, drops };
}
