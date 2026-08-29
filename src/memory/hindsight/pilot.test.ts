import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HINDSIGHT_PILOT_LESSONS_PATH,
  HINDSIGHT_PILOT_QUERIES_PATH,
  executeHindsightPilot,
  hindsightPilotP95,
  hindsightPilotPasses,
  loadHindsightPilotManifests,
  parseHindsightPilotArgs,
  runHindsightPilot,
  serializeHindsightPilotSummary,
  validateHindsightPilotSourceBindings,
  validateHindsightPilotManifests,
  type HindsightPilotManifests,
  type HindsightPilotRetirementReason,
  type HindsightPilotSummary,
} from "./pilot.ts";
import {
  createHindsightMemory,
  loadHindsightMemoryConfig,
} from "./memory.ts";
import { HindsightMemoryError } from "./error.ts";
import {
  resolveHindsightMemorySource,
  type HindsightMemoryResult,
  type HindsightPlatformPort,
  type HindsightRetainResponse,
} from "./platform-contract.ts";

const pilotSource = resolveHindsightMemorySource({
  memoryRef: "memory/hindsight/pilot-v1",
  bankId: "bank-hindsight-pilot-v1",
  purpose: "pilot",
});
const integrationSource = resolveHindsightMemorySource({
  memoryRef: "memory/hindsight/integration-v1",
  bankId: "bank-hindsight-integration-v1",
  purpose: "integration",
});

function parseManifest(source: string): unknown[] {
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function frozenManifests(): Promise<HindsightPilotManifests> {
  const [lessonSource, querySource] = await Promise.all([
    readFile(HINDSIGHT_PILOT_LESSONS_PATH, "utf8"),
    readFile(HINDSIGHT_PILOT_QUERIES_PATH, "utf8"),
  ]);
  const validated = validateHindsightPilotManifests(
    parseManifest(lessonSource),
    parseManifest(querySource),
  );
  return {
    ...validated,
    lessonManifestSha256: createHash("sha256").update(lessonSource, "utf8").digest("hex"),
    queryManifestSha256: createHash("sha256").update(querySource, "utf8").digest("hex"),
  };
}

function successResponse(bankId: string): HindsightRetainResponse {
  return {
    success: true,
    bankId,
    itemsCount: 1,
    async: false,
    operationId: null,
    usage: null,
  };
}

function result(documentId: string, text: string): HindsightMemoryResult {
  return {
    id: `fact-${documentId}`,
    text,
    type: "world",
    context: null,
    metadata: null,
    documentId,
    sourceFactIds: null,
    scores: null,
  };
}

function basePlatform(overrides: Partial<HindsightPlatformPort> = {}): HindsightPlatformPort {
  return {
    getVersion: async () => ({ apiVersion: "hindsight-test-v1" }),
    listDocuments: async () => ({ total: 0 }),
    retain: async () => successResponse(pilotSource.bankId),
    recall: async () => ({ results: [] }),
    ...overrides,
  };
}

test("frozen manifests have exact 30/30/5 cardinalities, strata, links and unique IDs", async () => {
  const manifests = await frozenManifests();
  assert.equal(manifests.lessons.length, 30);
  assert.equal(manifests.queries.length, 30);
  assert.equal(new Set(manifests.lessons.map((entry) => entry.caseId)).size, 30);
  assert.equal(new Set(manifests.queries.map((entry) => entry.caseId)).size, 30);
  assert.equal(new Set(manifests.lessons.map((entry) => entry.lesson.sourceAttemptId)).size, 30);
  assert.equal(manifests.queries.filter((entry) => entry.features.length === 0).length, 5);
  for (const stratum of ["positive", "negative", "comparison", "ambiguous", "incomplete"] as const) {
    assert.equal(manifests.lessons.filter((entry) => entry.stratum === stratum).length, 6);
  }
  assert.deepEqual(
    manifests.lessons.map((entry) => entry.caseId).sort(),
    manifests.queries.map((entry) => entry.caseId).sort(),
  );
  for (const lesson of manifests.lessons) {
    assert.equal(lesson.expectedDocumentId, lesson.lesson.sourceAttemptId.trim());
  }
});

test("manifest loader hashes exact UTF-8 bytes only after tracked-clean verification", async () => {
  const [lessonSource, querySource] = await Promise.all([
    readFile(HINDSIGHT_PILOT_LESSONS_PATH, "utf8"),
    readFile(HINDSIGHT_PILOT_QUERIES_PATH, "utf8"),
  ]);
  const loaded = await loadHindsightPilotManifests({
    verifyTrackedClean: () => true,
    loadReviewedSource: (path) => path.endsWith("lessons.jsonl") ? lessonSource : querySource,
  });
  assert.equal(loaded.lessonManifestSha256, createHash("sha256").update(lessonSource, "utf8").digest("hex"));
  assert.equal(loaded.queryManifestSha256, createHash("sha256").update(querySource, "utf8").digest("hex"));

  await assert.rejects(
    loadHindsightPilotManifests({ verifyTrackedClean: () => false }),
    /Hindsight pilot manifests are invalid/,
  );
});

test("P95 uses nearest rank and summary redaction/pass gates are closed", () => {
  assert.equal(hindsightPilotP95([]), null);
  assert.equal(hindsightPilotP95([40, 10, 30, 20]), 40);
  assert.equal(
    hindsightPilotP95(Array.from({ length: 20 }, (_value, index) => 20 - index)),
    19,
  );
  const summary = {
    runId: "run-1",
    bankId: pilotSource.bankId,
    apiVersion: "v1",
    lessonManifestSha256: "a".repeat(64),
    queryManifestSha256: "b".repeat(64),
    lessonCases: 30,
    queryCases: 30,
    emptyFeatureCases: 5,
    sourceIdsPreserved: 30,
    lessonsWithGroundedFact: 24,
    crossAttemptMerges: 0,
    forbiddenClaims: 0,
    queriesWithExpectedEvidence: 24,
    writeFailures: 0,
    recallFailures: 0,
    writeP95Ms: 180_000,
    readP95Ms: 60_000,
    quarantined: false,
    passed: false,
  } as const;
  assert.equal(hindsightPilotPasses(summary), true);
  assert.equal(serializeHindsightPilotSummary(summary).includes("lesson text"), false);
  assert.equal(serializeHindsightPilotSummary(summary).includes("query text"), false);
  assert.equal(serializeHindsightPilotSummary(summary).includes("api-key"), false);
  assert.deepEqual(Object.keys(JSON.parse(serializeHindsightPilotSummary(summary))).sort(), [
    "apiVersion",
    "bankId",
    "crossAttemptMerges",
    "emptyFeatureCases",
    "forbiddenClaims",
    "lessonCases",
    "lessonManifestSha256",
    "lessonsWithGroundedFact",
    "passed",
    "quarantined",
    "queryCases",
    "queryManifestSha256",
    "queriesWithExpectedEvidence",
    "readP95Ms",
    "recallFailures",
    "runId",
    "sourceIdsPreserved",
    "writeFailures",
    "writeP95Ms",
  ].sort());
});

test("pilot and integration source bindings require distinct Cloud banks and purposes", () => {
  assert.doesNotThrow(() =>
    validateHindsightPilotSourceBindings({ pilot: pilotSource, integration: integrationSource }),
  );
  for (const invalid of [
    { pilot: integrationSource, integration: integrationSource },
    { pilot: pilotSource, integration: { ...integrationSource, purpose: "pilot" } },
    { pilot: { ...pilotSource, purpose: "integration" }, integration: integrationSource },
    { pilot: { ...pilotSource, bankId: integrationSource.bankId }, integration: integrationSource },
  ]) {
    assert.throws(
      () => validateHindsightPilotSourceBindings(invalid as never),
      /Hindsight pilot manifests are invalid/,
    );
  }
});

test("successful pilot is FIFO, performs immediate/raw plus 60/300 checkpoints, and never writes after training", async () => {
  const manifests = await frozenManifests();
  const config = loadHindsightMemoryConfig(pilotSource, { HINDSIGHT_API_KEY: "test-api-key" });
  const retainBanks: string[] = [];
  const recallQueries: string[] = [];
  let rawRecallIndex = 0;
  let trainingDone = false;
  const sleeps: number[] = [];
  const platform = basePlatform({
    retain: async (request) => {
      assert.equal(trainingDone, false);
      retainBanks.push(request.bankId);
      return successResponse(pilotSource.bankId);
    },
    recall: async (request) => {
      recallQueries.push(request.query);
      const index = rawRecallIndex++;
      if (index < manifests.lessons.length) {
        const current = manifests.lessons[index]!;
        return { results: [result(current.expectedDocumentId, current.expectedFactTerms[0] ?? "cue")] };
      }
      const current = manifests.queries[(index - manifests.lessons.length) % manifests.queries.length]!;
      return { results: [result(current.expectedDocumentIds[0]!, current.expectedTerms.join(" "))] };
    },
  });
  const retirements: HindsightPilotRetirementReason[] = [];
  const summary = await runHindsightPilot({
    manifests,
    config,
    sources: { pilot: pilotSource, integration: integrationSource },
    platform,
    now: () => 0,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      trainingDone = milliseconds === 240_000;
    },
    createRunId: () => "run-test",
    onBankRetirementRequired: (reason) => retirements.push(reason),
  });

  assert.equal(retainBanks.length, 30);
  assert.equal(rawRecallIndex, 90);
  assert.equal(recallQueries.length, 90);
  assert.equal(summary.sourceIdsPreserved, 30);
  assert.equal(summary.lessonsWithGroundedFact, 30);
  assert.equal(summary.queriesWithExpectedEvidence, 30);
  assert.equal(summary.crossAttemptMerges, 0);
  assert.equal(summary.forbiddenClaims, 0);
  assert.equal(summary.writeFailures, 0);
  assert.equal(summary.recallFailures, 0);
  assert.equal(summary.quarantined, false);
  assert.equal(summary.passed, true);
  assert.deepEqual(retirements, []);
  assert.deepEqual(sleeps, [60_000, 240_000]);
});

test("non-empty preflight retires the bank and constructs no memory", async () => {
  const manifests = await frozenManifests();
  const config = loadHindsightMemoryConfig(pilotSource, { HINDSIGHT_API_KEY: "test-api-key" });
  let memoryCreations = 0;
  let platformCalls = 0;
  const retirements: HindsightPilotRetirementReason[] = [];
  const summary = await runHindsightPilot({
    manifests,
    config,
    sources: { pilot: pilotSource, integration: integrationSource },
    platform: basePlatform({
      getVersion: async () => { platformCalls += 1; return { apiVersion: "v1" }; },
      listDocuments: async () => { platformCalls += 1; return { total: 1 }; },
    }),
    createMemory: () => { memoryCreations += 1; throw new Error("must not construct"); },
    sleep: async () => undefined,
    onBankRetirementRequired: (reason) => retirements.push(reason),
  });
  assert.equal(platformCalls, 2);
  assert.equal(memoryCreations, 0);
  assert.equal(summary.writeFailures, 1);
  assert.equal(summary.passed, false);
  assert.deepEqual(retirements, ["non_empty_preflight"]);
});

test("aborted version preflight marks a harness failure and retires without constructing memory", async () => {
  const manifests = await frozenManifests();
  const loadedConfig = loadHindsightMemoryConfig(pilotSource, { HINDSIGHT_API_KEY: "test-api-key" });
  const config = { ...loadedConfig, readTimeoutMs: 5 };
  let memoryCreations = 0;
  const events: string[] = [];
  const retirements: HindsightPilotRetirementReason[] = [];
  let summary!: HindsightPilotSummary;
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    summary = await runHindsightPilot({
      manifests,
      config,
      sources: { pilot: pilotSource, integration: integrationSource },
      platform: basePlatform({
        getVersion: async ({ signal }) => {
          events.push("getVersion");
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              events.push("version-aborted");
              reject(new HindsightMemoryError("timeout", "config"));
            }, { once: true });
          });
        },
      }),
      createMemory: () => {
        memoryCreations += 1;
        throw new Error("must not construct after abort");
      },
      onBankRetirementRequired: (reason) => retirements.push(reason),
    });
  } finally {
    clearTimeout(keepAlive);
  }

  assert.deepEqual(events, ["getVersion", "version-aborted"]);
  assert.equal(memoryCreations, 0);
  assert.equal(summary.apiVersion, "unknown");
  assert.equal(summary.recallFailures, 1);
  assert.equal(summary.writeFailures, 0);
  assert.equal(summary.quarantined, false);
  assert.equal(summary.passed, false);
  assert.deepEqual(retirements, ["harness_failure"]);
});

test("unknown write outcome quarantines, retires and stops before raw reads", async () => {
  const manifests = await frozenManifests();
  const config = loadHindsightMemoryConfig(pilotSource, { HINDSIGHT_API_KEY: "test-api-key" });
  let retainCalls = 0;
  let recallCalls = 0;
  const retirements: HindsightPilotRetirementReason[] = [];
  const summary = await runHindsightPilot({
    manifests,
    config,
    sources: { pilot: pilotSource, integration: integrationSource },
    platform: basePlatform({
      retain: async () => {
        retainCalls += 1;
        throw new HindsightMemoryError("write_outcome_unknown", "write");
      },
      recall: async () => { recallCalls += 1; return { results: [] }; },
    }),
    sleep: async () => undefined,
    onBankRetirementRequired: (reason) => retirements.push(reason),
  });
  assert.equal(retainCalls, 1);
  assert.equal(recallCalls, 0);
  assert.equal(summary.quarantined, true);
  assert.equal(summary.writeFailures, 1);
  assert.equal(summary.passed, false);
  assert.deepEqual(retirements, ["unknown_write_outcome", "unknown_write_outcome"]);
});

test("execute gate refuses missing API key before constructing Cloud platform", async () => {
  const manifests = await frozenManifests();
  let platformCreations = 0;
  const printed: string[] = [];
  const summaries: HindsightPilotSummary[] = [];
  const exitCode = await executeHindsightPilot({
    manifests,
    env: {},
    pilotSource: { memoryRef: pilotSource.memoryRef, bankId: pilotSource.bankId },
    integrationSource: { memoryRef: integrationSource.memoryRef, bankId: integrationSource.bankId },
    createPlatform: () => {
      platformCreations += 1;
      throw new Error("Cloud must not start");
    },
    writeSummary: async (_path, summary) => summaries.push(summary),
    printSummary: (line) => printed.push(line),
  });
  assert.equal(exitCode, 1);
  assert.equal(platformCreations, 0);
  assert.equal(summaries.length, 1);
  assert.equal(printed.length, 1);
  assert.equal(JSON.parse(printed[0]!).writeFailures, 1);
});

test("pilot source CLI args require both distinct bindings and contain no environment additions", () => {
  assert.deepEqual(parseHindsightPilotArgs([
    "--pilot-memory-ref", "pilot-ref",
    "--pilot-bank-id", "pilot-bank",
    "--integration-memory-ref", "integration-ref",
    "--integration-bank-id", "integration-bank",
  ]), {
    pilot: { memoryRef: "pilot-ref", bankId: "pilot-bank" },
    integration: { memoryRef: "integration-ref", bankId: "integration-bank" },
  });
  assert.equal(parseHindsightPilotArgs([]), null);
});
