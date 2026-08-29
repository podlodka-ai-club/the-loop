import type { Hint, LessonInput, Memory } from "../../memory.ts";
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
export const HINDSIGHT_DEFAULT_PRIOR_QUERY =
  "Retrieve broadly useful Loci geolocation lessons about visual cues, regional distinctions, " +
  "counter-signals, and verification procedures.";

export type HindsightMemoryConfig = {
  source: HindsightMemorySource;
  apiKey: string;
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
  writeTimeoutMs: number;
  readTimeoutMs: number;
  maxTokens: number;
  recallBudget: "low" | "mid" | "high";
  priorQuery: string;
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

export interface HindsightMemory extends Memory {
  recall(features: string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<void>;
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
        config.recallBudget !== "high") ||
      typeof config.priorQuery !== "string" ||
      config.priorQuery.trim() === ""
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
      priorQuery: config.priorQuery,
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
    priorQuery: HINDSIGHT_DEFAULT_PRIOR_QUERY,
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

function validateLesson(lesson: unknown): LessonInput {
  try {
    if (!isRecord(lesson)) return invalidInput("write");
    const content = lesson.content;
    const sourceAttemptId = lesson.sourceAttemptId;
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

    const normalizedTriggers: string[] = [];
    for (const trigger of triggers) {
      if (typeof trigger !== "string" || trigger.length > 256) return invalidInput("write");
      normalizedTriggers.push(trigger);
    }
    return {
      content,
      sourceAttemptId: sourceAttemptId.trim(),
      triggers: normalizedTriggers,
      region,
    };
  } catch {
    throw hindsightError("invalid_input", "write");
  }
}

function normalizeFeatures(features: unknown): string[] {
  try {
    if (!isDenseArray(features) || features.length > 64) return invalidInput("read");
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const feature of features) {
      if (typeof feature !== "string" || feature.length > 256) return invalidInput("read");
      const value = feature.trim().replace(/\s+/g, " ");
      if (value !== "" && !seen.has(value)) {
        seen.add(value);
        normalized.push(value);
      }
    }
    return normalized;
  } catch {
    throw hindsightError("invalid_input", "read");
  }
}

export function buildHindsightRetainRequest(
  bankId: string,
  lesson: LessonInput,
  timeoutMs: number,
): HindsightRetainRequest {
  if (!isNonEmptyString(bankId) || !isTimeout(timeoutMs)) invalidInput("write");
  const normalizedLesson = validateLesson(lesson);
  return {
    bankId,
    content: normalizedLesson.content,
    documentId: normalizedLesson.sourceAttemptId,
    context: HINDSIGHT_RETAIN_CONTEXT,
    metadata: {
      loci_source_attempt_id: normalizedLesson.sourceAttemptId,
      loci_region: normalizedLesson.region,
      loci_triggers_json: JSON.stringify(normalizedLesson.triggers),
    },
    async: false,
    timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

export function buildHindsightRecallQuery(
  features: readonly string[],
  priorQuery: string,
): string {
  const normalized = normalizeFeatures(features);
  if (typeof priorQuery !== "string") invalidInput("read");
  if (normalized.length === 0) return priorQuery;
  return `Relevant visual geolocation features:\n${normalized.map((feature) => `- ${feature}`).join("\n")}`;
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
      hints.push({ lessonId: result.id, text: result.text });
    }
    return hints.slice(0, limit);
  } catch {
    throw hindsightError("protocol_error", "read");
  }
}

class HindsightMemoryImplementation implements HindsightMemory {
  readonly #config: HindsightMemoryConfig;
  readonly #dependencies: HindsightMemoryDependencies;
  #platform: HindsightPlatformPort | undefined;
  #quarantined = false;
  #quarantineNotified = false;
  #rememberTail: Promise<void> = Promise.resolve();

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

  remember(lesson: LessonInput): Promise<void> {
    const operation = this.#rememberTail.then(() => this.#rememberOne(lesson));
    this.#rememberTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #rememberOne(lesson: LessonInput): Promise<void> {
    this.#assertUsable("write");
    const request = buildHindsightRetainRequest(
      this.#config.source.bankId,
      lesson,
      this.#config.writeTimeoutMs,
    );

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
    if (observer === undefined) return;
    try {
      await observer({
        sourceAttemptId: request.documentId,
        documentId: request.documentId,
        itemsCount: 1,
        usage: accepted.usage,
      });
    } catch {
      throw hindsightError("observer_failed", "write");
    }
  }

  async recall(features: string[], limit: number): Promise<Hint[]> {
    this.#assertUsable("read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) invalidInput("read");

    const request: HindsightRecallRequest = {
      bankId: this.#config.source.bankId,
      query: buildHindsightRecallQuery(features, this.#config.priorQuery),
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
