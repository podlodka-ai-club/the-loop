/**
 * The contract the two-step observation shares with the corpus: a cached observation
 * describes the picture that was sent, and nothing else.
 *
 * This is checked rather than reasoned about because the failure is silent. A frame the
 * reviewer turns upright keeps its name and changes its pixels; an entry keyed on the name
 * would return plausible features for the orientation review rejected, recall would search
 * for the wrong thing, and nothing in the run would say so.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observeCachePath } from "./observe.ts";

const FRAME = Buffer.from("pretend this is a jpeg");

test("different pixels cache under different keys", () => {
  const turned = Buffer.from("pretend this is the same frame, turned");
  assert.notEqual(observeCachePath(FRAME), observeCachePath(turned));
});

test("the same pixels map to one path", () => {
  assert.equal(observeCachePath(FRAME), observeCachePath(Buffer.from(FRAME)));
});

/**
 * A one-byte change is the realistic case: turning a frame re-encodes it, and two
 * re-encodes of one photograph differ in far less than a whole image.
 */
test("a single changed byte changes the key", () => {
  const nudged = Buffer.from(FRAME);
  nudged[0] = (nudged[0] ?? 0) ^ 0x01;
  assert.notEqual(observeCachePath(FRAME), observeCachePath(nudged));
});

/**
 * The prompt is part of the question. Re-wording it invalidates every cached answer, so
 * `PROMPT_VERSION` has to reach the key; a key over the bytes alone would keep serving
 * observations made under the old instructions.
 */
test("the key is not the bare digest of the frame", () => {
  const bare = createHash("sha256").update(FRAME).digest("hex").slice(0, 16);
  assert.equal(observeCachePath(FRAME).includes(bare), false);
});
