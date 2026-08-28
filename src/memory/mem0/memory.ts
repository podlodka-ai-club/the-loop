export { Mem0MemoryError, type Mem0MemoryErrorCode } from "./error.ts";
import { setTimeout as scheduleTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import type { Hint, LessonInput, Memory } from "../../memory.ts";
import { MEM0_EXTRACTION_INSTRUCTION } from "./constants.ts";
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

type ResolvedDependencies = {
  platform: Mem0PlatformPort;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onRememberCompleted?: (result: Mem0RememberResult) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export class Mem0Memory implements Memory {
  private readonly config: Mem0MemoryConfig;
  private readonly dependencies: ResolvedDependencies;
  private quarantined = false;
  private rememberTail: Promise<void> = Promise.resolve();

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

  remember(lesson: LessonInput): Promise<void> {
    const operation = this.rememberTail.then(() => this.rememberOne(lesson));
    this.rememberTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async recall(features: string[], limit: number): Promise<Hint[]> {
    this.assertUsable();
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw sanitizedError("invalid_input");
    }
    if (!Array.isArray(features) || features.some((value) => typeof value !== "string")) {
      throw sanitizedError("invalid_input");
    }

    const query = features
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    if (query === "") return [];

    let records: unknown;
    try {
      records = await this.dependencies.platform.search({
        query,
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
        record.memory.trim() === ""
      ) {
        throw sanitizedError("protocol_error");
      }
      return { lessonId: record.id, text: record.memory };
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

  private async rememberOne(lesson: LessonInput): Promise<void> {
    this.assertUsable();
    this.validateLesson(lesson);

    const request = {
      messages: [{ role: "assistant" as const, content: lesson.content }],
      agentId: this.config.agentId,
      infer: true as const,
      temporalReasoning: false as const,
      agentCustomInstructions: MEM0_EXTRACTION_INSTRUCTION,
      metadata: {
        loci_source_attempt_id: lesson.sourceAttemptId,
        loci_triggers: [...lesson.triggers],
        loci_region: lesson.region,
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
  }

  private validateLesson(lesson: LessonInput): void {
    if (
      !isRecord(lesson) ||
      typeof lesson.content !== "string" ||
      lesson.content.trim() === "" ||
      typeof lesson.sourceAttemptId !== "string" ||
      lesson.sourceAttemptId.trim() === "" ||
      !Array.isArray(lesson.triggers) ||
      lesson.triggers.some((trigger) => typeof trigger !== "string") ||
      typeof lesson.region !== "string"
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
    if (error instanceof Mem0MemoryError && error.code === "rate_limited") {
      throw sanitizedError("rate_limited", undefined, true);
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

    const provider = Promise.resolve().then(call);
    let timer: ReturnType<typeof scheduleTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = scheduleTimeout(() => reject(DEADLINE_EXPIRED), remaining);
    });

    try {
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
}
