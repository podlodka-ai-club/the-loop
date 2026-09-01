import { isNormalizedFeatureKey } from "../../observe.ts";
import type { FeatureKey } from "../../observe.ts";
import {
  MemoryWriteError,
  MemoryBindingError,
  encodeMemoryRetrieveQuery,
  normalizeMemoryQuery,
  isSharedMemoryPrompt,
  sharedMemoryPrompt,
  sharedMemoryPromptMetadata,
  type Hint,
  type LegacyLessonInput,
  type LegacyMemory,
  type LessonInput,
  type Memory,
  type MemoryAdapterPromptPort,
  type MemoryPrompt,
  type MemoryWriteResult,
  type ReflectionEffect,
} from "../memory.ts";
import { runIdempotentWrite } from "../idempotency.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RETAIN_CONTEXT,
  createHindsightPlatformPort,
  type HindsightMemorySource,
  type HindsightPlatformPort,
  type HindsightRecallRequest,
  type HindsightRetainRequest,
  type HindsightRetainResponse,
} from "./platform-contract.ts";
import {
  HindsightMemoryError,
  hindsightError,
  normalizeHindsightError,
} from "./error.ts";

export const HINDSIGHT_CAPABILITIES = { snapshot: false, restore: false } as const;
export const HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS = 180_000;
export const HINDSIGHT_DEFAULT_READ_TIMEOUT_MS = 60_000;
export const HINDSIGHT_DEFAULT_MAX_TOKENS = 4_096;
export const HINDSIGHT_DEFAULT_RECALL_BUDGET = "mid" as const;

export type HindsightMemoryConfig = {
  source: HindsightMemorySource;
  apiKey: string;
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
  writeTimeoutMs: number;
  readTimeoutMs: number;
  maxTokens: number;
  recallBudget: "low" | "mid" | "high";
};

export type HindsightRememberResult = {
  sourceAttemptId: string;
  documentId: string;
  itemsCount: 1;
  usage: Record<string, number> | null;
};

export type HindsightQuarantineResult = {
  bankId: string;
  code: "write_outcome_unknown";
};

export type HindsightMemoryDependencies = {
  platform?: HindsightPlatformPort;
  onRememberCompleted?: (result: HindsightRememberResult) => void | Promise<void>;
  onInstanceQuarantined?: (result: HindsightQuarantineResult) => void | Promise<void>;
};

export interface HindsightMemory extends Memory, LegacyMemory {
  recall(queryOrFeatures: string | string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput | LegacyLessonInput): Promise<MemoryWriteResult>;
  snapshot(): Promise<string>;
  restore(id: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

const REFLECTION_EFFECTS: readonly ReflectionEffect[] = [
  "helped",
  "irrelevant",
  "misleading",
  "insufficient",
];

function readFeatureKey(value: unknown): FeatureKey | undefined {
  return isNormalizedFeatureKey(value) ? value : undefined;
}

function readEffect(value: unknown): ReflectionEffect | undefined {
  return typeof value === "string" && (REFLECTION_EFFECTS as readonly string[]).includes(value)
    ? (value as ReflectionEffect)
    : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isTimeout(value: unknown): value is number {
  return isPositiveInteger(value) && (value as number) <= 600_000;
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function invalidInput(operation: "read" | "write"): never {
  throw hindsightError("invalid_input", operation);
}

function validateSource(source: unknown): HindsightMemorySource {
  try {
    if (
      !isRecord(source) ||
      typeof source.memoryRef !== "string" ||
      source.memoryRef.trim() === "" ||
      source.provider !== "hindsight" ||
      source.deployment !== "cloud" ||
      typeof source.bankId !== "string" ||
      source.bankId.trim() === "" ||
      (source.purpose !== "integration" && source.purpose !== "pilot") ||
      source.credentialEnv !== "HINDSIGHT_API_KEY"
    ) {
      throw new Error("invalid source");
    }
    return { ...source } as HindsightMemorySource;
  } catch {
    throw hindsightError("unsupported_configuration", "config");
  }
}

function validateConfig(config: unknown): HindsightMemoryConfig {
  try {
    if (!isRecord(config)) throw new Error("invalid config");
    const source = validateSource(config.source);
    if (
      typeof config.apiKey !== "string" ||
      config.apiKey.trim() === "" ||
      config.baseUrl !== HINDSIGHT_CLOUD_BASE_URL ||
      !isPositiveInteger(config.writeTimeoutMs) ||
      config.writeTimeoutMs > 600_000 ||
      !isPositiveInteger(config.readTimeoutMs) ||
      config.readTimeoutMs > 600_000 ||
      !isPositiveInteger(config.maxTokens) ||
      (config.recallBudget !== "low" &&
        config.recallBudget !== "mid" &&
        config.recallBudget !== "high")
    ) {
      throw new Error("invalid config");
    }
    return {
      source,
      apiKey: config.apiKey.trim(),
      baseUrl: HINDSIGHT_CLOUD_BASE_URL,
      writeTimeoutMs: config.writeTimeoutMs,
      readTimeoutMs: config.readTimeoutMs,
      maxTokens: config.maxTokens,
      recallBudget: config.recallBudget,
    };
  } catch {
    throw hindsightError("unsupported_configuration", "config");
  }
}

function requiredApiKey(source: HindsightMemorySource, env: NodeJS.ProcessEnv): string {
  try {
    if (!isRecord(env)) throw new Error("invalid environment");
    const value = env[source.credentialEnv];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("missing environment value");
    }
    return value.trim();
  } catch {
    throw hindsightError("unsupported_configuration", "config");
  }
}

export function loadHindsightMemoryConfig(
  source: HindsightMemorySource,
  env: NodeJS.ProcessEnv = process.env,
): HindsightMemoryConfig {
  const resolvedSource = validateSource(source);
  return {
    source: resolvedSource,
    apiKey: requiredApiKey(resolvedSource, env),
    baseUrl: HINDSIGHT_CLOUD_BASE_URL,
    writeTimeoutMs: HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS,
    readTimeoutMs: HINDSIGHT_DEFAULT_READ_TIMEOUT_MS,
    maxTokens: HINDSIGHT_DEFAULT_MAX_TOKENS,
    recallBudget: HINDSIGHT_DEFAULT_RECALL_BUDGET,
  };
}

function validateRequirements(requirements: unknown): void {
  try {
    if (
      !isRecord(requirements) ||
      Object.keys(requirements).length !== 1 ||
      requirements.snapshots !== false
    ) {
      throw new Error("invalid requirements");
    }
  } catch {
    throw hindsightError("unsupported_configuration", "config");
  }
}

function validateLesson(lesson: unknown): LessonInput | LegacyLessonInput {
  try {
    if (!isRecord(lesson)) return invalidInput("write");
    const content = lesson.content;
    const sourceAttemptId = lesson.sourceAttemptId;
    const featureKey = lesson.featureKey;
    const memoryHitId = lesson.memoryHitId;
    const effect = lesson.effect;
    const idempotencyKey = lesson.idempotencyKey;
    const region = lesson.region;
    const triggers = lesson.triggers;
    if (
      typeof content !== "string" ||
      content.trim() === "" ||
      content.length > 50_000 ||
      typeof sourceAttemptId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceAttemptId.trim()) ||
      typeof region !== "string" ||
      region.length > 256 ||
      !isDenseArray(triggers) ||
      triggers.length > 64
    ) {
      return invalidInput("write");
    }
    const normalizedFeatureKey = featureKey === undefined ? undefined : readFeatureKey(featureKey);
    const normalizedEffect = effect === undefined ? undefined : readEffect(effect);
    if (
      (featureKey !== undefined && normalizedFeatureKey === undefined) ||
      (memoryHitId !== undefined &&
        memoryHitId !== null &&
        (typeof memoryHitId !== "string" || memoryHitId.trim() === "")) ||
      (effect !== undefined && normalizedEffect === undefined) ||
      (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim() === ""))
    ) {
      return invalidInput("write");
    }

    const normalizedTriggers: string[] = [];
    for (const trigger of triggers) {
      if (typeof trigger !== "string" || trigger.length > 256) return invalidInput("write");
      normalizedTriggers.push(trigger);
    }
    return {
      content,
      sourceAttemptId: sourceAttemptId.trim(),
      ...(normalizedFeatureKey === undefined ? {} : { featureKey: normalizedFeatureKey }),
      ...(memoryHitId === undefined
        ? {}
        : { memoryHitId: memoryHitId === null ? null : memoryHitId.trim() }),
      ...(normalizedEffect === undefined ? {} : { effect: normalizedEffect }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey: idempotencyKey.trim() }),
      triggers: normalizedTriggers,
      region,
    };
  } catch {
    throw hindsightError("invalid_input", "write");
  }
}

export function buildHindsightRetainRequest(
  bankId: string,
  lesson: LessonInput | LegacyLessonInput,
  timeoutMs: number,
  prompt: MemoryPrompt = sharedMemoryPrompt("store"),
): HindsightRetainRequest {
  if (!isNonEmptyString(bankId) || !isTimeout(timeoutMs)) invalidInput("write");
  if (!isSharedMemoryPrompt(prompt, "store")) invalidInput("write");
  const normalizedLesson = validateLesson(lesson);
  return {
    bankId,
    content: normalizedLesson.content,
    documentId: normalizedLesson.idempotencyKey ?? normalizedLesson.sourceAttemptId,
    retainMission: prompt.text,
    context: HINDSIGHT_RETAIN_CONTEXT,
    metadata: {
      loci_source_attempt_id: normalizedLesson.sourceAttemptId,
      loci_region: normalizedLesson.region,
      loci_triggers_json: JSON.stringify(normalizedLesson.triggers),
      ...(normalizedLesson.featureKey === undefined ? {} : { loci_feature_key: normalizedLesson.featureKey }),
      ...(normalizedLesson.memoryHitId === undefined ? {} : { loci_memory_hit_id: normalizedLesson.memoryHitId }),
      ...(normalizedLesson.effect === undefined ? {} : { loci_effect: normalizedLesson.effect }),
      ...(normalizedLesson.idempotencyKey === undefined ? {} : { loci_idempotency_key: normalizedLesson.idempotencyKey }),
    },
    async: false,
    timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function copyUsage(value: unknown): Record<string, number> | null {
  try {
    if (value === null) return null;
    if (!isRecord(value)) throw new Error("invalid usage");
    const usage: Record<string, number> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("invalid usage");
      usage[key] = item;
    }
    return usage;
  } catch {
    throw hindsightError("protocol_error", "write");
  }
}

function validateRetainResponse(
  response: unknown,
  expectedBankId: string,
): HindsightRetainResponse {
  try {
    if (
      !isRecord(response) ||
      typeof response.success !== "boolean" ||
      !isNonEmptyString(response.bankId) ||
      !Number.isSafeInteger(response.itemsCount) ||
      (response.itemsCount as number) < 0 ||
      response.async !== false ||
      !Object.hasOwn(response, "operationId") ||
      (response.operationId !== null && !isNonEmptyString(response.operationId)) ||
      !Object.hasOwn(response, "usage")
    ) {
      throw new Error("invalid retain response");
    }
    const normalized: HindsightRetainResponse = {
      success: response.success,
      bankId: response.bankId,
      itemsCount: response.itemsCount as number,
      async: false,
      operationId: response.operationId,
      usage: copyUsage(response.usage),
    };
    if (!normalized.success) throw hindsightError("write_failed", "write");
    if (
      normalized.bankId !== expectedBankId ||
      normalized.itemsCount !== 1 ||
      normalized.operationId !== null
    ) {
      throw new Error("invalid retain success response");
    }
    return normalized;
  } catch (error) {
    if (error instanceof HindsightMemoryError) throw error;
    throw hindsightError("protocol_error", "write");
  }
}

function normalizeOperationError(
  error: unknown,
  operation: "read" | "write",
): HindsightMemoryError {
  const normalized = normalizeHindsightError(error, operation);
  if (
    operation === "write" &&
    (normalized.code === "timeout" || normalized.code === "unavailable")
  ) {
    return hindsightError("write_outcome_unknown", "write");
  }
  return normalized;
}

function projectRecallResponse(response: unknown, limit: number): Hint[] {
  try {
    if (!isRecord(response) || !isDenseArray(response.results)) {
      throw new Error("invalid recall response");
    }
    const ids = new Set<string>();
    const hints: Hint[] = [];
    for (const result of response.results) {
      if (
        !isRecord(result) ||
        !isNonEmptyString(result.id) ||
        !isNonEmptyString(result.text) ||
        ids.has(result.id)
      ) {
        throw new Error("invalid recall result");
      }
      ids.add(result.id);
      const metadata = isRecord(result.metadata) ? result.metadata : {};
      const featureKey = readFeatureKey(metadata.loci_feature_key);
      const effect = readEffect(metadata.loci_effect);
      hints.push({
        lessonId: result.id,
        text: result.text,
        ...(featureKey === undefined ? {} : { featureKey }),
        ...(effect === undefined ? {} : { effect }),
      });
    }
    return hints.slice(0, limit);
  } catch {
    throw hindsightError("protocol_error", "read");
  }
}

class HindsightMemoryImplementation implements HindsightMemory {
  readonly promptMetadata = sharedMemoryPromptMetadata();
  readonly promptPort: MemoryAdapterPromptPort = {
    retrieve: (request) => {
      if (request.operation !== "retrieve" || typeof request.query !== "string") {
        return Promise.reject(hindsightError("invalid_input", "read"));
      }
      return this.recall(request.query, request.limit ?? 5, request.prompt);
    },
    store: (request) => {
      if (request.operation !== "store" || request.lesson === undefined) {
        return Promise.reject(hindsightError("invalid_input", "write"));
      }
      return this.remember(request.lesson, request.prompt);
    },
  };
  readonly #config: HindsightMemoryConfig;
  readonly #dependencies: HindsightMemoryDependencies;
  #platform: HindsightPlatformPort | undefined;
  #quarantined = false;
  #quarantineNotified = false;
  #rememberTail: Promise<void> = Promise.resolve();
  #lessonIdsByIdempotencyKey = new Map<string, string>();

  constructor(config: HindsightMemoryConfig, dependencies: HindsightMemoryDependencies) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  #getPlatform(): HindsightPlatformPort {
    if (this.#platform === undefined) {
      this.#platform =
        this.#dependencies.platform ??
        createHindsightPlatformPort({
          apiKey: this.#config.apiKey,
          baseUrl: this.#config.baseUrl,
        });
    }
    return this.#platform;
  }

  #assertUsable(operation: "read" | "write"): void {
    if (this.#quarantined) throw hindsightError("instance_quarantined", operation);
  }

  remember(
    lesson: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt = sharedMemoryPrompt("store"),
  ): Promise<MemoryWriteResult> {
    if (!isSharedMemoryPrompt(prompt, "store")) {
      return Promise.reject(hindsightError("invalid_input", "write"));
    }
    const operation = this.#rememberTail
      .then(() => this.#rememberOne(lesson, prompt))
      .catch((error: unknown) => {
        throw this.#toMemoryWriteError(error);
      });
    this.#rememberTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #rememberOne(
    lesson: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt,
  ): Promise<MemoryWriteResult> {
    this.#assertUsable("write");
    const normalizedLesson = validateLesson(lesson);
    const idempotencyKey = normalizedLesson.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const existing = this.#lessonIdsByIdempotencyKey.get(idempotencyKey);
      if (existing !== undefined) return { status: "already_stored", lessonId: existing };
    }
    const request = buildHindsightRetainRequest(
      this.#config.source.bankId,
      normalizedLesson,
      this.#config.writeTimeoutMs,
      prompt,
    );

    const write = async (): Promise<string | MemoryWriteResult> => {
      let response: unknown;
      try {
        response = await this.#callPlatform("write", request.signal, () =>
          this.#getPlatform().retain(request),
        );
      } catch (error) {
        const normalized = normalizeOperationError(error, "write");
        if (normalized.code === "write_outcome_unknown") await this.#quarantine();
        throw normalized;
      }

      const accepted = validateRetainResponse(response, this.#config.source.bankId);
      const observer = this.#dependencies.onRememberCompleted;
      if (observer !== undefined) {
        try {
          await observer({
            sourceAttemptId: normalizedLesson.sourceAttemptId,
            documentId: request.documentId,
            itemsCount: 1,
            usage: accepted.usage,
          });
        } catch {
          throw hindsightError("observer_failed", "write");
        }
      }
      if (idempotencyKey !== undefined) {
        this.#lessonIdsByIdempotencyKey.set(idempotencyKey, request.documentId);
      }
      return request.documentId;
    };

    if (idempotencyKey === undefined) {
      const lessonId = await write();
      if (typeof lessonId !== "string") throw hindsightError("protocol_error", "write");
      return { status: "stored", lessonId };
    }
    return runIdempotentWrite(
      `hindsight:${this.#config.source.bankId}`,
      idempotencyKey,
      write,
    );
  }

  async recall(
    queryOrFeatures: string | string[],
    limit: number,
    prompt: MemoryPrompt = sharedMemoryPrompt("retrieve"),
  ): Promise<Hint[]> {
    if (!isSharedMemoryPrompt(prompt, "retrieve")) throw hindsightError("invalid_input", "read");
    this.#assertUsable("read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) invalidInput("read");
    let query: string;
    try {
      query = normalizeMemoryQuery(queryOrFeatures);
    } catch {
      invalidInput("read");
    }

    const request: HindsightRecallRequest = {
      bankId: this.#config.source.bankId,
      query: encodeMemoryRetrieveQuery(prompt, query),
      maxTokens: this.#config.maxTokens,
      budget: this.#config.recallBudget,
      types: ["world", "experience", "observation"],
      preferObservations: true,
      includeSourceFacts: false,
      includeChunks: false,
      includeEntities: false,
      timeoutMs: this.#config.readTimeoutMs,
      signal: AbortSignal.timeout(this.#config.readTimeoutMs),
    };

    let response: unknown;
    try {
      response = await this.#callPlatform("read", request.signal, () =>
        this.#getPlatform().recall(request),
      );
    } catch (error) {
      throw normalizeOperationError(error, "read");
    }
    return projectRecallResponse(response, limit);
  }

  async #callPlatform<T>(
    operation: "read" | "write",
    signal: AbortSignal,
    call: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw hindsightError("timeout", operation);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = () => reject(hindsightError("timeout", operation));
      if (signal.aborted) rejectOnAbort();
      else {
        onAbort = rejectOnAbort;
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      }
    });

    try {
      const result = await Promise.race([call(), aborted]);
      if (signal.aborted) throw hindsightError("timeout", operation);
      return result;
    } catch (error) {
      if (signal.aborted) throw hindsightError("timeout", operation);
      throw normalizeOperationError(error, operation);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  #toMemoryWriteError(error: unknown): MemoryWriteError {
    if (error instanceof MemoryWriteError) return error;
    const bindingCode =
      error instanceof HindsightMemoryError
          ? error.code === "bank_not_found"
            ? "memory_not_found"
            : error.code === "unavailable"
              ? "unavailable"
              : error.code === "rate_limited"
                ? "unavailable"
                : error.code === "timeout"
                  ? "timeout"
                  : error.code === "authentication" || error.code === "authorization"
                    ? "memory_mismatch"
                    : null
        : null;
    if (bindingCode !== null) {
      throw new MemoryBindingError(bindingCode, `Hindsight memory binding failed: ${bindingCode}`, { cause: error });
    }
    if (error instanceof HindsightMemoryError && error.code === "write_outcome_unknown") {
      return new MemoryWriteError("write_outcome_unknown");
    }
    return new MemoryWriteError("write_failed");
  }

  async #quarantine(): Promise<void> {
    if (this.#quarantined) return;
    this.#quarantined = true;
    if (this.#quarantineNotified) return;
    this.#quarantineNotified = true;
    const observer = this.#dependencies.onInstanceQuarantined;
    if (observer === undefined) return;
    try {
      await observer({
        bankId: this.#config.source.bankId,
        code: "write_outcome_unknown",
      });
    } catch {
      // Notification failure must not replace the original write error.
    }
  }

  async snapshot(): Promise<string> {
    throw hindsightError("unsupported_operation", "snapshot");
  }

  async restore(_id: string): Promise<void> {
    throw hindsightError("unsupported_operation", "restore");
  }
}

export function createHindsightMemory(
  requirements: { snapshots: boolean },
  config: HindsightMemoryConfig,
  dependencies: HindsightMemoryDependencies = {},
): HindsightMemory {
  validateRequirements(requirements);
  const validatedConfig = validateConfig(config);
  return new HindsightMemoryImplementation(validatedConfig, dependencies);
}
