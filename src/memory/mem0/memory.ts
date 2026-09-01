export { Mem0MemoryError, type Mem0MemoryErrorCode } from "./error.ts";
import { setTimeout as scheduleTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { isNormalizedFeatureKey } from "../../observe.ts";
import type { FeatureKey } from "../../observe.ts";
import {
  MemoryBindingError,
  MemoryWriteError,
  encodeMemoryRetrieveQuery,
  isSharedMemoryPrompt,
  normalizeMemoryQuery,
  renderedLessonContent,
  sharedMemoryPrompt,
  sharedMemoryPromptMetadata,
  type Hint,
  type LegacyLessonInput,
  type LegacyMemory,
  type LessonInput,
  type Memory,
  type MemoryAdapterPromptPort,
  type MemoryPrompt,
  type MemoryReader,
  type MemoryWriteResult,
  type ReflectionEffect,
} from "../memory.ts";
import { Mem0MemoryError } from "./error.ts";
import { createMem0PlatformPort } from "./platform.ts";
import type { Mem0PlatformPort, Mem0Record } from "./platform.ts";

export const MEM0_CAPABILITIES = { snapshot: false, restore: false } as const;

export type Mem0MemoryConfig = {
  apiKey: string;
  agentId: string;
  ingestionTimeoutMs: number;
  pollIntervalMs: number;
};

export type Mem0RememberResult = {
  sourceAttemptId: string;
  memoryIds: string[];
};

export type Mem0MemoryDependencies = {
  platform?: Mem0PlatformPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRememberCompleted?: (result: Mem0RememberResult) => void;
};

const ERROR_MESSAGES = {
  unsupported_operation: "Mem0 operation is not supported",
  unsupported_configuration: "Mem0 configuration is not supported",
  invalid_input: "Mem0 input is invalid",
  authentication: "Mem0 authentication failed",
  authorization: "Mem0 authorization failed",
  agent_not_found: "Mem0 agent was not found",
  rate_limited: "Mem0 rate limit was exceeded",
  quota_exceeded: "Mem0 quota was exceeded",
  unavailable: "Mem0 is unavailable",
  ingestion_failed: "Mem0 ingestion failed",
  ingestion_outcome_unknown: "Mem0 ingestion outcome is unknown",
  observer_failed: "Mem0 completion observer failed",
  protocol_error: "Mem0 returned an invalid response",
  instance_quarantined: "Mem0Memory instance is quarantined",
} as const;

const DEADLINE_EXPIRED = Symbol("mem0-deadline-expired");
const REFLECTION_EFFECTS: readonly ReflectionEffect[] = [
  "helped",
  "irrelevant",
  "misleading",
  "insufficient",
];

type ResolvedDependencies = {
  platform: Mem0PlatformPort;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onRememberCompleted?: (result: Mem0RememberResult) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFeatureKey(value: unknown): FeatureKey | undefined {
  return isNormalizedFeatureKey(value) ? value : undefined;
}

function readEffect(value: unknown): ReflectionEffect | undefined {
  return typeof value === "string" && (REFLECTION_EFFECTS as readonly string[]).includes(value)
    ? (value as ReflectionEffect)
    : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sanitizedError(
  code: keyof typeof ERROR_MESSAGES,
  eventId?: string,
  transient = false,
): Mem0MemoryError {
  return new Mem0MemoryError(code, ERROR_MESSAGES[code], {
    ...(eventId === undefined ? {} : { eventId }),
    ...(transient ? { context: "transient_operation" } : {}),
  });
}

function sanitizeExistingError(
  error: unknown,
  fallback: keyof typeof ERROR_MESSAGES,
  eventId?: string,
  transient = false,
): Mem0MemoryError {
  const code = error instanceof Mem0MemoryError ? error.code : fallback;
  return sanitizedError(code, eventId, transient);
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof Mem0MemoryError &&
    (error.code === "rate_limited" || error.code === "unavailable")
  );
}

function toBindingError(error: Mem0MemoryError): MemoryBindingError | null {
  if (error.code === "agent_not_found") {
    return new MemoryBindingError("memory_not_found", "Mem0 agent was not found", { cause: error });
  }
  if (error.code === "authentication" || error.code === "authorization") {
    return new MemoryBindingError("memory_mismatch", "Mem0 credentials were rejected", { cause: error });
  }
  if (error.code === "rate_limited" || error.code === "unavailable") {
    return new MemoryBindingError("unavailable", "Mem0 memory is unavailable", { cause: error });
  }
  return null;
}

function validateConfig(config: Mem0MemoryConfig): Mem0MemoryConfig {
  if (
    !isRecord(config) ||
    typeof config.apiKey !== "string" ||
    config.apiKey.trim() === "" ||
    typeof config.agentId !== "string" ||
    config.agentId.trim() === "" ||
    !Number.isSafeInteger(config.ingestionTimeoutMs) ||
    config.ingestionTimeoutMs <= 0 ||
    !Number.isSafeInteger(config.pollIntervalMs) ||
    config.pollIntervalMs <= 0 ||
    config.pollIntervalMs >= config.ingestionTimeoutMs
  ) {
    throw sanitizedError("unsupported_configuration");
  }
  return {
    apiKey: config.apiKey.trim(),
    agentId: config.agentId.trim(),
    ingestionTimeoutMs: config.ingestionTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  };
}

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

export function createMem0Memory(
  requirements: { snapshots: boolean },
  config: Mem0MemoryConfig,
  dependencies: Mem0MemoryDependencies = {},
): Mem0Memory {
  if (!isRecord(requirements) || requirements.snapshots !== false) {
    throw new Mem0MemoryError(
      "unsupported_configuration",
      "Mem0Memory cannot satisfy snapshot requirements",
    );
  }
  return new Mem0Memory(config, dependencies);
}

export class Mem0Memory implements Memory, LegacyMemory {
  readonly promptMetadata = sharedMemoryPromptMetadata();
  readonly promptPort: MemoryAdapterPromptPort = {
    retrieve: (request) => {
      if (request.operation !== "retrieve" || typeof request.query !== "string") {
        return Promise.reject(new Mem0MemoryError("invalid_input", "Mem0 retrieve prompt binding is invalid"));
      }
      return this.recall(request.query, request.limit ?? 5, request.prompt);
    },
    store: (request) => {
      if (request.operation !== "store" || request.lesson === undefined) {
        return Promise.reject(new Mem0MemoryError("invalid_input", "Mem0 store prompt binding is invalid"));
      }
      return this.remember(request.lesson, request.prompt);
    },
  };
  private readonly config: Mem0MemoryConfig;
  private readonly dependencies: ResolvedDependencies;
  private quarantined = false;
  private rememberTail: Promise<void> = Promise.resolve();
  private readonly lessonIdsByIdempotencyKey = new Map<string, string>();

  constructor(config: Mem0MemoryConfig, dependencies: Mem0MemoryDependencies = {}) {
    this.config = validateConfig(config);
    this.dependencies = {
      platform: dependencies.platform ?? createMem0PlatformPort({ apiKey: this.config.apiKey }),
      now: dependencies.now ?? Date.now,
      sleep: dependencies.sleep ?? ((ms) => delay(ms)),
      ...(dependencies.onRememberCompleted === undefined
        ? {}
        : { onRememberCompleted: dependencies.onRememberCompleted }),
    };
  }

  asReadOnlyReader(): MemoryReader {
    return {
      promptMetadata: this.promptMetadata,
      promptPort: {
        retrieve: (request) => this.promptPort.retrieve(request),
        store: async () => {
          throw new MemoryWriteError("write_failed", "Mem0 reader is read-only");
        },
      },
      recall: (query, limit, prompt) => this.recall(query, limit, prompt),
    };
  }

  remember(
    lesson: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt = sharedMemoryPrompt("store"),
  ): Promise<MemoryWriteResult> {
    if (!isSharedMemoryPrompt(prompt, "store")) {
      return Promise.reject(new Mem0MemoryError("invalid_input", "Mem0 requires the shared store prompt"));
    }
    const operation = this.rememberTail
      .then(() => this.rememberOne(lesson, prompt))
      .catch((error: unknown) => {
        throw this.toMemoryWriteError(error);
      });
    this.rememberTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async recall(
    queryOrFeatures: string | string[],
    limit: number,
    prompt: MemoryPrompt = sharedMemoryPrompt("retrieve"),
  ): Promise<Hint[]> {
    if (!isSharedMemoryPrompt(prompt, "retrieve")) throw sanitizedError("invalid_input");
    this.assertUsable();
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw sanitizedError("invalid_input");
    }
    if (
      typeof queryOrFeatures !== "string" &&
      (!Array.isArray(queryOrFeatures) || queryOrFeatures.some((value) => typeof value !== "string"))
    ) {
      throw sanitizedError("invalid_input");
    }

    const query = normalizeMemoryQuery(queryOrFeatures);
    let records: unknown;
    try {
      records = await this.dependencies.platform.search({
        query: encodeMemoryRetrieveQuery(prompt, query),
        filters: { agent_id: this.config.agentId },
        topK: limit,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      });
    } catch (error) {
      throw sanitizeExistingError(error, "protocol_error", undefined, isTransient(error));
    }
    if (!Array.isArray(records)) throw sanitizedError("protocol_error");

    const hints: Hint[] = records.map((record) => {
      if (
        !isRecord(record) ||
        typeof record.id !== "string" ||
        record.id.trim() === "" ||
        typeof record.memory !== "string" ||
        record.memory.trim() === "" ||
        !isRecord(record.metadata)
      ) {
        throw sanitizedError("protocol_error");
      }
      const featureKey = readFeatureKey(record.metadata.loci_feature_key);
      const effect = readEffect(record.metadata.loci_effect);
      const memory = renderedLessonContent({ content: record.memory, ...(effect === undefined ? {} : { effect }) });
      return {
        lessonId: record.id,
        text: memory,
        ...(featureKey === undefined ? {} : { featureKey }),
        ...(effect === undefined ? {} : { effect }),
      };
    });
    return hints.slice(0, limit);
  }

  async snapshot(): Promise<string> {
    throw new Mem0MemoryError(
      "unsupported_operation",
      "Mem0Memory does not support snapshot",
    );
  }

  async restore(_id: string): Promise<void> {
    throw new Mem0MemoryError(
      "unsupported_operation",
      "Mem0Memory does not support restore",
    );
  }

  private async rememberOne(
    lesson: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt,
  ): Promise<MemoryWriteResult> {
    this.assertUsable();
    this.validateLesson(lesson);
    if (lesson.idempotencyKey !== undefined) {
      // Mem0 Cloud does not expose an atomic compare-and-add primitive. The
      // adapter serializes writes on this instance and performs an exact
      // provider-metadata preflight before adding a lesson. An ambiguous
      // ingestion outcome is never retried automatically; a later call can
      // still discover a completed write through the provider list.
      const existing = await this.findExistingLessonId(lesson.idempotencyKey);
      if (existing !== undefined) return { status: "already_stored", lessonId: existing };
      const lessonId = await this.rememberOnce(lesson, prompt);
      this.lessonIdsByIdempotencyKey.set(lesson.idempotencyKey, lessonId);
      return { status: "stored", lessonId };
    }
    return { status: "stored", lessonId: await this.rememberOnce(lesson, prompt) };
  }

  private async rememberOnce(
    lesson: LessonInput | LegacyLessonInput,
    prompt: MemoryPrompt,
  ): Promise<string> {
    const request = {
      messages: [{ role: "assistant" as const, content: renderedLessonContent(lesson) }],
      agentId: this.config.agentId,
      infer: true as const,
      temporalReasoning: false as const,
      agentCustomInstructions: prompt.text,
      metadata: {
        loci_source_attempt_id: lesson.sourceAttemptId,
        loci_triggers: [...lesson.triggers],
        loci_region: lesson.region,
        ...(lesson.featureKey === undefined ? {} : { loci_feature_key: lesson.featureKey }),
        ...(lesson.memoryHitId === undefined ? {} : { loci_memory_hit_id: lesson.memoryHitId }),
        ...(lesson.effect === undefined ? {} : { loci_effect: lesson.effect }),
        ...(lesson.idempotencyKey === undefined ? {} : { loci_idempotency_key: lesson.idempotencyKey }),
      },
    };

    const deadline = this.dependencies.now() + this.config.ingestionTimeoutMs;
    let accepted: Awaited<ReturnType<Mem0PlatformPort["add"]>>;
    try {
      accepted = await this.callWithinDeadline(
        () => this.dependencies.platform.add(request),
        deadline,
      );
    } catch (error) {
      this.handleAddFailure(error);
    }

    const eventId = this.validateAcceptedAdd(accepted);
    this.assertWithinDeadline(deadline, eventId);
    const memoryIds = await this.waitForTerminalEvent(eventId, deadline);
    await this.waitForVisibility(memoryIds, eventId, deadline);
    this.notifyRememberCompleted(lesson.sourceAttemptId, memoryIds);
    const lessonId = memoryIds[0] ?? `mem0-event:${eventId}`;
    if (lesson.idempotencyKey !== undefined) {
      this.lessonIdsByIdempotencyKey.set(lesson.idempotencyKey, lessonId);
    }
    return lessonId;
  }

  private async findExistingLessonId(idempotencyKey: string): Promise<string | undefined> {
    const cached = this.lessonIdsByIdempotencyKey.get(idempotencyKey);
    if (cached !== undefined) return cached;

    let records: Mem0Record[];
    try {
      records = await this.dependencies.platform.list(this.config.agentId);
    } catch (error) {
      throw sanitizeExistingError(error, "protocol_error", undefined, isTransient(error));
    }
    if (!Array.isArray(records)) throw sanitizedError("protocol_error");

    for (const record of records) {
      if (!isRecord(record) || !isRecord(record.metadata)) continue;
      if (record.metadata.loci_idempotency_key !== idempotencyKey) continue;
      if (typeof record.id !== "string" || record.id.trim() === "") {
        throw sanitizedError("protocol_error");
      }
      this.lessonIdsByIdempotencyKey.set(idempotencyKey, record.id);
      return record.id;
    }
    return undefined;
  }

  private validateLesson(lesson: LessonInput | LegacyLessonInput): void {
    if (
      !isRecord(lesson) ||
      typeof lesson.content !== "string" ||
      lesson.content.trim() === "" ||
      typeof lesson.sourceAttemptId !== "string" ||
      lesson.sourceAttemptId.trim() === "" ||
      !Array.isArray(lesson.triggers) ||
      lesson.triggers.some((trigger) => typeof trigger !== "string") ||
      typeof lesson.region !== "string" ||
      Object.prototype.hasOwnProperty.call(lesson, "memory_ref")
    ) {
      throw sanitizedError("invalid_input");
    }

    const hasEpisodeMetadata =
      hasOwn(lesson, "featureKey") ||
      hasOwn(lesson, "memoryHitId") ||
      hasOwn(lesson, "effect") ||
      hasOwn(lesson, "idempotencyKey");
    if (!hasEpisodeMetadata) return;

    if (
      lesson.content.trim().replace(/\s+/g, " ").length > 2_000 ||
      readFeatureKey(lesson.featureKey) === undefined ||
      (lesson.memoryHitId !== null && typeof lesson.memoryHitId !== "string") ||
      (lesson.memoryHitId !== null && lesson.memoryHitId.trim() === "") ||
      readEffect(lesson.effect) === undefined ||
      typeof lesson.idempotencyKey !== "string" ||
      lesson.idempotencyKey.trim() === "" ||
      lesson.triggers.length < 1 ||
      lesson.triggers.length > 8 ||
      lesson.triggers.some((trigger) => {
        const normalized = trigger.trim().replace(/\s+/g, " ");
        return normalized === "" || normalized.length > 128;
      }) ||
      !/^[A-Z]{2}$/.test(lesson.region)
    ) {
      throw sanitizedError("invalid_input");
    }
  }

  private validateAcceptedAdd(value: unknown): string {
    if (
      !isRecord(value) ||
      typeof value.eventId !== "string" ||
      value.eventId.trim() === "" ||
      value.status !== "PENDING"
    ) {
      this.failAndQuarantine(sanitizedError("protocol_error"));
    }
    return value.eventId;
  }

  private handleAddFailure(error: unknown): never {
    if (error instanceof Mem0MemoryError && (error.code === "rate_limited" || error.code === "unavailable")) {
      throw new MemoryBindingError("unavailable", "Mem0 memory is unavailable", { cause: error });
    }
    if (error instanceof Mem0MemoryError) {
      if (error.code === "unavailable" || error.code === "ingestion_outcome_unknown") {
        this.failUnknownOutcome();
      }
      const normalized = sanitizeExistingError(error, "protocol_error");
      if (normalized.code === "protocol_error" || normalized.code === "ingestion_failed") {
        this.failAndQuarantine(normalized);
      }
      throw normalized;
    }
    this.failUnknownOutcome();
  }

  private async waitForTerminalEvent(eventId: string, deadline: number): Promise<string[]> {
    while (true) {
      this.assertWithinDeadline(deadline, eventId);
      let event: Awaited<ReturnType<Mem0PlatformPort["getEvent"]>>;
      try {
        event = await this.callWithinDeadline(
          () => this.dependencies.platform.getEvent(eventId),
          deadline,
          eventId,
        );
      } catch (error) {
        this.assertWithinDeadline(deadline, eventId);
        if (isTransient(error)) {
          await this.pause(deadline, eventId);
          continue;
        }
        this.failAndQuarantine(sanitizeExistingError(error, "protocol_error", eventId));
      }

      this.assertWithinDeadline(deadline, eventId);
      if (!isRecord(event) || event.eventId !== eventId) {
        this.failAndQuarantine(sanitizedError("protocol_error", eventId));
      }
      if (event.status === "PENDING" || event.status === "RUNNING") {
        await this.pause(deadline, eventId);
        continue;
      }
      if (event.status === "FAILED") {
        this.failAndQuarantine(sanitizedError("ingestion_failed", eventId));
      }
      if (event.status !== "SUCCEEDED" || !Array.isArray(event.memoryIds)) {
        this.failAndQuarantine(sanitizedError("protocol_error", eventId));
      }

      const ids = event.memoryIds;
      if (
        ids.some((id) => typeof id !== "string" || id.trim() === "") ||
        new Set(ids).size !== ids.length
      ) {
        this.failAndQuarantine(sanitizedError("protocol_error", eventId));
      }
      return [...ids];
    }
  }

  private async waitForVisibility(
    memoryIds: readonly string[],
    eventId: string,
    deadline: number,
  ): Promise<void> {
    for (const memoryId of memoryIds) {
      while (true) {
        this.assertWithinDeadline(deadline, eventId);
        let record: Mem0Record | null;
        try {
          record = await this.callWithinDeadline(
            () => this.dependencies.platform.get(memoryId),
            deadline,
            eventId,
          );
        } catch (error) {
          this.assertWithinDeadline(deadline, eventId);
          if (isTransient(error)) {
            await this.pause(deadline, eventId);
            continue;
          }
          this.failAndQuarantine(sanitizeExistingError(error, "protocol_error", eventId));
        }

        this.assertWithinDeadline(deadline, eventId);
        if (record === null) {
          await this.pause(deadline, eventId);
          continue;
        }
        if (!isRecord(record) || record.id !== memoryId) {
          this.failAndQuarantine(sanitizedError("protocol_error", eventId));
        }
        break;
      }
    }
  }

  private async pause(deadline: number, eventId: string): Promise<void> {
    const remaining = deadline - this.dependencies.now();
    if (remaining <= 0) this.failUnknownOutcome(eventId);
    try {
      await this.callWithinDeadline(
        () => this.dependencies.sleep(Math.min(this.config.pollIntervalMs, remaining)),
        deadline,
        eventId,
      );
    } catch {
      this.failUnknownOutcome(eventId);
    }
    this.assertWithinDeadline(deadline, eventId);
  }

  private async callWithinDeadline<T>(
    call: () => Promise<T>,
    deadline: number,
    eventId?: string,
  ): Promise<T> {
    const remaining = deadline - this.dependencies.now();
    if (remaining <= 0) this.failUnknownOutcome(eventId);

    let timer: ReturnType<typeof scheduleTimeout> | undefined;
    let rejectTimeout: ((reason: typeof DEADLINE_EXPIRED) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const armTimer = (duration: number): void => {
      timer = scheduleTimeout(() => rejectTimeout?.(DEADLINE_EXPIRED), duration);
    };
    armTimer(remaining);

    let provider: Promise<T>;
    try {
      provider = Promise.resolve(call());
    } catch (error) {
      provider = Promise.reject(error);
    }
    void provider.catch(() => undefined);

    try {
      const remainingAfterCall = deadline - this.dependencies.now();
      if (remainingAfterCall <= 0) this.failUnknownOutcome(eventId);
      if (remainingAfterCall < remaining) {
        if (timer !== undefined) clearTimeout(timer);
        armTimer(remainingAfterCall);
      }
      const result = await Promise.race([provider, timeout]);
      if (this.dependencies.now() >= deadline) this.failUnknownOutcome(eventId);
      return result;
    } catch (error) {
      if (error === DEADLINE_EXPIRED || this.dependencies.now() >= deadline) {
        this.failUnknownOutcome(eventId);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private notifyRememberCompleted(sourceAttemptId: string, memoryIds: readonly string[]): void {
    try {
      this.dependencies.onRememberCompleted?.({
        sourceAttemptId,
        memoryIds: [...memoryIds],
      });
    } catch {
      throw sanitizedError("observer_failed");
    }
  }

  private assertUsable(): void {
    if (this.quarantined) throw sanitizedError("instance_quarantined");
  }

  private assertWithinDeadline(deadline: number, eventId?: string): void {
    if (this.dependencies.now() >= deadline) this.failUnknownOutcome(eventId);
  }

  private failUnknownOutcome(eventId?: string): never {
    this.failAndQuarantine(sanitizedError("ingestion_outcome_unknown", eventId));
  }

  private failAndQuarantine(error: Mem0MemoryError): never {
    this.quarantined = true;
    throw error;
  }

  private toMemoryWriteError(error: unknown): MemoryWriteError {
    if (error instanceof MemoryWriteError) return error;
    if (error instanceof MemoryBindingError) throw error;
    if (error instanceof Mem0MemoryError) {
      const bindingError = toBindingError(error);
      if (bindingError !== null) throw bindingError;
    }
    if (error instanceof Mem0MemoryError && error.code === "ingestion_outcome_unknown") {
      return new MemoryWriteError("write_outcome_unknown");
    }
    return new MemoryWriteError("write_failed");
  }
}
