import type { Hint, LessonInput, Memory } from "../../memory.ts";
import {
  XmemoryMemoryError,
  isXmemoryUnavailableCause,
  type XmemoryMemoryErrorCode,
} from "./error.ts";
import { createXmemoryPlatformPort } from "./platform.ts";
import type { XmemoryChangeSet, XmemoryPlatformPort } from "./platform-contract.ts";
import {
  assertXmemorySchemaCompatible,
  loadXmemorySchema,
  type LoadedXmemorySchema,
} from "./schema.ts";

export { XmemoryMemoryError } from "./error.ts";
export type { XmemoryMemoryErrorCode, XmemoryOperation } from "./error.ts";

export const XMEMORY_CAPABILITIES = { snapshot: false, restore: false } as const;

export type XmemoryMemoryConfig = {
  apiKey: string;
  instanceId: string;
  writeTimeoutMs: number;
  readTimeoutMs: number;
};

export type XmemoryRememberResult = {
  sourceAttemptId: string;
  writeId: string;
  traceId: string | null;
  changes: XmemoryChangeSet;
};

export type XmemoryQuarantineResult = {
  instanceId: string;
  code: "write_outcome_unknown";
};

export type XmemoryMemoryDependencies = {
  platform?: XmemoryPlatformPort;
  schemaPath?: string;
  createTraceId?: () => string;
  onRememberCompleted?: (result: XmemoryRememberResult) => void;
  onInstanceQuarantined?: (result: XmemoryQuarantineResult) => void;
};

export interface XmemoryMemory extends Memory {
  recall(features: string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<void>;
  snapshot(): Promise<string>;
  restore(id: string): Promise<void>;
}

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

function normalizeMemoryConfig(config: XmemoryMemoryConfig): XmemoryMemoryConfig {
  try {
    const apiKey = config.apiKey.trim();
    const instanceId = config.instanceId.trim();
    if (apiKey === "" || instanceId === "") throw new Error("invalid required value");
    if (!Number.isSafeInteger(config.writeTimeoutMs) || config.writeTimeoutMs <= 0) {
      throw new Error("invalid write timeout");
    }
    if (!Number.isSafeInteger(config.readTimeoutMs) || config.readTimeoutMs <= 0) {
      throw new Error("invalid read timeout");
    }
    return {
      apiKey,
      instanceId,
      writeTimeoutMs: config.writeTimeoutMs,
      readTimeoutMs: config.readTimeoutMs,
    };
  } catch {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "The xmemory runtime configuration is invalid",
    );
  }
}

function assertRequirements(requirements: { snapshots: boolean }): void {
  try {
    const keys = Reflect.ownKeys(requirements);
    const descriptor = Object.getOwnPropertyDescriptor(requirements, "snapshots");
    if (
      keys.length === 1 &&
      keys[0] === "snapshots" &&
      descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === false
    ) {
      return;
    }
  } catch {
    // The same unsupported-configuration result covers hostile or malformed requirements.
  }
  throw new XmemoryMemoryError(
    "unsupported_configuration",
    "schema",
    "Xmemory snapshots are not supported",
  );
}

function safeSchemaMessage(code: XmemoryMemoryErrorCode): string {
  switch (code) {
    case "authentication":
      return "xmemory schema authentication failed";
    case "authorization":
      return "xmemory schema authorization failed";
    case "instance_not_found":
      return "The xmemory instance was not found";
    case "rate_limited":
      return "The xmemory schema rate limit was exceeded";
    case "quota_exceeded":
      return "The xmemory schema quota was exceeded";
    case "unavailable":
      return "xmemory schema is unavailable";
    case "invalid_input":
      return "xmemory rejected the schema request";
    case "schema_mismatch":
      return "The live xmemory schema does not match the committed schema";
    case "unsupported_configuration":
      return "The xmemory schema configuration is not supported";
    default:
      return "xmemory schema verification failed";
  }
}

const SCHEMA_ERROR_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "unsupported_configuration",
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "protocol_error",
  "schema_mismatch",
]);

function sanitizeSchemaError(error: unknown): XmemoryMemoryError {
  let code: XmemoryMemoryErrorCode = "protocol_error";
  try {
    if (
      error instanceof XmemoryMemoryError &&
      error.operation === "schema" &&
      SCHEMA_ERROR_CODES.has(error.code)
    ) {
      code = error.code;
    }
    else if (isXmemoryUnavailableCause(error)) code = "unavailable";
  } catch {
    code = "protocol_error";
  }
  return new XmemoryMemoryError(code, "schema", safeSchemaMessage(code));
}

class SchemaVerifiedXmemoryMemory implements XmemoryMemory {
  private readonly config: XmemoryMemoryConfig;
  private readonly platform: XmemoryPlatformPort;

  constructor(config: XmemoryMemoryConfig, platform: XmemoryPlatformPort) {
    this.config = config;
    this.platform = platform;
  }

  private unavailable(operation: "read" | "write" | "snapshot" | "restore"): never {
    void this.config;
    void this.platform;
    throw new XmemoryMemoryError(
      "unsupported_operation",
      operation,
      "XmemoryMemory behavior is not available during construction",
    );
  }

  async recall(_features: string[], _limit: number): Promise<Hint[]> {
    return this.unavailable("read");
  }

  async remember(_lesson: LessonInput): Promise<void> {
    return this.unavailable("write");
  }

  async snapshot(): Promise<string> {
    return this.unavailable("snapshot");
  }

  async restore(_id: string): Promise<void> {
    return this.unavailable("restore");
  }
}

export function loadXmemoryMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): XmemoryMemoryConfig {
  try {
    return {
      apiKey: required(env, "XMEM_API_KEY"),
      instanceId: required(env, "XMEM_INSTANCE_ID"),
      writeTimeoutMs: positiveSafeInteger(env, "XMEM_WRITE_TIMEOUT_MS", 180_000),
      readTimeoutMs: positiveSafeInteger(env, "XMEM_READ_TIMEOUT_MS", 60_000),
    };
  } catch {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "The xmemory runtime configuration is invalid",
    );
  }
}

export async function createXmemoryMemory(
  requirements: { snapshots: boolean },
  config: XmemoryMemoryConfig,
  dependencies: XmemoryMemoryDependencies = {},
): Promise<XmemoryMemory> {
  assertRequirements(requirements);
  const normalized = normalizeMemoryConfig(config);

  let expected: LoadedXmemorySchema;
  let platform: XmemoryPlatformPort;
  try {
    expected = await loadXmemorySchema(dependencies.schemaPath);
    platform = dependencies.platform ?? createXmemoryPlatformPort(normalized);
  } catch (error) {
    throw sanitizeSchemaError(error);
  }

  let live: Record<string, unknown>;
  try {
    live = await platform.getSchema(normalized.readTimeoutMs);
  } catch (error) {
    throw sanitizeSchemaError(error);
  }
  assertXmemorySchemaCompatible(expected, live);
  return new SchemaVerifiedXmemoryMemory(normalized, platform);
}
