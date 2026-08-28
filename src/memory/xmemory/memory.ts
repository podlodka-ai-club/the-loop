import { XmemoryMemoryError } from "./error.ts";

export { XmemoryMemoryError } from "./error.ts";
export type { XmemoryMemoryErrorCode, XmemoryOperation } from "./error.ts";

export const XMEMORY_CAPABILITIES = { snapshot: false, restore: false } as const;

export type XmemoryMemoryConfig = {
  apiKey: string;
  instanceId: string;
  writeTimeoutMs: number;
  readTimeoutMs: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      `${name} is required`,
    );
  }
  return value;
}

function positiveSafeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      `${name} must be a positive safe integer`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

export function loadXmemoryMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): XmemoryMemoryConfig {
  return {
    apiKey: required(env, "XMEM_API_KEY"),
    instanceId: required(env, "XMEM_INSTANCE_ID"),
    writeTimeoutMs: positiveSafeInteger(env, "XMEM_WRITE_TIMEOUT_MS", 180_000),
    readTimeoutMs: positiveSafeInteger(env, "XMEM_READ_TIMEOUT_MS", 60_000),
  };
}
