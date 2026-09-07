/**
 * Serializes model calls made through the OpenRouter-compatible endpoint.
 *
 * Providers enforce quotas over a time window, so keeping only one request in
 * flight is not enough by itself. The minimum interval is measured between
 * request starts and is configurable for slower or faster provider plans.
 */

export const DEFAULT_OPENROUTER_MIN_INTERVAL_MS = 1_000;

function configuredMinIntervalMs(): number {
  const raw = process.env.OPENROUTER_MIN_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_OPENROUTER_MIN_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error("OPENROUTER_MIN_INTERVAL_MS must be a non-negative integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("OPENROUTER_MIN_INTERVAL_MS must be a safe integer");
  }
  return value;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export type OpenRouterThrottle = <T>(request: () => Promise<T>) => Promise<T>;

/** Creates an isolated serial request queue, primarily for deterministic tests. */
export function createOpenRouterThrottle(minIntervalMs: number): OpenRouterThrottle {
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
    throw new Error("OpenRouter throttle interval must be a non-negative safe integer");
  }

  let tail: Promise<void> = Promise.resolve();
  let nextStartAt = 0;

  return <T>(request: () => Promise<T>): Promise<T> => {
    const operation = tail.then(async () => {
      const wait = Math.max(0, nextStartAt - Date.now());
      if (wait > 0) await sleep(wait);
      nextStartAt = Date.now() + minIntervalMs;
      return request();
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

/** Shared queue used by all default OpenRouter clients in this process. */
export const throttleOpenRouterRequest = createOpenRouterThrottle(configuredMinIntervalMs());
