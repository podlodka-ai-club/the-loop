import assert from "node:assert/strict";
import test from "node:test";
import { countSentences } from "./sentence-count.ts";

test("countSentences handles ordinary, abbreviated, and adversarial lesson text", () => {
  const cases: Array<[string, number]> = [
    ["One sentence.", 1],
    ["One sentence. Two sentence!", 2],
    ["Use e.g. this. Fine.", 2],
    ["U.S. road.", 1],
    ["One. Two.Three.", 3],
    ["One. two.three.", 3],
  ];
  for (const [content, expected] of cases) {
    assert.equal(countSentences(content), expected, content);
  }
});
