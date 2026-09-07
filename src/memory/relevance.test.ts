import assert from "node:assert/strict";
import test from "node:test";
import type { Hint } from "./memory.ts";
import {
  MIN_PROVIDER_SCORE,
  RECALL_FETCH_CAP,
  RECALL_FETCH_MULTIPLIER,
  applyRelevanceGate,
  contentTokens,
  isRelatedToQuery,
  recallFetchLimit,
} from "./relevance.ts";

const query = "wooden utility poles with two crossarms";

function hint(overrides: Partial<Hint> & { lessonId: string }): Hint {
  return { text: "wooden poles carry two crossarms", ...overrides };
}

test("fetch limit over-fetches per served hit and stays under the cap", () => {
  assert.equal(recallFetchLimit(1), RECALL_FETCH_MULTIPLIER);
  assert.equal(recallFetchLimit(2), 2 * RECALL_FETCH_MULTIPLIER);
  assert.equal(recallFetchLimit(5), RECALL_FETCH_CAP);
  assert.ok(recallFetchLimit(5) >= 5);
});

test("content tokens drop stop words and short tokens", () => {
  assert.deepEqual([...contentTokens(["the wooden poles with a red band"])], ["wooden", "poles", "red", "band"]);
});

test("only helped and unlabelled lessons reach the served list", () => {
  const result = applyRelevanceGate(
    [
      hint({ lessonId: "a", effect: "irrelevant", text: "wooden poles rule a" }),
      hint({ lessonId: "b", effect: "helped", text: "wooden poles rule b" }),
      hint({ lessonId: "c", effect: "misleading", text: "wooden poles rule c" }),
      hint({ lessonId: "d", effect: "insufficient", text: "wooden poles rule d" }),
      hint({ lessonId: "e", text: "wooden poles rule e" }),
    ],
    { featureKey: "poles", query, limit: 5 },
  );
  assert.deepEqual(result.served.map((item) => item.lessonId), ["b", "e"]);
  assert.equal(result.drops.effect, 3);
});

test("lessons stored under another feature are dropped, unlabelled lessons are kept", () => {
  const result = applyRelevanceGate(
    [
      hint({ lessonId: "surface", featureKey: "road_surface", text: "wooden poles rule surface" }),
      hint({ lessonId: "poles", featureKey: "poles", text: "wooden poles rule poles" }),
      hint({ lessonId: "legacy", text: "wooden poles rule legacy" }),
    ],
    { featureKey: "poles", query, limit: 5 },
  );
  assert.deepEqual(result.served.map((item) => item.lessonId), ["poles", "legacy"]);
  assert.equal(result.drops.feature, 1);
});

test("a provider score decides relevance when present, trigger overlap otherwise", () => {
  const tokens = contentTokens([query]);
  assert.equal(isRelatedToQuery(hint({ lessonId: "high", score: MIN_PROVIDER_SCORE }), tokens), true);
  assert.equal(isRelatedToQuery(hint({ lessonId: "low", score: MIN_PROVIDER_SCORE - 0.01 }), tokens), false);
  // A low score wins over overlapping triggers: the provider knew better.
  assert.equal(
    isRelatedToQuery(hint({ lessonId: "low-overlap", score: 0, triggers: ["wooden poles"] }), tokens),
    false,
  );
  assert.equal(isRelatedToQuery(hint({ lessonId: "triggers", triggers: ["wooden poles"] }), tokens), true);
  assert.equal(isRelatedToQuery(hint({ lessonId: "foreign", triggers: ["red soil"] }), tokens), false);
  // Without triggers the lesson text is the fallback.
  assert.equal(isRelatedToQuery(hint({ lessonId: "text", text: "crossarms on poles" }), tokens), true);
  assert.equal(isRelatedToQuery(hint({ lessonId: "prose", text: "red laterite soil" }), tokens), false);
  // Triggers win over text when both exist: text overlap alone does not count.
  assert.equal(
    isRelatedToQuery(hint({ lessonId: "mixed", text: "wooden poles", triggers: ["red soil"] }), tokens),
    false,
  );
});

test("unrelated, duplicate and overflow hits are counted separately and the served cap holds", () => {
  const result = applyRelevanceGate(
    [
      hint({ lessonId: "1", text: "wooden poles with crossarms" }),
      hint({ lessonId: "2", text: "Wooden  poles with crossarms " }),
      hint({ lessonId: "3", text: "red laterite soil" }),
      hint({ lessonId: "4", text: "single wooden pole" }),
      hint({ lessonId: "5", text: "concrete poles" }),
    ],
    { featureKey: "poles", query, limit: 2 },
  );
  assert.deepEqual(result.served.map((item) => item.lessonId), ["1", "4"]);
  assert.deepEqual(result.drops, { effect: 0, feature: 0, unrelated: 1, duplicate: 1, overflow: 1 });
});

test("an empty served list is a valid outcome", () => {
  const result = applyRelevanceGate([hint({ lessonId: "x", text: "red soil" })], { featureKey: "poles", query, limit: 2 });
  assert.deepEqual(result.served, []);
  assert.equal(result.drops.unrelated, 1);
});
