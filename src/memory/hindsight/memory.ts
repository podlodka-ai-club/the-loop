import type { Hint, LessonInput, Memory } from "../../memory.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  type HindsightMemorySource,
  type HindsightPlatformPort,
} from "./platform-contract.ts";
import { hindsightError } from "./error.ts";

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

/**
 * Phase 1 construction shell. It validates capability/configuration before creating
 * the lazy Cloud port; memory operations are connected in Phase 2.
 */
class HindsightMemoryConstruction implements HindsightMemory {
  readonly #config: HindsightMemoryConfig;
  readonly #dependencies: HindsightMemoryDependencies;

  constructor(config: HindsightMemoryConfig, dependencies: HindsightMemoryDependencies) {
    this.#config = config;
    this.#dependencies = dependencies;
    void this.#config;
    void this.#dependencies;
  }

  async recall(_features: string[], _limit: number): Promise<Hint[]> {
    throw hindsightError("unsupported_operation", "read");
  }

  async remember(_lesson: LessonInput): Promise<void> {
    throw hindsightError("unsupported_operation", "write");
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
  return new HindsightMemoryConstruction(validatedConfig, dependencies);
}
