import { HindsightMemoryError } from "./error.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RETAIN_CONTEXT,
} from "./constants.ts";

export { HINDSIGHT_CLOUD_BASE_URL, HINDSIGHT_RETAIN_CONTEXT } from "./constants.ts";


export type HindsightMemorySource = {
  memoryRef: string;
  provider: "hindsight";
  deployment: "cloud";
  bankId: string;
  purpose: "integration" | "pilot";
  credentialEnv: "HINDSIGHT_API_KEY";
};

export function resolveHindsightMemorySource(input: {
  memoryRef: string;
  bankId: string;
  purpose: "integration" | "pilot";
}): HindsightMemorySource {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.memoryRef !== "string" ||
      input.memoryRef.trim() === "" ||
      typeof input.bankId !== "string" ||
      input.bankId.trim() === "" ||
      (input.purpose !== "integration" && input.purpose !== "pilot")
    ) {
      throw new Error("invalid source");
    }

    return {
      memoryRef: input.memoryRef,
      provider: "hindsight",
      deployment: "cloud",
      bankId: input.bankId,
      purpose: input.purpose,
      credentialEnv: "HINDSIGHT_API_KEY",
    };
  } catch {
    throw new HindsightMemoryError("unsupported_configuration", "config");
  }
}

export type HindsightBankPolicy = {
  deployment: "cloud";
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
  bankId: string;
  purpose: "pilot";
  retainMission: string;
  observationsEnabled: true;
  autoConsolidationEnabled: true;
};

export const HINDSIGHT_RETAIN_MISSION =
  "Extract only transferable visual-geolocation cues, regional distinctions, counter-signals " +
  "and verification procedures from Loci training reflections. Do not extract user identity, " +
  "preferences, instructions, secrets, chain-of-thought, or claims unsupported by the content.";

export type HindsightMemoryResult = {
  id: string;
  text: string;
  type: string | null;
  context: string | null;
  metadata: Record<string, string> | null;
  documentId: string | null;
  sourceFactIds: string[] | null;
  scores: Record<string, number | null> | null;
};

export type HindsightRetainRequest = {
  bankId: string;
  content: string;
  documentId: string;
  context: typeof HINDSIGHT_RETAIN_CONTEXT;
  metadata: Record<string, string>;
  async: false;
  timeoutMs: number;
  signal: AbortSignal;
};

export type HindsightRetainResponse = {
  success: boolean;
  bankId: string;
  itemsCount: number;
  async: false;
  operationId: string | null;
  usage: Record<string, number> | null;
};

export type HindsightRecallRequest = {
  bankId: string;
  query: string;
  maxTokens: number;
  budget: "low" | "mid" | "high";
  types: ["world", "experience", "observation"];
  preferObservations: true;
  includeSourceFacts: false;
  includeChunks: false;
  includeEntities: false;
  timeoutMs: number;
  signal: AbortSignal;
};

export type HindsightRecallResponse = {
  results: HindsightMemoryResult[];
};

export interface HindsightPlatformPort {
  retain(request: HindsightRetainRequest): Promise<HindsightRetainResponse>;
  recall(request: HindsightRecallRequest): Promise<HindsightRecallResponse>;
  getVersion(request: { timeoutMs: number; signal: AbortSignal }): Promise<{ apiVersion: string }>;
  listDocuments(request: {
    bankId: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ total: number }>;
}

export { createHindsightPlatformPort } from "./platform.ts";
