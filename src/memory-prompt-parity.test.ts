import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeMemoryRetrieveQuery,
  sharedMemoryPrompt,
} from "./memory/memory.ts";
import { createMem0Memory } from "./memory/mem0/memory.ts";
import type { Mem0PlatformPort } from "./memory/mem0/platform.ts";
import { createHindsightMemory } from "./memory/hindsight/memory.ts";
import {
  resolveHindsightMemorySource,
  type HindsightPlatformPort,
} from "./memory/hindsight/platform-contract.ts";
import { createXmemoryMemory } from "./memory/xmemory/memory.ts";
import type { XmemoryPlatformPort } from "./memory/xmemory/platform-contract.ts";
import { loadXmemorySchema } from "./memory/xmemory/schema.ts";

test("all provider-backed retrieve requests use the identical shared prompt envelope", async () => {
  const expected = encodeMemoryRetrieveQuery(sharedMemoryPrompt("retrieve"), "yellow roadside posts");
  const requests: string[] = [];

  const mem0Platform: Mem0PlatformPort = {
    add: async () => ({ eventId: "unused", status: "PENDING" }),
    getEvent: async () => ({ eventId: "unused", status: "SUCCEEDED", memoryIds: [] }),
    get: async () => null,
    list: async () => [],
    search: async (request) => { requests.push(request.query); return []; },
  };
  await createMem0Memory(
    { snapshots: false },
    { apiKey: "test", agentId: "agent", ingestionTimeoutMs: 100, pollIntervalMs: 10 },
    { platform: mem0Platform },
  ).recall("yellow roadside posts", 5);

  const source = resolveHindsightMemorySource({
    memoryRef: "memory/hindsight/parity",
    bankId: "bank-parity",
    purpose: "integration",
  });
  const hindsightPlatform: HindsightPlatformPort = {
    retain: async () => ({ success: true, bankId: source.bankId, itemsCount: 1, async: false, operationId: null, usage: null }),
    recall: async (request) => { requests.push(request.query); return { results: [] }; },
    getVersion: async () => ({ apiVersion: "test" }),
    listDocuments: async () => ({ total: 0 }),
  };
  await createHindsightMemory(
    { snapshots: false },
    {
      source,
      apiKey: "test",
      baseUrl: "https://api.hindsight.vectorize.io",
      writeTimeoutMs: 100,
      readTimeoutMs: 100,
      maxTokens: 100,
      recallBudget: "mid",
    },
    { platform: hindsightPlatform },
  ).recall("yellow roadside posts", 5);

  const schema = await loadXmemorySchema();
  const xmemoryPlatform: XmemoryPlatformPort = {
    getSchema: async () => schema.value,
    write: async () => ({ writeId: "unused", traceId: null, changes: { created: { objects: [], relations: [] }, updated: { objects: [], relations: [] }, deleted: { objects: [], relations: [] } } }),
    read: async (request) => { requests.push(request.query); return { traceId: null, readerResult: { answer: "" } }; },
  };
  await (await createXmemoryMemory(
    { snapshots: false },
    { apiKey: "test", instanceId: "instance", writeTimeoutMs: 100, readTimeoutMs: 100 },
    { platform: xmemoryPlatform, createTraceId: () => "123e4567-e89b-12d3-a456-426614174000" },
  )).recall("yellow roadside posts", 5);

  assert.deepEqual(requests, [expected, expected, expected]);
});
