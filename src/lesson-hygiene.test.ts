import assert from "node:assert/strict";
import test from "node:test";
import {
  LessonHygieneError,
  applyLessonHygiene,
  canonicalIrrelevantContent,
  contrastMatch,
  foreignCountryNames,
  narrativeMatch,
} from "./lesson-hygiene.ts";

test("a contrastive cue rule that names only the region passes unchanged", () => {
  const content = "Wooden poles with two crossarms, not the single-crossarm concrete poles seen nearby.";
  assert.deepEqual(
    applyLessonHygiene({ effect: "helped", content, triggers: ["wooden poles"], region: "BR" }),
    { effect: "helped", content, downgraded: null },
  );
});

test("helped without a contrast clause is stored as insufficient", () => {
  const content = "Wooden poles with two crossarms are typical of rural Brazilian roads.";
  assert.deepEqual(
    applyLessonHygiene({ effect: "helped", content, triggers: ["wooden poles"], region: "BR" }),
    { effect: "insufficient", content, downgraded: "no_contrast" },
  );
  for (const contrast of [
    "Kilometre posts are blue, unlike the white posts across the border.",
    "Edge lines are yellow rather than white.",
    "Signs use a serif face instead of the usual sans-serif.",
    "Poles are square concrete, whereas neighbouring styles are round.",
  ]) {
    assert.equal(contrastMatch(contrast) !== null, true, contrast);
    assert.equal(
      applyLessonHygiene({ effect: "helped", content: contrast, triggers: ["cue"], region: "BR" }).effect,
      "helped",
      contrast,
    );
  }
  assert.equal(
    applyLessonHygiene({ effect: "insufficient", content, triggers: ["cue"], region: "BR" }).downgraded,
    null,
  );
});

test("irrelevant verdicts are replaced by the canonical form", () => {
  assert.equal(
    applyLessonHygiene({
      effect: "irrelevant",
      content: "The memory hit regarding Norway was irrelevant for this Indian road.",
      triggers: ["dirt shoulder", "flat horizon"],
      region: "IN",
    }).content,
    canonicalIrrelevantContent(["dirt shoulder", "flat horizon"]),
  );
  assert.equal(foreignCountryNames(canonicalIrrelevantContent(["dirt shoulder"]), "IN").length, 0);
});

test("episode narrative is rejected for served verdicts", () => {
  for (const content of [
    "The memory hit about poles did not help here.",
    "Retrieval returned nothing useful for this feature.",
    "This image shows a rural road with wooden poles.",
    "The blind guess landed in the wrong hemisphere.",
    "The lesson was misleading.",
  ]) {
    assert.throws(
      () => applyLessonHygiene({ effect: "helped", content, triggers: ["poles"], region: "BR" }),
      (error: unknown) => error instanceof LessonHygieneError && error.violation.code === "narrative",
      content,
    );
  }
  assert.equal(narrativeMatch("Wooden poles are common."), null);
});

test("country names, aliases and demonyms outside the region are rejected", () => {
  const cases: Array<[string, string]> = [
    ["Wooden poles like these are common in Norway.", "IN"],
    ["Norwegian road markings use yellow centre lines.", "SE"],
    ["This pole style also occurs in the United States.", "CA"],
    ["Such signage is typical of the U.K.", "IE"],
    ["Eucalyptus stands are a Tasmania signature.", "NZ"],
    ["Cote d'Ivoire uses this bollard style.", "GH"],
  ];
  for (const [content, region] of cases) {
    assert.throws(
      () => applyLessonHygiene({ effect: "misleading", content, triggers: ["cue"], region }),
      (error: unknown) => error instanceof LessonHygieneError && error.violation.code === "foreign_country",
      content,
    );
  }
});

test("the region's own name, alias and demonym are allowed", () => {
  for (const [content, region] of [
    ["Yellow centre lines with white edges are standard on Norwegian rural roads.", "NO"],
    ["Blue kilometre posts are typical of Brazil.", "BR"],
    ["This sign style belongs to the United States.", "US"],
    ["Right-hand traffic with Turkish signage.", "TR"],
    ["Such shop fronts appear in Congo - Kinshasa.", "CD"],
  ] as Array<[string, string]>) {
    assert.equal(applyLessonHygiene({ effect: "misleading", content, triggers: ["cue"], region }).content, content);
  }
});

test("substrings of longer words are not country matches", () => {
  assert.deepEqual(foreignCountryNames("Omani style plates", "AE"), []);
  assert.deepEqual(foreignCountryNames("Oman style plates", "AE"), ["oman"]);
  assert.deepEqual(foreignCountryNames("Romanesque church facade", "FR"), []);
  assert.deepEqual(foreignCountryNames("The chad-coloured dust", "FR"), ["chad"]);
  assert.deepEqual(foreignCountryNames("Cuban-style balconies", "MX"), []);
  assert.deepEqual(foreignCountryNames("Cuba-style balconies", "MX"), ["cuba"]);
});
