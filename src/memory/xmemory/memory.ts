import { randomUUID } from "node:crypto";
import type { Hint, LessonInput, Memory } from "../../memory.ts";
import {
  XmemoryMemoryError,
  isXmemoryUnavailableCause,
  type XmemoryMemoryErrorCode,
} from "./error.ts";
import { createXmemoryPlatformPort } from "./platform.ts";
import {
  decodeXmemoryChanges,
  type XmemoryChangeSet,
  type XmemoryPlatformPort,
} from "./platform-contract.ts";
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

type NormalizedLesson = {
  content: string;
  sourceAttemptId: string;
  triggers: string[];
  region: string;
};

type XmemoryBehaviorDependencies = {
  createTraceId: () => string;
  onRememberCompleted?: (result: XmemoryRememberResult) => void;
  onInstanceQuarantined?: (result: XmemoryQuarantineResult) => void;
};

const SENTINEL = /<\/?loci_/i;
const SOURCE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEFINITE_WRITE_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "write_failed",
]);

const READ_ERROR_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "protocol_error",
]);

function invalidInput(operation: "write" | "read"): XmemoryMemoryError {
  return new XmemoryMemoryError(
    "invalid_input",
    operation,
    `The xmemory ${operation} input is invalid`,
  );
}

function protocolError(operation: "write" | "read"): XmemoryMemoryError {
  return new XmemoryMemoryError(
    operation === "write" ? "write_outcome_unknown" : "protocol_error",
    operation,
    operation === "write"
      ? "The xmemory write outcome is unknown"
      : "xmemory returned an invalid read response",
  );
}

function quarantinedError(operation: "write" | "read"): XmemoryMemoryError {
  return new XmemoryMemoryError(
    "instance_quarantined",
    operation,
    "The xmemory instance is quarantined after an ambiguous write",
  );
}

function normalizeLesson(value: LessonInput): NormalizedLesson {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidInput("write");
    const content = value.content;
    const rawSourceAttemptId = value.sourceAttemptId;
    const rawRegion = value.region;
    const rawTriggers = value.triggers;
    if (
      typeof content !== "string" ||
      typeof rawSourceAttemptId !== "string" ||
      typeof rawRegion !== "string" ||
      content.trim() === "" ||
      content.length > 50_000 ||
      SENTINEL.test(content) ||
      !Array.isArray(rawTriggers) ||
      rawTriggers.length > 64
    ) {
      throw invalidInput("write");
    }
    const sourceAttemptId = rawSourceAttemptId.trim();
    const region = rawRegion.trim();
    if (
      !SOURCE_ATTEMPT_ID.test(sourceAttemptId) ||
      region.length > 256 ||
      SENTINEL.test(region)
    ) {
      throw invalidInput("write");
    }

    const triggers: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawTriggers) {
      if (typeof raw !== "string") throw invalidInput("write");
      const trigger = raw.trim();
      if (trigger === "" || trigger.length > 256 || SENTINEL.test(trigger)) {
        throw invalidInput("write");
      }
      if (!seen.has(trigger)) {
        seen.add(trigger);
        triggers.push(trigger);
      }
    }
    return { content, sourceAttemptId, triggers, region };
  } catch {
    throw invalidInput("write");
  }
}

function buildLessonEnvelope(lesson: NormalizedLesson): string {
  return (
    "<loci_training_experience_v1>\n" +
    "<loci_provenance_v1>\n" +
    `source_attempt_id: ${lesson.sourceAttemptId}\n` +
    `region_json: ${JSON.stringify(lesson.region)}\n` +
    `observed_triggers_json: ${JSON.stringify(lesson.triggers)}\n` +
    "</loci_provenance_v1>\n" +
    "<loci_lesson_v1>\n" +
    `${lesson.content}\n` +
    "</loci_lesson_v1>\n" +
    "</loci_training_experience_v1>"
  );
}

function normalizeFeatures(value: string[]): string[] {
  try {
    if (!Array.isArray(value) || value.length > 64) throw invalidInput("read");
    const features: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
      if (typeof raw !== "string") throw invalidInput("read");
      const feature = raw.trim().replace(/\s+/g, " ");
      if (feature.length > 256 || SENTINEL.test(feature)) throw invalidInput("read");
      if (feature !== "" && !seen.has(feature)) {
        seen.add(feature);
        features.push(feature);
      }
    }
    return features;
  } catch {
    throw invalidInput("read");
  }
}

function featureQuery(features: readonly string[], limit: number): string {
  return (
    "Use only stored Loci Insights to help interpret a new photograph.\n" +
    "Visible features:\n" +
    `${features.map((feature) => `- ${feature}`).join("\n")}\n` +
    `Return at most ${limit} distinct grounded insights. Preserve conditions, counter-signals,\n` +
    "comparisons and caveats. Do not invent observations or claim a final location."
  );
}

function priorQuery(limit: number): string {
  return (
    `Return at most ${limit} high-value stored Loci Insights that are broadly useful before any visual\n` +
    "features are available. Preserve conditions, counter-signals, comparisons and caveats. Do not\n" +
    "invent observations or claim a final location."
  );
}

function safeProviderMessage(code: XmemoryMemoryErrorCode, operation: "write" | "read"): string {
  switch (code) {
    case "authentication":
      return "xmemory authentication failed";
    case "authorization":
      return "xmemory authorization failed";
    case "instance_not_found":
      return "The xmemory instance was not found";
    case "rate_limited":
      return "The xmemory rate limit was exceeded";
    case "quota_exceeded":
      return "The xmemory quota was exceeded";
    case "unavailable":
      return `xmemory ${operation} is unavailable`;
    case "invalid_input":
      return `xmemory rejected the ${operation} request`;
    case "write_failed":
      return "The xmemory write failed";
    default:
      return `xmemory ${operation} failed`;
  }
}

function sanitizeDefiniteWriteError(error: unknown): XmemoryMemoryError | null {
  try {
    if (
      error instanceof XmemoryMemoryError &&
      error.operation === "write" &&
      DEFINITE_WRITE_CODES.has(error.code)
    ) {
      return new XmemoryMemoryError(error.code, "write", safeProviderMessage(error.code, "write"));
    }
  } catch {
    // Any hostile or foreign error leaves the write outcome unknown.
  }
  return null;
}

function sanitizeReadError(error: unknown): XmemoryMemoryError {
  let code: XmemoryMemoryErrorCode = "protocol_error";
  try {
    if (
      error instanceof XmemoryMemoryError &&
      error.operation === "read" &&
      READ_ERROR_CODES.has(error.code)
    ) {
      code = error.code;
    } else if (isXmemoryUnavailableCause(error)) {
      code = "unavailable";
    }
  } catch {
    code = "protocol_error";
  }
  return new XmemoryMemoryError(code, "read", safeProviderMessage(code, "read"));
}

function normalizeBehaviorDependencies(
  dependencies: XmemoryMemoryDependencies,
): XmemoryBehaviorDependencies {
  try {
    const createTraceId = dependencies.createTraceId ?? randomUUID;
    const onRememberCompleted = dependencies.onRememberCompleted;
    const onInstanceQuarantined = dependencies.onInstanceQuarantined;
    if (
      typeof createTraceId !== "function" ||
      (onRememberCompleted !== undefined && typeof onRememberCompleted !== "function") ||
      (onInstanceQuarantined !== undefined && typeof onInstanceQuarantined !== "function")
    ) {
      throw new Error("invalid behavior dependency");
    }
    return {
      createTraceId,
      ...(onRememberCompleted === undefined ? {} : { onRememberCompleted }),
      ...(onInstanceQuarantined === undefined ? {} : { onInstanceQuarantined }),
    };
  } catch {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "The xmemory runtime dependencies are invalid",
    );
  }
}

class SchemaVerifiedXmemoryMemory implements XmemoryMemory {
  private readonly config: XmemoryMemoryConfig;
  private readonly platform: XmemoryPlatformPort;
  private readonly behavior: XmemoryBehaviorDependencies;
  private writeTail: Promise<void> = Promise.resolve();
  private quarantined = false;

  constructor(
    config: XmemoryMemoryConfig,
    platform: XmemoryPlatformPort,
    behavior: XmemoryBehaviorDependencies,
  ) {
    this.config = config;
    this.platform = platform;
    this.behavior = behavior;
  }

  private assertUsable(operation: "write" | "read"): void {
    if (this.quarantined) throw quarantinedError(operation);
  }

  private quarantine(): XmemoryMemoryError {
    const error = protocolError("write");
    if (!this.quarantined) {
      this.quarantined = true;
      try {
        const notification = this.behavior.onInstanceQuarantined?.({
          instanceId: this.config.instanceId,
          code: "write_outcome_unknown",
        });
        void Promise.resolve(notification).catch(() => undefined);
      } catch {
        // Notification is best-effort and never replaces the ambiguous write error.
      }
    }
    return error;
  }

  private async performRemember(input: LessonInput): Promise<void> {
    this.assertUsable("write");
    const lesson = normalizeLesson(input);

    let rawResult: unknown;
    try {
      rawResult = await this.platform.write({
        text: buildLessonEnvelope(lesson),
        extractionLogic: "deep",
        diffEngine: true,
        timeoutMs: this.config.writeTimeoutMs,
      });
    } catch (error) {
      const definite = sanitizeDefiniteWriteError(error);
      if (definite !== null) throw definite;
      throw this.quarantine();
    }

    let result: XmemoryRememberResult;
    try {
      if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
        throw new Error("invalid write response");
      }
      const value = rawResult as Record<string, unknown>;
      const writeId = value.writeId;
      const traceId = value.traceId;
      const changes = value.changes;
      if (typeof writeId !== "string" || writeId.trim() === "") {
        throw new Error("invalid write id");
      }
      if (traceId !== null && typeof traceId !== "string") {
        throw new Error("invalid trace id");
      }
      result = {
        sourceAttemptId: lesson.sourceAttemptId,
        writeId,
        traceId,
        changes: decodeXmemoryChanges(changes),
      };
    } catch {
      throw this.quarantine();
    }

    try {
      if (this.behavior.onRememberCompleted !== undefined) {
        await Promise.resolve(this.behavior.onRememberCompleted(result));
      }
    } catch {
      throw new XmemoryMemoryError(
        "observer_failed",
        "write",
        "The xmemory remember observer failed",
      );
    }
  }

  async recall(features: string[], limit: number): Promise<Hint[]> {
    this.assertUsable("read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw invalidInput("read");
    const normalized = normalizeFeatures(features);

    let traceId: string;
    try {
      traceId = this.behavior.createTraceId();
      if (typeof traceId !== "string" || !LOWERCASE_UUID.test(traceId)) {
        throw new Error("invalid trace id");
      }
    } catch {
      throw protocolError("read");
    }

    let rawResult: unknown;
    try {
      rawResult = await this.platform.read({
        query: normalized.length === 0 ? priorQuery(limit) : featureQuery(normalized, limit),
        readMode: "single-answer",
        traceId,
        timeoutMs: this.config.readTimeoutMs,
      });
    } catch (error) {
      throw sanitizeReadError(error);
    }

    try {
      if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
        throw new Error("invalid read response");
      }
      const result = rawResult as Record<string, unknown>;
      const providerTraceId = result.traceId;
      if (providerTraceId !== null && typeof providerTraceId !== "string") {
        throw new Error("invalid provider trace id");
      }
      const readerResult = result.readerResult;
      if (typeof readerResult !== "object" || readerResult === null || Array.isArray(readerResult)) {
        throw new Error("invalid reader result");
      }
      if (!Object.hasOwn(readerResult, "answer")) throw new Error("missing answer");
      const answer = (readerResult as Record<string, unknown>).answer;
      if (typeof answer !== "string") throw new Error("invalid answer");
      const text = answer.trim();
      return text === "" ? [] : [{ lessonId: `xmemory-read:${traceId}`, text }];
    } catch {
      throw protocolError("read");
    }
  }

  remember(lesson: LessonInput): Promise<void> {
    const operation = this.writeTail.then(() => this.performRemember(lesson));
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async snapshot(): Promise<string> {
    throw new XmemoryMemoryError(
      "unsupported_operation",
      "snapshot",
      "XmemoryMemory does not support snapshot",
    );
  }

  async restore(_id: string): Promise<void> {
    throw new XmemoryMemoryError(
      "unsupported_operation",
      "restore",
      "XmemoryMemory does not support restore",
    );
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
  const behavior = normalizeBehaviorDependencies(dependencies);

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
  return new SchemaVerifiedXmemoryMemory(normalized, platform, behavior);
}
