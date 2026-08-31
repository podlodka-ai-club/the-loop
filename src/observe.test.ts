/**
 * The one contract the two-step observation shares with the corpus: a frame the reviewer
 * turned upright is a different picture, so it must not answer from the cache written
 * before the rotation.
 *
 * This is checked rather than reasoned about because the failure is silent. A stale entry
 * returns plausible features for the orientation review rejected, recall searches for the
 * wrong thing, and nothing in the run says so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { observeCachePath } from "./observe.ts";
import { loadRotations } from "./rotations.ts";
import type { Turn } from "./rotations.ts";

const FRAME = "tmp/datasets/osv5m/images/test/1047222609015689.jpg";

test("the recorded angle changes the cache key for one unchanged frame", () => {
  const asShipped = observeCachePath(FRAME, 0);
  const turned = observeCachePath(FRAME, 180);
  assert.notEqual(
    asShipped,
    turned,
    "a rotated frame reuses the cache written before the rotation",
  );

  // Every angle a photograph can need has to be distinguishable, not just 0 against 180.
  const angles: Turn[] = [0, 90, 180, 270];
  const keys = new Set(angles.map((angle) => observeCachePath(FRAME, angle)));
  assert.equal(keys.size, angles.length);
});

test("the same frame at the same angle maps to one path", () => {
  assert.equal(observeCachePath(FRAME, 90), observeCachePath(FRAME, 90));
});

test("two frames at the same angle do not collide", () => {
  const other = FRAME.replace("1047222609015689", "1000184947185715");
  assert.notEqual(observeCachePath(FRAME, 0), observeCachePath(other, 0));
});

/**
 * Guards the caller, not the key: `observe` reads the angle from the committed list, so a
 * frame that stopped being rotated there would silently stop exercising the rotated path.
 */
test("the committed list still turns the frame this test uses", async () => {
  const rotations = await loadRotations();
  assert.equal(rotations.get("1047222609015689"), 180);
  assert.equal(rotations.has("1000184947185715"), false);
});
