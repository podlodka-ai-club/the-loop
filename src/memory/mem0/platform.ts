import { createProductionMem0PlatformPort } from "./platform-internal.ts";

export const MEM0_PLATFORM_BASE_URL = "https://api.mem0.ai";

export type Mem0EventStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type Mem0Record = {
  id: string;
  memory: string;
  score?: number;
  metadata: Record<string, unknown>;
};

export type Mem0AddRequest = {
  messages: Array<{ role: "assistant"; content: string }>;
  agentId: string;
  infer: true;
  temporalReasoning: false;
  agentCustomInstructions: string;
  metadata: {
    loci_source_attempt_id: string;
    loci_triggers: string[];
    loci_region: string;
    loci_feature_key?: string;
    loci_memory_hit_id?: string;
    loci_effect?: string;
    loci_idempotency_key?: string;
  };
};

export type Mem0SearchRequest = {
  query: string;
  filters: { agent_id: string };
  topK: number;
  threshold: 0.1;
  rerank: false;
  keywordSearch: true;
};

export interface Mem0PlatformPort {
  add(request: Mem0AddRequest): Promise<{ eventId: string; status: "PENDING" }>;
  getEvent(eventId: string): Promise<{
    eventId: string;
    status: Mem0EventStatus;
    memoryIds?: string[];
    error?: string;
  }>;
  get(memoryId: string): Promise<Mem0Record | null>;
  list(agentId: string): Promise<Mem0Record[]>;
  search(request: Mem0SearchRequest): Promise<Mem0Record[]>;
}

export function createMem0PlatformPort(config: {
  apiKey: string;
  baseUrl?: typeof MEM0_PLATFORM_BASE_URL;
}): Mem0PlatformPort {
  return createProductionMem0PlatformPort(config, MEM0_PLATFORM_BASE_URL);
}
