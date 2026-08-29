import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mem0MemoryError } from "./memory.ts";
import type { Mem0PlatformPort, Mem0Record } from "./platform.ts";
import {
  MEM0_PILOT_LESSONS_PATH,
  MEM0_PILOT_QUERIES_PATH,
  executeMem0Pilot,
  factIsDistorted,
  factMatchesExpected,
  loadMem0PilotManifests,
  runMem0Pilot,
  validateMem0PilotManifests,
  type Mem0PilotManifests,
  type Mem0PilotMemoryFactory,
} from "./pilot.ts";

const integrationEnv = {
  MEM0_INTEGRATION: "1",
  MEM0_API_KEY: "test-api-key",
  MEM0_AGENT_ID: "one-use-agent",
  MEM0_INGESTION_TIMEOUT_MS: "100",
  MEM0_POLL_INTERVAL_MS: "1",
};

function platformWithRecords(
  records: Map<string, Mem0Record>,
  list: Mem0PlatformPort["list"] = async () => [],
): Mem0PlatformPort {
  return {
    add: async () => {
      throw new Error("unexpected add");
    },
    getEvent: async () => {
      throw new Error("unexpected getEvent");
    },
    get: async (id) => records.get(id) ?? null,
    list,
    search: async () => {
      throw new Error("unexpected search");
    },
  };
}

function successfulRuntime(manifests: Mem0PilotManifests): {
  platform: Mem0PlatformPort;
  createMemory: Mem0PilotMemoryFactory;
} {
  const records = new Map<string, Mem0Record>();
  const sourceByQuery = new Map(
    manifests.queries.map((query) => [query.features.join("\n"), query.expectedSourceAttemptIds[0] as string]),
  );
  return {
    platform: platformWithRecords(records),
    createMemory: (_config, _platform, observer) => ({
      async remember(lesson) {
        const id = `memory-${lesson.sourceAttemptId}`;
        records.set(id, {
          id,
          memory: lesson.content,
          metadata: { loci_source_attempt_id: lesson.sourceAttemptId },
        });
        observer({ sourceAttemptId: lesson.sourceAttemptId, memoryIds: [id] });
      },
      async recall(features, limit) {
        assert.equal(limit, 5);
        const source = sourceByQuery.get(features.join("\n"));
        return source === undefined
          ? []
          : [{ lessonId: `memory-${source}`, text: records.get(`memory-${source}`)?.memory ?? "" }];
      },
    }),
  };
}

test("frozen pilot manifests contain exactly 30 valid matched unique cases", async () => {
  const manifests = await loadMem0PilotManifests();
  assert.equal(manifests.lessons.length, 30);
  assert.equal(manifests.queries.length, 30);
  assert.equal(new Set(manifests.lessons.map((entry) => entry.caseId)).size, 30);
  assert.equal(new Set(manifests.queries.map((entry) => entry.caseId)).size, 30);
  assert.deepEqual(
    manifests.queries.map((entry) => entry.caseId).sort(),
    manifests.lessons.map((entry) => entry.caseId).sort(),
  );

  const first = manifests.lessons[0] as (typeof manifests.lessons)[number];
  assert.equal(factMatchesExpected("ICELAND has yellow posts", first.expectedAnyFact), true);
  assert.equal(factMatchesExpected("unrelated fact", first.expectedAnyFact), false);
  assert.equal(factIsDistorted("This always identifies a place", first.forbiddenFactSubstrings), true);
});

test("manifest validation rejects count, duplicate, schema and cross-reference errors", async () => {
  const manifests = await loadMem0PilotManifests();
  const lessons = structuredClone(manifests.lessons) as unknown[];
  const queries = structuredClone(manifests.queries) as unknown[];

  assert.throws(() => validateMem0PilotManifests(lessons.slice(1), queries));
  const duplicateLessons = structuredClone(lessons);
  duplicateLessons[1] = duplicateLessons[0];
  assert.throws(() => validateMem0PilotManifests(duplicateLessons, queries));
  const duplicateQueries = structuredClone(queries);
  duplicateQueries[1] = duplicateQueries[0];
  assert.throws(() => validateMem0PilotManifests(lessons, duplicateQueries));
  const duplicateSources = structuredClone(lessons) as Array<{
    lesson: { sourceAttemptId: string };
  }>;
  duplicateSources[1]!.lesson.sourceAttemptId = duplicateSources[0]!.lesson.sourceAttemptId;
  assert.throws(() => validateMem0PilotManifests(duplicateSources, queries));
  const malformedLessons = structuredClone(lessons) as Array<Record<string, unknown>>;
  malformedLessons[0] = { caseId: "case-01" };
  assert.throws(() => validateMem0PilotManifests(malformedLessons, queries));
  const badQueries = structuredClone(queries) as Array<{
    caseId: string;
    features: string[];
    expectedSourceAttemptIds: string[];
  }>;
  badQueries[0] = { ...badQueries[0]!, expectedSourceAttemptIds: ["unknown-source"] };
  assert.throws(() => validateMem0PilotManifests(lessons, badQueries));
  const unknownCase = structuredClone(queries) as typeof badQueries;
  unknownCase[0] = { ...unknownCase[0]!, caseId: "unknown-case" };
  assert.throws(() => validateMem0PilotManifests(lessons, unknownCase));
  const duplicateExpectedSources = structuredClone(queries) as typeof badQueries;
  const source = duplicateExpectedSources[0]!.expectedSourceAttemptIds[0] as string;
  duplicateExpectedSources[0] = {
    ...duplicateExpectedSources[0]!,
    expectedSourceAttemptIds: [source, source],
  };
  assert.throws(() => validateMem0PilotManifests(lessons, duplicateExpectedSources));
});

test("direct harness callers cannot bypass manifest validation before preflight", async () => {
  const manifests = await loadMem0PilotManifests();
  let listCalls = 0;
  let memoryCreations = 0;
  await assert.rejects(
    runMem0Pilot({
      manifests: { ...manifests, lessons: manifests.lessons.slice(1) },
      config: {
        apiKey: "test-api-key",
        agentId: "one-use-agent",
        ingestionTimeoutMs: 100,
        pollIntervalMs: 1,
      },
      platform: platformWithRecords(new Map(), async () => {
        listCalls += 1;
        return [];
      }),
      createMemory: () => {
        memoryCreations += 1;
        throw new Error("must not construct memory");
      },
    }),
    /Mem0 pilot manifests are invalid/,
  );
  assert.equal(listCalls, 0);
  assert.equal(memoryCreations, 0);
});

test("invalid manifests exit before Cloud calls and before summary creation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mem0-pilot-invalid-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const lessonsPath = join(directory, "lessons.jsonl");
  const queriesPath = join(directory, "queries.jsonl");
  await writeFile(lessonsPath, "{not-json}\n", "utf8");
  await writeFile(queriesPath, await readFile(MEM0_PILOT_QUERIES_PATH, "utf8"), "utf8");

  let platformCalls = 0;
  const summaries: string[] = [];
  const errors: string[] = [];
  const exitCode = await executeMem0Pilot({
    env: integrationEnv,
    lessonsPath,
    queriesPath,
    createPlatform: () => {
      platformCalls += 1;
      return platformWithRecords(new Map());
    },
    printSummary: (line) => summaries.push(line),
    printError: (line) => errors.push(line),
  });
  assert.equal(exitCode, 1);
  assert.equal(platformCalls, 0);
  assert.deepEqual(summaries, []);
  assert.deepEqual(errors, ["Mem0 pilot manifests are invalid"]);
});

test("integration gate prints one aborted summary without Cloud construction", async () => {
  let platformCalls = 0;
  const summaries: string[] = [];
  const errors: string[] = [];
  const exitCode = await executeMem0Pilot({
    env: { MEM0_INTEGRATION: "0" },
    createPlatform: () => {
      platformCalls += 1;
      return platformWithRecords(new Map());
    },
    printSummary: (line) => summaries.push(line),
    printError: (line) => errors.push(line),
  });
  assert.equal(exitCode, 1);
  assert.equal(platformCalls, 0);
  assert.equal(summaries.length, 1);
  assert.deepEqual(JSON.parse(summaries[0] as string), {
    lessonCases: 0,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 1,
    aborted: true,
    instanceQuarantined: false,
    scopeRetired: false,
    passed: false,
  });
  assert.deepEqual(errors, []);
});

test("successful harness counts extraction and provenance and prints one passing summary", async () => {
  const manifests = await loadMem0PilotManifests();
  const runtime = successfulRuntime(manifests);
  const summaries: string[] = [];
  const exitCode = await executeMem0Pilot({
    env: integrationEnv,
    createPlatform: () => runtime.platform,
    createMemory: runtime.createMemory,
    printSummary: (line) => summaries.push(line),
    printError: () => undefined,
  });
  assert.equal(exitCode, 0);
  assert.equal(summaries.length, 1);
  const summary = JSON.parse(summaries[0] as string) as Record<string, unknown>;
  assert.deepEqual(summary, {
    lessonCases: 30,
    lessonsWithCorrectFact: 30,
    extractedFacts: 30,
    distortedFacts: 0,
    queryCases: 30,
    queriesWithExpectedFactInTop5: 30,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 0,
    aborted: false,
    instanceQuarantined: false,
    scopeRetired: true,
    passed: true,
  });
});

test("pass gates accept exact 24-of-30 boundaries and reject lower or distorted results", async () => {
  const manifests = await loadMem0PilotManifests();
  const lessonIndexBySource = new Map(
    manifests.lessons.map((entry, index) => [entry.lesson.sourceAttemptId, index]),
  );
  const lessonBySource = new Map(
    manifests.lessons.map((entry) => [entry.lesson.sourceAttemptId, entry]),
  );

  const runScenario = async (
    correctLessonCases: number,
    correctQueryCases: number,
    distorted: boolean,
  ) => {
    const records = new Map<string, Mem0Record>();
    let queryIndex = 0;
    const createMemory: Mem0PilotMemoryFactory = (_config, _platform, observer) => ({
      async remember(value) {
        const index = lessonIndexBySource.get(value.sourceAttemptId);
        const lessonCase = lessonBySource.get(value.sourceAttemptId);
        if (index === undefined || lessonCase === undefined) throw new Error("unknown lesson fixture");
        const signal = lessonCase.expectedAnyFact[0];
        if (signal === undefined) throw new Error("missing expected signal");
        let fact = index < correctLessonCases ? signal.allOf.join(" ") : "unrelated visual cue";
        if (distorted && index === 0) {
          const forbidden = lessonCase.forbiddenFactSubstrings[0];
          if (forbidden === undefined) throw new Error("missing forbidden signal");
          fact = `${fact} ${forbidden}`;
        }
        const id = `memory-${value.sourceAttemptId}`;
        records.set(id, {
          id,
          memory: fact,
          metadata: { loci_source_attempt_id: value.sourceAttemptId },
        });
        observer({ sourceAttemptId: value.sourceAttemptId, memoryIds: [id] });
      },
      async recall(_features, limit) {
        assert.equal(limit, 5);
        const queryCase = manifests.queries[queryIndex];
        const shouldMatch = queryIndex < correctQueryCases;
        queryIndex += 1;
        if (!shouldMatch || queryCase === undefined) return [];
        const sourceAttemptId = queryCase.expectedSourceAttemptIds[0];
        if (sourceAttemptId === undefined) throw new Error("missing query source fixture");
        return [
          {
            lessonId: `memory-${sourceAttemptId}`,
            text: records.get(`memory-${sourceAttemptId}`)?.memory ?? "",
          },
        ];
      },
    });
    return runMem0Pilot({
      manifests,
      config: {
        apiKey: "test-api-key",
        agentId: "one-use-agent",
        ingestionTimeoutMs: 100,
        pollIntervalMs: 1,
      },
      platform: platformWithRecords(records),
      createMemory,
    });
  };

  const boundary = await runScenario(24, 24, false);
  assert.deepEqual(boundary, {
    lessonCases: 30,
    lessonsWithCorrectFact: 24,
    extractedFacts: 30,
    distortedFacts: 0,
    queryCases: 30,
    queriesWithExpectedFactInTop5: 24,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 0,
    aborted: false,
    instanceQuarantined: false,
    scopeRetired: true,
    passed: true,
  });

  const insufficientLessons = await runScenario(23, 24, false);
  assert.equal(insufficientLessons.lessonsWithCorrectFact, 23);
  assert.equal(insufficientLessons.passed, false);

  const insufficientQueries = await runScenario(24, 23, false);
  assert.equal(insufficientQueries.queriesWithExpectedFactInTop5, 23);
  assert.equal(insufficientQueries.passed, false);

  const distorted = await runScenario(24, 24, true);
  assert.equal(distorted.distortedFacts, 1);
  assert.equal(distorted.passed, false);
});

test("post-preflight construction failure retires scope and prints one failing summary", async () => {
  const invocations: string[] = [];
  const summaries: string[] = [];
  const errors: string[] = [];
  const exitCode = await executeMem0Pilot({
    env: integrationEnv,
    createPlatform: () => {
      invocations.push("createPlatform");
      return platformWithRecords(new Map(), async (agentId) => {
        invocations.push(`list:${agentId}`);
        return [];
      });
    },
    createMemory: () => {
      invocations.push("createMemory");
      throw new Error("raw construction failure");
    },
    printSummary: (line) => summaries.push(line),
    printError: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(invocations, ["createPlatform", "list:one-use-agent", "createMemory"]);
  assert.deepEqual(errors, []);
  assert.equal(summaries.length, 1);
  assert.deepEqual(JSON.parse(summaries[0] as string), {
    lessonCases: 0,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 1,
    aborted: true,
    instanceQuarantined: false,
    scopeRetired: true,
    passed: false,
  });
});

test("failed or non-empty preflight returns exact zero-case non-retired summary", async () => {
  const manifests = await loadMem0PilotManifests();
  for (const outcome of ["non-empty", "failed", "malformed"] as const) {
    let memoryCreations = 0;
    const invocations: string[] = [];
    const list: Mem0PlatformPort["list"] = async (agentId) => {
      invocations.push(`list:${agentId}`);
      if (outcome === "failed") throw new Error("raw preflight error");
      if (outcome === "malformed") return {} as never;
      return [{ id: "existing", memory: "private fact", metadata: {} }];
    };
    const summary = await runMem0Pilot({
      manifests,
      config: {
        apiKey: "test-api-key",
        agentId: "one-use-agent",
        ingestionTimeoutMs: 100,
        pollIntervalMs: 1,
      },
      platform: platformWithRecords(new Map(), list),
      createMemory: () => {
        memoryCreations += 1;
        throw new Error("must not construct memory");
      },
    });
    assert.deepEqual(invocations, ["list:one-use-agent"]);
    assert.equal(memoryCreations, 0);
    assert.deepEqual(summary, {
      lessonCases: 0,
      lessonsWithCorrectFact: 0,
      extractedFacts: 0,
      distortedFacts: 0,
      queryCases: 0,
      queriesWithExpectedFactInTop5: 0,
      writeFailures: 0,
      recallFailures: 0,
      harnessFailures: 1,
      aborted: true,
      instanceQuarantined: false,
      scopeRetired: false,
      passed: false,
    });
  }
});

test("unknown write outcome aborts remaining cases with quarantine and retirement", async () => {
  const manifests = await loadMem0PilotManifests();
  const invocations: string[] = [];
  const summary = await runMem0Pilot({
    manifests,
    config: {
      apiKey: "test-api-key",
      agentId: "one-use-agent",
      ingestionTimeoutMs: 100,
      pollIntervalMs: 1,
    },
    platform: platformWithRecords(new Map()),
    createMemory: () => ({
      async remember(value) {
        invocations.push(`remember:${value.sourceAttemptId}`);
        throw new Mem0MemoryError("ingestion_outcome_unknown", "raw lesson and event");
      },
      async recall(_features, limit) {
        invocations.push(`recall:${limit}`);
        throw new Mem0MemoryError("instance_quarantined", "quarantined");
      },
    }),
  });
  assert.deepEqual(invocations, ["remember:pilot-01", "recall:1"]);
  assert.deepEqual(summary, {
    lessonCases: 1,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 1,
    recallFailures: 0,
    harnessFailures: 0,
    aborted: true,
    instanceQuarantined: true,
    scopeRetired: true,
    passed: false,
  });
});

test("ordinary write failure aborts retired scope without marking quarantine", async () => {
  const manifests = await loadMem0PilotManifests();
  const invocations: string[] = [];
  const summary = await runMem0Pilot({
    manifests,
    config: {
      apiKey: "test-api-key",
      agentId: "one-use-agent",
      ingestionTimeoutMs: 100,
      pollIntervalMs: 1,
    },
    platform: platformWithRecords(new Map()),
    createMemory: () => ({
      async remember(value) {
        invocations.push(`remember:${value.sourceAttemptId}`);
        throw new Mem0MemoryError("authentication", "raw write failure");
      },
      async recall(_features, limit) {
        invocations.push(`recall:${limit}`);
        return [];
      },
    }),
  });

  assert.deepEqual(invocations, ["remember:pilot-01", "recall:1"]);
  assert.deepEqual(summary, {
    lessonCases: 1,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 1,
    recallFailures: 0,
    harnessFailures: 0,
    aborted: true,
    instanceQuarantined: false,
    scopeRetired: true,
    passed: false,
  });
});

test("observer failure aborts as harness failure without quarantine", async () => {
  const manifests = await loadMem0PilotManifests();
  const summary = await runMem0Pilot({
    manifests,
    config: {
      apiKey: "test-api-key",
      agentId: "one-use-agent",
      ingestionTimeoutMs: 100,
      pollIntervalMs: 1,
    },
    platform: platformWithRecords(new Map()),
    createMemory: () => ({
      async remember() {},
      async recall() {
        return [];
      },
    }),
  });
  assert.equal(summary.lessonCases, 1);
  assert.equal(summary.writeFailures, 0);
  assert.equal(summary.harnessFailures, 1);
  assert.equal(summary.aborted, true);
  assert.equal(summary.instanceQuarantined, false);
  assert.equal(summary.scopeRetired, true);
});

test("lesson provenance failure aborts as retired harness failure before later cases", async () => {
  const manifests = await loadMem0PilotManifests();
  const invocations: string[] = [];
  const platform: Mem0PlatformPort = {
    add: async () => {
      throw new Error("unexpected add");
    },
    getEvent: async () => {
      throw new Error("unexpected getEvent");
    },
    get: async (memoryId) => {
      invocations.push(`get:${memoryId}`);
      return null;
    },
    list: async (agentId) => {
      invocations.push(`list:${agentId}`);
      return [];
    },
    search: async () => {
      throw new Error("unexpected search");
    },
  };
  const summary = await runMem0Pilot({
    manifests,
    config: {
      apiKey: "test-api-key",
      agentId: "one-use-agent",
      ingestionTimeoutMs: 100,
      pollIntervalMs: 1,
    },
    platform,
    createMemory: (_config, _platform, observer) => {
      invocations.push("createMemory");
      return {
        async remember(value) {
          invocations.push(`remember:${value.sourceAttemptId}`);
          observer({ sourceAttemptId: value.sourceAttemptId, memoryIds: ["missing-memory"] });
        },
        async recall() {
          invocations.push("recall");
          return [];
        },
      };
    },
  });

  assert.deepEqual(invocations, [
    "list:one-use-agent",
    "createMemory",
    "remember:pilot-01",
    "get:missing-memory",
  ]);
  assert.deepEqual(summary, {
    lessonCases: 1,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 1,
    aborted: true,
    instanceQuarantined: false,
    scopeRetired: true,
    passed: false,
  });
});

test("recall and provenance failures increment once per query and continue", async () => {
  const manifests = await loadMem0PilotManifests();
  const runtime = successfulRuntime(manifests);
  const baseFactory = runtime.createMemory;
  let queryIndex = 0;
  const createMemory: Mem0PilotMemoryFactory = (config, platform, observer) => {
    const memory = baseFactory(config, platform, observer);
    return {
      remember: (value) => memory.remember(value),
      async recall(features, limit) {
        queryIndex += 1;
        if (queryIndex === 1) throw new Error("raw search error");
        if (queryIndex === 2) return [{ lessonId: "missing", text: "missing" }];
        return memory.recall(features, limit);
      },
    };
  };
  const summary = await runMem0Pilot({
    manifests,
    config: {
      apiKey: "test-api-key",
      agentId: "one-use-agent",
      ingestionTimeoutMs: 100,
      pollIntervalMs: 1,
    },
    platform: runtime.platform,
    createMemory,
  });
  assert.equal(summary.queryCases, 30);
  assert.equal(summary.queriesWithExpectedFactInTop5, 28);
  assert.equal(summary.recallFailures, 2);
  assert.equal(summary.aborted, false);
  assert.equal(summary.scopeRetired, true);
  assert.equal(summary.passed, false);
});

test("pilot executable remains absent from default scripts", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts["mem0:pilot"], "node --env-file-if-exists=.env src/memory/mem0/pilot.ts");
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (name === "mem0:pilot" || name === "test:mem0") continue;
    assert.equal(command.includes("memory/mem0/pilot.ts"), false);
  }
  assert.equal(MEM0_PILOT_LESSONS_PATH.endsWith("mem0-pilot-v1-lessons.jsonl"), true);
});
