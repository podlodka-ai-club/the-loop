export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export const MAX_SAMPLE_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export type SampleRetryPolicy = {
  maxSampleAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};
