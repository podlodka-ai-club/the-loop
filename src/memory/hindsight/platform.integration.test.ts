import assert from "node:assert/strict";
import test from "node:test";
import { buildHindsightRetainRequest, loadHindsightMemoryConfig } from "./memory.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RETAIN_CONTEXT,
  resolveHindsightMemorySource,
} from "./platform-contract.ts";
import { createHindsightPlatformPort } from "./platform.ts";
import { parseHindsightPilotArgs } from "./pilot.ts";
import { encodeMemoryRetrieveQuery, sharedMemoryPrompt, normalizeMemoryQuery } from "../memory.ts";

const pilotArgs = parseHindsightPilotArgs(process.argv.slice(2));
const liveGate =
  process.argv.includes("--hindsight-live") &&
  typeof process.env.HINDSIGHT_API_KEY === "string" &&
  process.env.HINDSIGHT_API_KEY.trim() !== "" &&
  pilotArgs !== null;

test(
  "explicit live Cloud integration validates policy, bank isolation and transport smoke",
  { skip: !liveGate },
  async () => {
    assert.ok(pilotArgs);
    const apiKey = process.env.HINDSIGHT_API_KEY;
    assert.equal(typeof apiKey, "string");

    const pilotSource = resolveHindsightMemorySource({
      ...pilotArgs.pilot,
      purpose: "pilot",
    });
    const integrationSource = resolveHindsightMemorySource({
      ...pilotArgs.integration,
      purpose: "integration",
    });
    assert.notEqual(pilotSource.bankId, integrationSource.bankId);
    assert.deepEqual(
      {
        deployment: pilotSource.deployment,
        baseUrl: HINDSIGHT_CLOUD_BASE_URL,
        bankId: pilotSource.bankId,
        purpose: pilotSource.purpose,
        retainMission: sharedMemoryPrompt("store").text,
        observationsEnabled: true,
        autoConsolidationEnabled: true,
      },
      {
        deployment: "cloud",
        baseUrl: HINDSIGHT_CLOUD_BASE_URL,
        bankId: pilotSource.bankId,
        purpose: "pilot",
        retainMission: sharedMemoryPrompt("store").text,
        observationsEnabled: true,
        autoConsolidationEnabled: true,
      },
    );

    const config = loadHindsightMemoryConfig(integrationSource, {
      HINDSIGHT_API_KEY: apiKey,
    });
    const platform = createHindsightPlatformPort({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    const version = await platform.getVersion({
      timeoutMs: config.readTimeoutMs,
      signal: AbortSignal.timeout(config.readTimeoutMs),
    });
    assert.match(version.apiVersion, /\S/);

    const emptyPilotBank = await platform.listDocuments({
      bankId: pilotSource.bankId,
      timeoutMs: config.readTimeoutMs,
      signal: AbortSignal.timeout(config.readTimeoutMs),
    });
    assert.equal(emptyPilotBank.total, 0);

    const lesson = {
      content: "Synthetic integration smoke lesson about a painted roadside marker.",
      sourceAttemptId: "hindsight-integration-smoke-001",
      triggers: ["painted roadside marker"],
      region: "synthetic-test-region",
    };
    const retain = await platform.retain(
      buildHindsightRetainRequest(
        integrationSource.bankId,
        lesson,
        config.writeTimeoutMs,
      ),
    );
    assert.equal(retain.success, true);
    assert.equal(retain.bankId, integrationSource.bankId);
    assert.equal(retain.itemsCount, 1);
    assert.equal(retain.async, false);
    assert.equal(retain.operationId, null);

    const recall = await platform.recall({
      bankId: integrationSource.bankId,
      query: encodeMemoryRetrieveQuery(sharedMemoryPrompt("retrieve"), normalizeMemoryQuery(lesson.triggers)),
      maxTokens: config.maxTokens,
      budget: config.recallBudget,
      types: ["world", "experience", "observation"],
      preferObservations: true,
      includeSourceFacts: false,
      includeChunks: false,
      includeEntities: false,
      timeoutMs: config.readTimeoutMs,
      signal: AbortSignal.timeout(config.readTimeoutMs),
    });
    assert.ok(Array.isArray(recall.results));
    for (const result of recall.results) {
      assert.match(result.id, /\S/);
      assert.match(result.text, /\S/);
      assert.equal(result.documentId === null || typeof result.documentId === "string", true);
    }

    assert.equal(
      buildHindsightRetainRequest(
        integrationSource.bankId,
        lesson,
        config.writeTimeoutMs,
      ).context,
      HINDSIGHT_RETAIN_CONTEXT,
    );
    assert.notEqual(integrationSource.bankId, pilotSource.bankId);
  },
);
