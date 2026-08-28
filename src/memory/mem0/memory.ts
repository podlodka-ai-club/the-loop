export { Mem0MemoryError, type Mem0MemoryErrorCode } from "./error.ts";
import { Mem0MemoryError } from "./error.ts";

export const MEM0_CAPABILITIES = { snapshot: false, restore: false } as const;

export type Mem0MemoryConfig = {
  apiKey: string;
  agentId: string;
  ingestionTimeoutMs: number;
  pollIntervalMs: number;
};

function configurationError(message: string): Mem0MemoryError {
  return new Mem0MemoryError("unsupported_configuration", message);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: "MEM0_API_KEY" | "MEM0_AGENT_ID"): string {
  const value = env[name]?.trim();
  if (!value) throw configurationError(`${name} is required`);
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw configurationError(`${name} must be a positive integer`);

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw configurationError(`${name} must be a positive integer`);
  }
  return value;
}

export function loadMem0MemoryConfig(env: NodeJS.ProcessEnv = process.env): Mem0MemoryConfig {
  const ingestionTimeoutMs = positiveIntegerEnv(env, "MEM0_INGESTION_TIMEOUT_MS", 120_000);
  const pollIntervalMs = positiveIntegerEnv(env, "MEM0_POLL_INTERVAL_MS", 1_000);
  if (pollIntervalMs >= ingestionTimeoutMs) {
    throw configurationError("MEM0_POLL_INTERVAL_MS must be smaller than MEM0_INGESTION_TIMEOUT_MS");
  }

  return {
    apiKey: requiredEnv(env, "MEM0_API_KEY"),
    agentId: requiredEnv(env, "MEM0_AGENT_ID"),
    ingestionTimeoutMs,
    pollIntervalMs,
  };
}
