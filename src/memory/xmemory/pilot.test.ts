import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { XmemoryMemoryError } from "./memory.ts";
import type { XmemoryPlatformPort } from "./platform-contract.ts";
import { loadXmemorySchema } from "./schema.ts";
import {
  XMEMORY_PILOT_EMPTY_QUERY,
  XMEMORY_PILOT_LESSONS_PATH,
  XMEMORY_PILOT_QUERIES_PATH,
  executeXmemoryPilot,
  loadXmemoryPilotManifests,
  runXmemoryPilot,
  validateXmemoryPilotManifests,
  verifyXmemoryPilotTrackedClean,
  writeXmemoryPilotSummaryAtomic,
  xmemoryPilotP95,
  xmemoryPilotPassesWithoutQuota,
  type XmemoryPilotManifests,
  type XmemoryPilotMemoryFactory,
  type XmemoryPilotSummary,
} from "./pilot.ts";

type UnknownRecord = Record<string, unknown>;

const loadWorktreeReviewedSource = (path: string): Promise<string> => readFile(path, "utf8");

async function manifests(): Promise<XmemoryPilotManifests> {
  return loadXmemoryPilotManifests({
    verifyTrackedClean: () => true,
    loadReviewedSource: loadWorktreeReviewedSource,
  });
}

function sourceIdFromQuery(query: string): string {
  const match = /source_attempt_id is "([^"]+)"/.exec(query);
  if (match?.[1] === undefined) throw new Error("missing source fixture");
  return match[1];
}

function runtime(
  values: XmemoryPilotManifests,
  options: {
    insightHits?: number;
    queryHits?: number;
    crossMerge?: boolean;
    forbidden?: boolean;
    sourceMode?: "empty" | "duplicate" | "wrong";
    insightMode?: "empty" | "split" | "wrong-kind" | "foreign";
  } = {},
): { platform: XmemoryPlatformPort; createMemory: XmemoryPilotMemoryFactory; calls: string[] } {
  const insightHits = options.insightHits ?? 30;
  const queryHits = options.queryHits ?? 30;
  const lessonBySource = new Map(
    values.lessons.map((entry, index) => [entry.lesson.sourceAttemptId, { entry, index }]),
  );
  const calls: string[] = [];
  let queryIndex = 0;
  const platform: XmemoryPlatformPort = {
    getSchema: async () => { throw new Error("unexpected schema"); },
    write: async () => { throw new Error("unexpected write"); },
    read: async (request) => {
      calls.push(`raw:${request.query}`);
      if (request.query === XMEMORY_PILOT_EMPTY_QUERY) {
        return { traceId: request.traceId, readerResult: null };
      }
      const sourceAttemptId = sourceIdFromQuery(request.query);
      const lesson = lessonBySource.get(sourceAttemptId);
      if (lesson === undefined) throw new Error("unknown source fixture");
      if (request.query.startsWith("Return source_attempt_id")) {
        let rows: unknown[][] = [[sourceAttemptId]];
        if (lesson.index === 0 && options.sourceMode === "empty") rows = [];
        if (lesson.index === 0 && options.sourceMode === "duplicate") {
          rows = [[sourceAttemptId], [sourceAttemptId]];
        }
        if (lesson.index === 0 && options.sourceMode === "wrong") rows = [["wrong-source"]];
        return {
          traceId: null,
          readerResult: {
            columns: [{ name: "source_attempt_id", type: "str" }],
            rows,
          },
        };
      }
      const expected = lesson.entry.expectedInsights[0];
      if (expected === undefined) throw new Error("missing insight fixture");
      let statement = lesson.index < insightHits ? expected.allOf.join(" ") : "unrelated cue";
      if (options.forbidden && lesson.index === 0) {
        statement += ` ${lesson.entry.forbiddenSubstrings[0] ?? "forbidden"}`;
      }
      const rowSource = options.crossMerge && lesson.index === 0
        ? values.lessons[1]?.lesson.sourceAttemptId ?? "other-source"
        : sourceAttemptId;
      let rows: unknown[][] = [[rowSource, statement, expected.kind]];
      if (lesson.index === 0 && options.insightMode === "empty") rows = [];
      if (lesson.index === 0 && options.insightMode === "split") {
        rows = expected.allOf.map((term) => [sourceAttemptId, term, expected.kind]);
      }
      if (lesson.index === 0 && options.insightMode === "wrong-kind") {
        rows = [[
          sourceAttemptId,
          expected.allOf.join(" "),
          expected.kind === "procedure" ? "caveat" : "procedure",
        ]];
      }
      if (lesson.index === 0 && options.insightMode === "foreign") {
        rows = [["foreign-source", statement, expected.kind]];
      }
      return {
        traceId: request.traceId,
        readerResult: {
          columns: [
            { name: "source_attempt_id", type: "str" },
            { name: "insight_statement", type: "str" },
            { name: "insight_kind", type: "str" },
          ],
          rows,
        },
      };
    },
  };

  const createMemory: XmemoryPilotMemoryFactory = async (_config, _platform, observers) => ({
    async remember(lesson) {
      calls.push(`remember:${lesson.sourceAttemptId}`);
      observers.onRememberCompleted({
        sourceAttemptId: lesson.sourceAttemptId,
        writeId: `write-${lesson.sourceAttemptId}`,
        traceId: null,
        changes: {
          created: { objects: [], relations: [] },
          updated: { objects: [], relations: [] },
          deleted: { objects: [], relations: [] },
        },
      });
    },
    async recall(_features, limit) {
      assert.equal(limit, 5);
      const query = values.queries[queryIndex];
      const index = queryIndex;
      queryIndex += 1;
      if (query === undefined || index >= queryHits) return [];
      let text = query.expectedAllOf.join(" ");
      if (options.forbidden && index === 1) text += ` ${query.forbiddenSubstrings[0] ?? "forbidden"}`;
      return [{ lessonId: `xmemory-read:${index}`, text }];
    },
    async snapshot() { throw new Error("unexpected snapshot"); },
    async restore() { throw new Error("unexpected restore"); },
  });
  return { platform, createMemory, calls };
}

function config() {
  return {
    apiKey: "test-api-key",
    instanceId: "fresh-pilot-instance",
    writeTimeoutMs: 180_000,
    readTimeoutMs: 60_000,
  };
}

test("frozen manifests contain 30 matched unique cases and five empty prior queries", async () => {
  const checked: string[] = [];
  const values = await loadXmemoryPilotManifests({
    verifyTrackedClean: (path) => {
      checked.push(path);
      return true;
    },
    loadReviewedSource: loadWorktreeReviewedSource,
  });
  assert.deepEqual(checked.sort(), [XMEMORY_PILOT_LESSONS_PATH, XMEMORY_PILOT_QUERIES_PATH].sort());
  assert.equal(values.lessons.length, 30);
  assert.equal(values.queries.length, 30);
  assert.equal(new Set(values.lessons.map((entry) => entry.caseId)).size, 30);
  assert.equal(new Set(values.lessons.map((entry) => entry.lesson.sourceAttemptId)).size, 30);
  assert.equal(values.queries.filter((entry) => entry.features.length === 0).length, 5);
  assert.ok(values.lessons.every((entry) =>
    entry.expectedInsights.length > 0 &&
    entry.expectedInsights.every((rubric) => rubric.allOf.length > 0) &&
    entry.forbiddenSubstrings.length > 0));
  assert.ok(values.queries.every((entry) =>
    entry.expectedAllOf.length > 0 && entry.forbiddenSubstrings.length > 0));
  assert.deepEqual(
    values.lessons.map((entry) => entry.caseId).sort(),
    values.queries.map((entry) => entry.caseId).sort(),
  );
  assert.match(values.lessonManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(values.queryManifestSha256, /^[0-9a-f]{64}$/);
});

test("manifest validation rejects count, duplicates, malformed rubrics, cross references and too few priors", async () => {
  const values = await manifests();
  const lessons = structuredClone(values.lessons) as unknown[];
  const queries = structuredClone(values.queries) as unknown[];
  assert.throws(() => validateXmemoryPilotManifests(lessons.slice(1), queries));

  const duplicateLessons = structuredClone(lessons);
  duplicateLessons[1] = duplicateLessons[0];
  assert.throws(() => validateXmemoryPilotManifests(duplicateLessons, queries));

  const duplicateSources = structuredClone(lessons) as Array<{ lesson: { sourceAttemptId: string } }>;
  duplicateSources[1]!.lesson.sourceAttemptId = duplicateSources[0]!.lesson.sourceAttemptId;
  assert.throws(() => validateXmemoryPilotManifests(duplicateSources, queries));

  const whitespaceCollision = structuredClone(lessons) as Array<{
    lesson: { sourceAttemptId: string };
  }>;
  whitespaceCollision[1]!.lesson.sourceAttemptId =
    ` ${whitespaceCollision[0]!.lesson.sourceAttemptId} `;
  assert.throws(() => validateXmemoryPilotManifests(whitespaceCollision, queries));

  const malformed = structuredClone(lessons) as Array<Record<string, unknown>>;
  malformed[0] = { caseId: "case-01" };
  assert.throws(() => validateXmemoryPilotManifests(malformed, queries));

  const wrongCase = structuredClone(queries) as Array<{ caseId: string; features: string[] }>;
  wrongCase[0]!.caseId = "unknown-case";
  assert.throws(() => validateXmemoryPilotManifests(lessons, wrongCase));

  const insufficientPriors = structuredClone(queries) as Array<{ features: string[] }>;
  for (const entry of insufficientPriors) entry.features = ["visible cue"];
  assert.throws(() => validateXmemoryPilotManifests(lessons, insufficientPriors));
});

test("real git verifier requires committed clean files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-git-check-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, stdio: "ignore" });
    assert.equal(result.status, 0);
  };
  runGit(["init", "-q"]);
  await writeFile(join(directory, "manifest.jsonl"), "{}\n", "utf8");
  runGit(["add", "manifest.jsonl"]);
  runGit([
    "-c",
    "user.name=Xmemory Test",
    "-c",
    "user.email=xmemory-test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  assert.equal(verifyXmemoryPilotTrackedClean("manifest.jsonl", directory), true);

  await writeFile(join(directory, "manifest.jsonl"), '{"dirty":true}\n', "utf8");
  assert.equal(verifyXmemoryPilotTrackedClean("manifest.jsonl", directory), false);
  runGit(["add", "manifest.jsonl"]);
  assert.equal(verifyXmemoryPilotTrackedClean("manifest.jsonl", directory), false);

  await writeFile(join(directory, "untracked.jsonl"), "{}\n", "utf8");
  assert.equal(verifyXmemoryPilotTrackedClean("untracked.jsonl", directory), false);
});

test("loader hashes immutable HEAD blobs when worktree files swap after clean verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-head-snapshot-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, stdio: "ignore" });
    assert.equal(result.status, 0);
  };
  const lessonSource = await readFile(XMEMORY_PILOT_LESSONS_PATH, "utf8");
  const querySource = await readFile(XMEMORY_PILOT_QUERIES_PATH, "utf8");
  await writeFile(join(directory, "lessons.jsonl"), lessonSource, "utf8");
  await writeFile(join(directory, "queries.jsonl"), querySource, "utf8");
  runGit(["init", "-q"]);
  runGit(["add", "lessons.jsonl", "queries.jsonl"]);
  runGit([
    "-c",
    "user.name=Xmemory Test",
    "-c",
    "user.email=xmemory-test@example.invalid",
    "commit",
    "-qm",
    "reviewed manifests",
  ]);

  const loaded = await loadXmemoryPilotManifests({
    lessonsPath: "lessons.jsonl",
    queriesPath: "queries.jsonl",
    gitCwd: directory,
    verifyTrackedClean: async (path) => {
      const clean = verifyXmemoryPilotTrackedClean(path, directory);
      await writeFile(join(directory, path), '{"dirty":"raw-secret swap"}\n', "utf8");
      return clean;
    },
  });
  assert.equal(loaded.lessons[0]?.caseId, "case-01");
  assert.equal(
    loaded.lessonManifestSha256,
    createHash("sha256").update(lessonSource, "utf8").digest("hex"),
  );
  assert.equal(
    loaded.queryManifestSha256,
    createHash("sha256").update(querySource, "utf8").digest("hex"),
  );
  assert.equal(
    (await readFile(join(directory, "lessons.jsonl"), "utf8")).includes("raw-secret swap"),
    true,
  );

  await writeFile(join(directory, "lessons.jsonl"), lessonSource, "utf8");
  await writeFile(join(directory, "queries.jsonl"), querySource, "utf8");
  await writeFile(join(directory, "untracked.jsonl"), lessonSource, "utf8");
  await assert.rejects(
    loadXmemoryPilotManifests({
      lessonsPath: "untracked.jsonl",
      queriesPath: "queries.jsonl",
      gitCwd: directory,
    }),
  );

  const noHeadDirectory = await mkdtemp(join(tmpdir(), "xmemory-no-head-"));
  context.after(async () => rm(noHeadDirectory, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "-q"], { cwd: noHeadDirectory, stdio: "ignore" });
  assert.equal(init.status, 0);
  await writeFile(join(noHeadDirectory, "lessons.jsonl"), lessonSource, "utf8");
  await writeFile(join(noHeadDirectory, "queries.jsonl"), querySource, "utf8");
  await assert.rejects(
    loadXmemoryPilotManifests({
      lessonsPath: "lessons.jsonl",
      queriesPath: "queries.jsonl",
      gitCwd: noHeadDirectory,
    }),
  );
});

test("loader keeps the captured reviewed HEAD when a new commit lands after clean verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-head-advance-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, stdio: "ignore" });
    assert.equal(result.status, 0);
  };
  const lessonSource = await readFile(XMEMORY_PILOT_LESSONS_PATH, "utf8");
  const querySource = await readFile(XMEMORY_PILOT_QUERIES_PATH, "utf8");
  await writeFile(join(directory, "lessons.jsonl"), lessonSource, "utf8");
  await writeFile(join(directory, "queries.jsonl"), querySource, "utf8");
  runGit(["init", "-q"]);
  runGit(["add", "lessons.jsonl", "queries.jsonl"]);
  runGit([
    "-c",
    "user.name=Xmemory Test",
    "-c",
    "user.email=xmemory-test@example.invalid",
    "commit",
    "-qm",
    "reviewed manifests",
  ]);
  const reviewedHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout.trim();
  let checks = 0;
  const loaded = await loadXmemoryPilotManifests({
    lessonsPath: "lessons.jsonl",
    queriesPath: "queries.jsonl",
    gitCwd: directory,
    verifyTrackedClean: async (path) => {
      const clean = verifyXmemoryPilotTrackedClean(path, directory, reviewedHead);
      checks += 1;
      if (checks === 2) {
        await writeFile(join(directory, "lessons.jsonl"), '{"advanced":true}\n', "utf8");
        await writeFile(join(directory, "queries.jsonl"), '{"advanced":true}\n', "utf8");
        runGit(["add", "lessons.jsonl", "queries.jsonl"]);
        runGit([
          "-c",
          "user.name=Xmemory Test",
          "-c",
          "user.email=xmemory-test@example.invalid",
          "commit",
          "-qm",
          "advanced HEAD",
        ]);
      }
      return clean;
    },
  });
  assert.equal(checks, 2);
  assert.equal(loaded.lessons[0]?.caseId, "case-01");
  assert.equal(
    loaded.lessonManifestSha256,
    createHash("sha256").update(lessonSource, "utf8").digest("hex"),
  );
  const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout.trim();
  assert.notEqual(currentHead, reviewedHead);
});

test("successful harness uses typed empty preflight and exact per-lesson provenance scoring", async () => {
  const values = await manifests();
  const fixture = runtime(values);
  const summary = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform: fixture.platform,
    schemaSha256: "a".repeat(64),
    createMemory: fixture.createMemory,
    createRunId: () => "run-1",
  });
  assert.equal(fixture.calls[0], `raw:${XMEMORY_PILOT_EMPTY_QUERY}`);
  assert.equal(summary.sourceIdsPreserved, 30);
  assert.equal(summary.lessonsWithGroundedInsight, 30);
  assert.equal(summary.queriesWithExpectedAnswer, 30);
  assert.equal(summary.crossAttemptMerges, 0);
  assert.equal(summary.forbiddenClaims, 0);
  assert.equal(summary.instanceRetired, true);
  assert.equal(summary.passedWithoutQuota, true);
});

test("non-empty or malformed raw preflight aborts and retires before memory construction", async () => {
  const values = await manifests();
  const outcomes: unknown[] = [
    {
      columns: [{ name: "source_attempt_id", type: "str" }],
      rows: [["existing-source"]],
    },
    {},
    {
      columns: [{ name: "source_attempt_id", type: "str" }],
      rows: [[]],
    },
  ];
  for (const readerResult of outcomes) {
    let memoryCreations = 0;
    const platform: XmemoryPlatformPort = {
      getSchema: async () => { throw new Error("unexpected schema"); },
      write: async () => { throw new Error("unexpected write"); },
      read: async (request) => {
        assert.equal(request.query, XMEMORY_PILOT_EMPTY_QUERY);
        return { traceId: null, readerResult };
      },
    };
    const summary = await runXmemoryPilot({
      manifests: values,
      config: config(),
      platform,
      schemaSha256: "a".repeat(64),
      createMemory: async () => {
        memoryCreations += 1;
        throw new Error("must not create memory");
      },
    });
    assert.equal(memoryCreations, 0);
    assert.equal(summary.harnessFailures, 1);
    assert.equal(summary.aborted, true);
    assert.equal(summary.instanceRetired, true);
    assert.equal(summary.writeFailures, 0);
    assert.equal(summary.recallFailures, 0);
  }
});

test("source, insight, cross-merge, forbidden and query rubrics enforce exact pass boundaries", async () => {
  const values = await manifests();
  const boundaryFixture = runtime(values, { insightHits: 24, queryHits: 24 });
  const boundary = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform: boundaryFixture.platform,
    schemaSha256: "a".repeat(64),
    createMemory: boundaryFixture.createMemory,
  });
  assert.equal(boundary.passedWithoutQuota, true);

  for (const scenario of [
    { options: { insightHits: 23, queryHits: 24 }, field: "lessonsWithGroundedInsight" },
    { options: { insightHits: 24, queryHits: 23 }, field: "queriesWithExpectedAnswer" },
    { options: { crossMerge: true }, field: "crossAttemptMerges" },
    { options: { forbidden: true }, field: "forbiddenClaims" },
  ] as const) {
    const fixture = runtime(values, scenario.options);
    const result = await runXmemoryPilot({
      manifests: values,
      config: config(),
      platform: fixture.platform,
      schemaSha256: "a".repeat(64),
      createMemory: fixture.createMemory,
    });
    assert.ok(result[scenario.field] > 0);
    assert.equal(result.passedWithoutQuota, false);
  }
});

test("source cardinality and per-row insight rubrics are pilot misses, while foreign provenance is a harness failure", async () => {
  const values = await manifests();
  for (const sourceMode of ["empty", "duplicate", "wrong"] as const) {
    const fixture = runtime(values, { sourceMode });
    const result = await runXmemoryPilot({
      manifests: values,
      config: config(),
      platform: fixture.platform,
      schemaSha256: "a".repeat(64),
      createMemory: fixture.createMemory,
    });
    assert.equal(result.sourceIdsPreserved, 29);
    assert.equal(result.harnessFailures, 0);
  }

  for (const insightMode of ["empty", "split", "wrong-kind"] as const) {
    const fixture = runtime(values, { insightMode });
    const result = await runXmemoryPilot({
      manifests: values,
      config: config(),
      platform: fixture.platform,
      schemaSha256: "a".repeat(64),
      createMemory: fixture.createMemory,
    });
    assert.equal(result.lessonsWithGroundedInsight, 29);
    assert.equal(result.harnessFailures, 0);
  }

  const foreignFixture = runtime(values, { insightMode: "foreign" });
  const foreign = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform: foreignFixture.platform,
    schemaSha256: "a".repeat(64),
    createMemory: foreignFixture.createMemory,
  });
  assert.equal(foreign.harnessFailures, 1);
  assert.equal(foreign.sourceIdsPreserved, 29);
});

test("nearest-rank p95 and every pass gate use exact inclusive thresholds", async () => {
  assert.equal(xmemoryPilotP95([]), Number.POSITIVE_INFINITY);
  assert.equal(xmemoryPilotP95([3, 1, 2]), 3);
  assert.equal(xmemoryPilotP95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  const values = await manifests();
  const fixture = runtime(values);
  const passing = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform: fixture.platform,
    schemaSha256: "a".repeat(64),
    createMemory: fixture.createMemory,
  });
  const boundary = {
    ...passing,
    lessonsWithGroundedInsight: 24,
    queriesWithExpectedAnswer: 24,
    writeP95Ms: 180_000,
    readP95Ms: 60_000,
  };
  assert.equal(xmemoryPilotPassesWithoutQuota(boundary), true);
  for (const change of [
    { sourceIdsPreserved: 29 },
    { lessonsWithGroundedInsight: 23 },
    { queriesWithExpectedAnswer: 23 },
    { writeP95Ms: 180_001 },
    { readP95Ms: 60_001 },
    { writeFailures: 1 },
    { recallFailures: 1 },
    { harnessFailures: 1 },
    { aborted: true },
    { instanceQuarantined: true },
    { instanceRetired: false },
  ]) {
    assert.equal(xmemoryPilotPassesWithoutQuota({ ...boundary, ...change }), false);
  }
});

test("unknown write outcome aborts remaining cases with quarantine and retirement", async () => {
  const values = await manifests();
  let remembers = 0;
  let queryCalls = 0;
  const platform: XmemoryPlatformPort = {
    getSchema: async () => { throw new Error("unexpected schema"); },
    write: async () => { throw new Error("unexpected write"); },
    read: async (request) => {
      assert.equal(request.query, XMEMORY_PILOT_EMPTY_QUERY);
      return { traceId: null, readerResult: null };
    },
  };
  const createMemory: XmemoryPilotMemoryFactory = async (_config, _platform, observers) => ({
    async remember() {
      remembers += 1;
      observers.onInstanceQuarantined({
        instanceId: "fresh-pilot-instance",
        code: "write_outcome_unknown",
      });
      throw new XmemoryMemoryError(
        "write_outcome_unknown",
        "write",
        "The xmemory write outcome is unknown",
      );
    },
    async recall() { queryCalls += 1; return []; },
    async snapshot() { throw new Error("unexpected snapshot"); },
    async restore() { throw new Error("unexpected restore"); },
  });
  const summary = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform,
    schemaSha256: "a".repeat(64),
    createMemory,
  });
  assert.equal(remembers, 1);
  assert.equal(queryCalls, 0);
  assert.equal(summary.writeFailures, 1);
  assert.equal(summary.aborted, true);
  assert.equal(summary.instanceQuarantined, true);
  assert.equal(summary.instanceRetired, true);
  assert.equal(summary.lessonCases, 30);
  assert.equal(summary.queryCases, 30);
});

test("write, observer, provenance, recall and hint failures increment mutually exclusive counters", async () => {
  const values = await manifests();
  const scenarios = [
    { mode: "write", writeFailures: 1, recallFailures: 0, harnessFailures: 0 },
    { mode: "observer", writeFailures: 0, recallFailures: 0, harnessFailures: 1 },
    { mode: "provenance", writeFailures: 0, recallFailures: 0, harnessFailures: 1 },
    { mode: "recall", writeFailures: 0, recallFailures: 1, harnessFailures: 0 },
    { mode: "hint", writeFailures: 0, recallFailures: 0, harnessFailures: 1 },
  ] as const;

  for (const scenario of scenarios) {
    const fixture = runtime(values);
    let provenanceFailures = 0;
    const baseRead = fixture.platform.read.bind(fixture.platform);
    const platform: XmemoryPlatformPort = {
      ...fixture.platform,
      read: async (request) => {
        if (
          scenario.mode === "provenance" &&
          request.query.startsWith("Return source_attempt_id") &&
          provenanceFailures === 0
        ) {
          provenanceFailures += 1;
          return { traceId: null, readerResult: {} };
        }
        return baseRead(request);
      },
    };
    let remembers = 0;
    let recalls = 0;
    const createMemory: XmemoryPilotMemoryFactory = async (...args) => {
      const base = await fixture.createMemory(...args);
      return {
        ...base,
        async remember(value) {
          remembers += 1;
          if (remembers === 1 && scenario.mode === "write") {
            throw new XmemoryMemoryError("invalid_input", "write", "known write failure");
          }
          if (remembers === 1 && scenario.mode === "observer") {
            throw new XmemoryMemoryError("observer_failed", "write", "observer failure");
          }
          return base.remember(value);
        },
        async recall(features, limit) {
          recalls += 1;
          if (recalls === 1 && scenario.mode === "recall") throw new Error("recall failure");
          if (recalls === 1 && scenario.mode === "hint") {
            return [{}] as unknown as Awaited<ReturnType<typeof base.recall>>;
          }
          return base.recall(features, limit);
        },
      };
    };
    const result = await runXmemoryPilot({
      manifests: values,
      config: config(),
      platform,
      schemaSha256: "a".repeat(64),
      createMemory,
    });
    assert.equal(result.writeFailures, scenario.writeFailures);
    assert.equal(result.recallFailures, scenario.recallFailures);
    assert.equal(result.harnessFailures, scenario.harnessFailures);
    assert.equal(result.aborted, false);
    assert.equal(result.instanceQuarantined, false);
    assert.equal(result.instanceRetired, true);
  }
});

test("execute validates manifests/gate before Cloud and writes one summary only after valid manifests", async () => {
  let platformCalls = 0;
  let writes = 0;
  const printed: string[] = [];
  const exitCode = await executeXmemoryPilot({
    env: { XMEM_INTEGRATION: "0", XMEM_INSTANCE_ID: "configured-instance" },
    verifyTrackedClean: () => true,
    loadReviewedSource: loadWorktreeReviewedSource,
    createPlatform: () => {
      platformCalls += 1;
      throw new Error("must not construct platform");
    },
    writeSummary: async () => { writes += 1; },
    printSummary: (line) => printed.push(line),
  });
  assert.equal(exitCode, 1);
  assert.equal(platformCalls, 0);
  assert.equal(writes, 1);
  assert.equal(printed.length, 1);
  const gated = JSON.parse(printed[0] ?? "") as UnknownRecord;
  assert.equal(gated.instanceRetired, false);
  assert.equal(gated.writeP95Ms, Number.POSITIVE_INFINITY);
  assert.equal(gated.readP95Ms, Number.POSITIVE_INFINITY);

  writes = 0;
  platformCalls = 0;
  const invalidExit = await executeXmemoryPilot({
    verifyTrackedClean: () => false,
    loadReviewedSource: loadWorktreeReviewedSource,
    createPlatform: () => {
      platformCalls += 1;
      throw new Error("must not construct platform");
    },
    writeSummary: async () => { writes += 1; },
    printSummary: () => undefined,
  });
  assert.equal(invalidExit, 1);
  assert.equal(platformCalls, 0);
  assert.equal(writes, 0);

  writes = 0;
  const sameInstanceExit = await executeXmemoryPilot({
    env: {
      XMEM_INTEGRATION: "1",
      XMEM_API_KEY: "test-key",
      XMEM_INSTANCE_ID: "same-instance",
      XMEM_INTEGRATION_INSTANCE_ID: "same-instance",
    },
    verifyTrackedClean: () => true,
    loadReviewedSource: loadWorktreeReviewedSource,
    createPlatform: () => {
      platformCalls += 1;
      throw new Error("must not construct platform");
    },
    writeSummary: async () => { writes += 1; },
    printSummary: () => undefined,
  });
  assert.equal(sameInstanceExit, 1);
  assert.equal(platformCalls, 0);
  assert.equal(writes, 1);
});

test("schema and environment acquisition failures write and print one sanitized summary before Cloud", async () => {
  for (const acquisition of [
    {
      selectEnv: () => { throw new Error("raw-secret environment failure"); },
      loadSchema: undefined,
    },
    {
      selectEnv: () => ({ XMEM_INTEGRATION: "1" }),
      loadSchema: () => loadXmemorySchema("tmp/missing-xmemory-schema.yml"),
    },
  ]) {
    let platformCalls = 0;
    let writeCalls = 0;
    const printed: string[] = [];
    const written: XmemoryPilotSummary[] = [];
    const exitCode = await executeXmemoryPilot({
      verifyTrackedClean: () => true,
      loadReviewedSource: loadWorktreeReviewedSource,
      selectEnv: acquisition.selectEnv,
      ...(acquisition.loadSchema === undefined ? {} : { loadSchema: acquisition.loadSchema }),
      createPlatform: () => {
        platformCalls += 1;
        throw new Error("must not construct platform");
      },
      writeSummary: async (_path, summary) => {
        writeCalls += 1;
        written.push(structuredClone(summary));
      },
      printSummary: (line) => printed.push(line),
    });
    assert.equal(exitCode, 1);
    assert.equal(platformCalls, 0);
    assert.equal(writeCalls, 1);
    assert.equal(written.length, 1);
    assert.equal(printed.length, 1);
    const line = printed[0] ?? "";
    assert.equal(line.includes("raw-secret"), false);
    const output = JSON.parse(line) as XmemoryPilotSummary;
    assert.equal(output.aborted, true);
    assert.equal(output.harnessFailures, 1);
    assert.equal(output.instanceRetired, false);
    assert.deepEqual(output, written[0]);
  }
});

test("execute prints every post-manifest exit and records summary-writer failure once", async () => {
  const values = await manifests();
  const schema = await loadXmemorySchema();
  const pilotEnv = {
    XMEM_INTEGRATION: "1",
    XMEM_API_KEY: "test-api-key",
    XMEM_INSTANCE_ID: "fresh-pilot-instance",
    XMEM_INTEGRATION_INSTANCE_ID: "integration-fixture-instance",
  };

  const successFixture = runtime(values);
  const successWritten: XmemoryPilotSummary[] = [];
  const successPrinted: string[] = [];
  const successExit = await executeXmemoryPilot({
    env: pilotEnv,
    verifyTrackedClean: () => true,
    loadReviewedSource: loadWorktreeReviewedSource,
    loadSchema: async () => schema,
    createPlatform: () => successFixture.platform,
    createMemory: successFixture.createMemory,
    writeSummary: async (_path, summary) => { successWritten.push(structuredClone(summary)); },
    printSummary: (line) => successPrinted.push(line),
  });
  assert.equal(successExit, 0);
  assert.equal(successWritten.length, 1);
  assert.equal(successPrinted.length, 1);
  assert.deepEqual(JSON.parse(successPrinted[0] ?? ""), successWritten[0]);
  assert.equal(successWritten[0]?.instanceRetired, true);
  assert.equal(successWritten[0]?.passedWithoutQuota, true);

  const failedWriterFixture = runtime(values);
  let writeAttempts = 0;
  const failedWriterPrinted: string[] = [];
  const failedWriterExit = await executeXmemoryPilot({
    env: pilotEnv,
    verifyTrackedClean: () => true,
    loadReviewedSource: loadWorktreeReviewedSource,
    loadSchema: async () => schema,
    createPlatform: () => failedWriterFixture.platform,
    createMemory: failedWriterFixture.createMemory,
    writeSummary: async () => {
      writeAttempts += 1;
      throw new Error("raw-secret atomic writer failure");
    },
    printSummary: (line) => failedWriterPrinted.push(line),
  });
  assert.equal(failedWriterExit, 1);
  assert.equal(writeAttempts, 1);
  assert.equal(failedWriterPrinted.length, 1);
  assert.equal(failedWriterPrinted[0]?.includes("raw-secret"), false);
  const failed = JSON.parse(failedWriterPrinted[0] ?? "") as XmemoryPilotSummary;
  assert.equal(failed.harnessFailures, 1);
  assert.equal(failed.aborted, true);
  assert.equal(failed.instanceRetired, true);
  assert.equal(failed.passedWithoutQuota, false);
});

test("pilot executable prints one sanitized failure line with empty stderr", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-pilot-cli-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [resolve("src/memory/xmemory/pilot.ts")],
    { cwd: directory, encoding: "utf8", env: {} },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    instanceRetired: false,
    errorCode: "invalid_input",
  });
});

test("atomic summary writer replaces in the target directory and leaves no temp file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-summary-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "summary.json");
  await writeFile(target, "old\n", "utf8");
  const values = await manifests();
  const fixture = runtime(values);
  const summary = await runXmemoryPilot({
    manifests: values,
    config: config(),
    platform: fixture.platform,
    schemaSha256: "a".repeat(64),
    createMemory: fixture.createMemory,
  });
  await writeXmemoryPilotSummaryAtomic(target, summary);
  const parsed = JSON.parse(await readFile(target, "utf8")) as XmemoryPilotSummary;
  assert.equal(parsed.runId, summary.runId);
  assert.deepEqual((await readdir(directory)).sort(), ["summary.json"]);
});

test("pilot and finalizer remain explicit-only and admin/data ports expose no delete", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts["xmemory:pilot"], "node --env-file-if-exists=.env src/memory/xmemory/pilot.ts");
  assert.equal(manifest.scripts["xmemory:pilot:finalize"], "node src/memory/xmemory/pilot-finalize.ts");
  for (const name of ["sample", "experiment", "typecheck", "train", "test:mem0", "test:xmemory"]) {
    const command = manifest.scripts[name] ?? "";
    assert.equal(command.includes("src/memory/xmemory/pilot.ts"), false);
    assert.equal(command.includes("src/memory/xmemory/pilot-finalize.ts"), false);
  }
  const runtimeSources = await Promise.all(
    [
      "platform-contract.ts",
      "platform-internal.ts",
      "platform.ts",
      "provision.ts",
      "pilot.ts",
    ].map((name) => readFile(`src/memory/xmemory/${name}`, "utf8")),
  );
  assert.equal(
    /deleteInstance|removeInstance|destroyInstance|updateInstance/.test(runtimeSources.join("\n")),
    false,
  );
});
