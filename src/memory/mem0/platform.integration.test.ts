import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { loadPrompt } from "../../promts.ts";
import { mem0IntegrationEnabled } from "./integration.ts";
import { Mem0MemoryError, loadMem0MemoryConfig } from "./memory.ts";
import { createMem0PlatformPort } from "./platform.ts";

const integrationTest = mem0IntegrationEnabled() ? test : test.skip;

integrationTest(
  "Mem0 Cloud normalizes add, event, visibility, metadata, list and ranked search",
  { timeout: 130_000 },
  async () => {
    const config = loadMem0MemoryConfig();
    const port = createMem0PlatformPort({ apiKey: config.apiKey });

    // The configured agent id is deliberately never cleaned up. Passing this preflight
    // makes it a one-use scope, which the operator must retire after this test exits.
    const existingCount = (await port.list(config.agentId)).length;
    assert.equal(existingCount, 0, "MEM0_AGENT_ID must be a fresh empty scope");

    const sourceAttemptId = `mem0-contract-spike-${randomUUID()}`;
    const lesson =
      "In rural Iceland, slender yellow roadside delineators with small reflectors often " +
      "stand beside treeless lava or moss terrain; treat the cue as suggestive, not decisive.";
    const accepted = await port.add({
      messages: [{ role: "assistant", content: lesson }],
      agentId: config.agentId,
      infer: true,
      temporalReasoning: false,
      agentCustomInstructions: loadPrompt("memory-store"),
      metadata: {
        loci_source_attempt_id: sourceAttemptId,
        loci_triggers: ["yellow roadside delineators", "treeless lava terrain"],
        loci_region: "Iceland",
      },
    });
    assert.equal(accepted.status, "PENDING");

    const deadline = Date.now() + config.ingestionTimeoutMs;
    let memoryIds: string[] | undefined;
    while (Date.now() < deadline) {
      const event = await port.getEvent(accepted.eventId);
      assert.equal(event.eventId, accepted.eventId);
      if (event.status === "FAILED") assert.fail("Mem0 ingestion failed");
      if (event.status === "SUCCEEDED") {
        memoryIds = event.memoryIds;
        break;
      }
      await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    assert.ok(memoryIds !== undefined, "Mem0 ingestion did not finish before the deadline");
    assert.ok(memoryIds.length > 0, "the approved spike lesson must extract at least one fact");

    const visible = new Map<string, Awaited<ReturnType<typeof port.get>>>();
    while (Date.now() < deadline && visible.size < memoryIds.length) {
      for (const memoryId of memoryIds) {
        if (visible.has(memoryId)) continue;
        try {
          const record = await port.get(memoryId);
          if (record !== null) visible.set(memoryId, record);
        } catch (error) {
          if (!(error instanceof Mem0MemoryError) || error.code !== "unavailable") throw error;
        }
      }
      if (visible.size < memoryIds.length) {
        await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
    }
    assert.equal(visible.size, memoryIds.length, "created facts must become visible");

    for (const [memoryId, record] of visible) {
      assert.equal(record?.id, memoryId);
      assert.equal(record.metadata.loci_source_attempt_id, sourceAttemptId);
    }

    const listed = await port.list(config.agentId);
    for (const memoryId of memoryIds) {
      assert.ok(listed.some((record) => record.id === memoryId));
    }

    const ranked = await port.search({
      query: "yellow roadside delineators beside treeless lava terrain",
      filters: { agent_id: config.agentId },
      topK: 5,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    });
    assert.ok(ranked.some((record) => memoryIds.includes(record.id)));
  },
);
