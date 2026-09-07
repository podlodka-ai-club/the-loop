import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENROUTER_MIN_INTERVAL_MS,
  createOpenRouterThrottle,
} from "./openrouter-throttle.ts";

test("OpenRouter throttle serializes requests", async () => {
  const throttle = createOpenRouterThrottle(0);
  let active = 0;
  let maximumActive = 0;
  const order: string[] = [];

  const request = (name: string) => throttle(async () => {
    order.push(`start:${name}`);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    order.push(`end:${name}`);
    return name;
  });

  assert.deepEqual(await Promise.all([request("a"), request("b"), request("c")]), ["a", "b", "c"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("OpenRouter throttle validates its interval", () => {
  assert.equal(DEFAULT_OPENROUTER_MIN_INTERVAL_MS, 1_000);
  assert.throws(() => createOpenRouterThrottle(-1), /non-negative safe integer/);
  assert.throws(() => createOpenRouterThrottle(Number.POSITIVE_INFINITY), /non-negative safe integer/);
});
