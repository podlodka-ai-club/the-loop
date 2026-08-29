import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Hint, LessonInput } from "../../memory.ts";
import { xmemoryIntegrationEnabled, loadXmemoryIntegrationConfig } from "./integration.ts";
import {
  XmemoryMemoryError,
  createXmemoryMemory,
  loadXmemoryMemoryConfig,
  type XmemoryMemory,
  type XmemoryMemoryConfig,
  type XmemoryQuarantineResult,
  type XmemoryRememberResult,
} from "./memory.ts";
import { createXmemoryPlatformPort } from "./platform.ts";
import { provisionDisposableXmemoryInstance } from "./provision.ts";
import {
  XMEMORY_INSIGHT_KINDS,
  decodePilotExperienceRows,
  decodePilotInsightRows,
  decodeXmemoryRawTables,
  type XmemoryInsightKind,
  type XmemoryPlatformPort,
} from "./platform-contract.ts";
import { loadXmemorySchema, type LoadedXmemorySchema } from "./schema.ts";

export const XMEMORY_PILOT_LESSONS_PATH =
  "benchmark/samples/xmemory-pilot-v1-lessons.jsonl";
export const XMEMORY_PILOT_QUERIES_PATH =
  "benchmark/samples/xmemory-pilot-v1-queries.jsonl";
export const XMEMORY_PILOT_SUMMARY_PATH = "tmp/xmemory-pilot-v1-summary.json";

export const XMEMORY_PILOT_EMPTY_QUERY =
  "List every TrainingExperience record. Return source_attempt_id only.";

export type XmemoryPilotLessonCase = {
  caseId: string;
  lesson: LessonInput;
  expectedInsights: Array<{ kind: XmemoryInsightKind; allOf: string[] }>;
  forbiddenSubstrings: string[];
};

export type XmemoryPilotQueryCase = {
  caseId: string;
  features: string[];
  expectedAllOf: string[];
  forbiddenSubstrings: string[];
};

export type XmemoryPilotSummary = {
  runId: string;
  instanceId: string;
  schemaSha256: string;
  lessonManifestSha256: string;
  queryManifestSha256: string;
  startedAt: string;
  finishedAt: string;
  lessonCases: 30;
  sourceIdsPreserved: number;
  lessonsWithGroundedInsight: number;
  crossAttemptMerges: number;
  forbiddenClaims: number;
  queryCases: 30;
  queriesWithExpectedAnswer: number;
  writeFailures: number;
  recallFailures: number;
  harnessFailures: number;
  writeP95Ms: number;
  readP95Ms: number;
  aborted: boolean;
  instanceQuarantined: boolean;
  instanceRetired: boolean;
  passedWithoutQuota: boolean;
};

export type XmemoryPilotManifests = {
  lessons: XmemoryPilotLessonCase[];
  queries: XmemoryPilotQueryCase[];
  lessonManifestSha256: string;
  queryManifestSha256: string;
};

type UnknownRecord = Record<string, unknown>;

export class XmemoryPilotManifestError extends Error {
  constructor() {
    super("Xmemory pilot manifests are invalid");
    this.name = "XmemoryPilotManifestError";
  }
}

class XmemoryPilotHarnessError extends Error {}

const PILOT_SENTINEL = /<\/?loci_/i;
const PILOT_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseJsonLines(source: string): unknown[] {
  const values: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      throw new XmemoryPilotManifestError();
    }
  }
  return values;
}

function parseStringArray(value: unknown, allowEmpty: boolean): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => !nonEmptyString(item))
  ) {
    throw new XmemoryPilotManifestError();
  }
  return [...value] as string[];
}

function parseLessonCase(value: unknown): XmemoryPilotLessonCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["caseId", "lesson", "expectedInsights", "forbiddenSubstrings"]) ||
    !nonEmptyString(value.caseId) ||
    !isRecord(value.lesson) ||
    !exactKeys(value.lesson, ["content", "sourceAttemptId", "triggers", "region"]) ||
    !nonEmptyString(value.lesson.content) ||
    !nonEmptyString(value.lesson.sourceAttemptId) ||
    typeof value.lesson.region !== "string" ||
    !Array.isArray(value.expectedInsights) ||
    value.expectedInsights.length === 0
  ) {
    throw new XmemoryPilotManifestError();
  }
  const expectedInsights = value.expectedInsights.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["kind", "allOf"]) ||
      typeof entry.kind !== "string" ||
      !(XMEMORY_INSIGHT_KINDS as readonly string[]).includes(entry.kind)
    ) {
      throw new XmemoryPilotManifestError();
    }
    return {
      kind: entry.kind as XmemoryInsightKind,
      allOf: parseStringArray(entry.allOf, false),
    };
  });
  const triggers = parseStringArray(value.lesson.triggers, true);
  if (
    value.lesson.content.length > 50_000 ||
    PILOT_SENTINEL.test(value.lesson.content) ||
    value.lesson.sourceAttemptId !== value.lesson.sourceAttemptId.trim() ||
    !PILOT_SOURCE_ID.test(value.lesson.sourceAttemptId.trim()) ||
    value.lesson.region.trim().length > 256 ||
    PILOT_SENTINEL.test(value.lesson.region) ||
    triggers.length > 64 ||
    triggers.some((trigger) => {
      const normalized = trigger.trim();
      return normalized.length > 256 || PILOT_SENTINEL.test(normalized);
    })
  ) {
    throw new XmemoryPilotManifestError();
  }
  return {
    caseId: value.caseId,
    lesson: {
      content: value.lesson.content,
      sourceAttemptId: value.lesson.sourceAttemptId,
      triggers,
      region: value.lesson.region,
    },
    expectedInsights,
    forbiddenSubstrings: parseStringArray(value.forbiddenSubstrings, true),
  };
}

function parseQueryCase(value: unknown): XmemoryPilotQueryCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["caseId", "features", "expectedAllOf", "forbiddenSubstrings"]) ||
    !nonEmptyString(value.caseId)
  ) {
    throw new XmemoryPilotManifestError();
  }
  const features = parseStringArray(value.features, true);
  if (
    features.length > 64 ||
    features.some((feature) => {
      const normalized = feature.trim().replace(/\s+/g, " ");
      return normalized.length > 256 || PILOT_SENTINEL.test(normalized);
    })
  ) {
    throw new XmemoryPilotManifestError();
  }
  return {
    caseId: value.caseId,
    features,
    expectedAllOf: parseStringArray(value.expectedAllOf, false),
    forbiddenSubstrings: parseStringArray(value.forbiddenSubstrings, true),
  };
}

export function validateXmemoryPilotManifests(
  lessonValues: readonly unknown[],
  queryValues: readonly unknown[],
): Pick<XmemoryPilotManifests, "lessons" | "queries"> {
  try {
    const lessons = lessonValues.map(parseLessonCase);
    const queries = queryValues.map(parseQueryCase);
    const lessonCases = new Set(lessons.map((entry) => entry.caseId));
    const queryCases = new Set(queries.map((entry) => entry.caseId));
    if (
      lessons.length !== 30 ||
      queries.length !== 30 ||
      lessonCases.size !== 30 ||
      queryCases.size !== 30 ||
      new Set(lessons.map((entry) => entry.lesson.sourceAttemptId)).size !== 30 ||
      lessonCases.size !== queryCases.size ||
      [...lessonCases].some((caseId) => !queryCases.has(caseId)) ||
      queries.filter((entry) => entry.features.length === 0).length < 5
    ) {
      throw new XmemoryPilotManifestError();
    }
    return { lessons, queries };
  } catch {
    throw new XmemoryPilotManifestError();
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function reviewedGitPath(path: string): boolean {
  return (
    path !== "" &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).includes("..")
  );
}

function resolveReviewedHead(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

export function verifyXmemoryPilotTrackedClean(
  path: string,
  cwd = process.cwd(),
  reviewedHead = resolveReviewedHead(cwd),
): boolean {
  if (reviewedHead === null || !reviewedGitPath(path)) return false;
  const commands = [
    ["cat-file", "-e", `${reviewedHead}:${path}`],
    ["diff", "--quiet", reviewedHead, "--", path],
  ];
  return commands.every(
    (args) => spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0,
  );
}

function readReviewedHeadBlob(path: string, cwd: string, reviewedHead: string): string {
  if (!reviewedGitPath(path)) throw new XmemoryPilotManifestError();
  const result = spawnSync("git", ["show", `${reviewedHead}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new XmemoryPilotManifestError();
  return result.stdout;
}

export async function loadXmemoryPilotManifests(options: {
  lessonsPath?: string;
  queriesPath?: string;
  gitCwd?: string;
  verifyTrackedClean?: (path: string) => boolean | Promise<boolean>;
  loadReviewedSource?: (path: string) => string | Promise<string>;
} = {}): Promise<XmemoryPilotManifests> {
  const lessonsPath = options.lessonsPath ?? XMEMORY_PILOT_LESSONS_PATH;
  const queriesPath = options.queriesPath ?? XMEMORY_PILOT_QUERIES_PATH;
  try {
    const gitCwd = options.gitCwd ?? process.cwd();
    const reviewedHead = resolveReviewedHead(gitCwd);
    const verify = options.verifyTrackedClean ?? ((path: string) =>
      verifyXmemoryPilotTrackedClean(path, gitCwd, reviewedHead));
    const [lessonsClean, queriesClean] = await Promise.all([
      verify(lessonsPath),
      verify(queriesPath),
    ]);
    if (!lessonsClean || !queriesClean) throw new XmemoryPilotManifestError();
    const loadReviewedSource = options.loadReviewedSource ?? ((path: string) => {
      if (reviewedHead === null) throw new XmemoryPilotManifestError();
      return readReviewedHeadBlob(path, gitCwd, reviewedHead);
    });
    const [lessonSource, querySource] = await Promise.all([
      loadReviewedSource(lessonsPath),
      loadReviewedSource(queriesPath),
    ]);
    return {
      ...validateXmemoryPilotManifests(parseJsonLines(lessonSource), parseJsonLines(querySource)),
      lessonManifestSha256: sha256(lessonSource),
      queryManifestSha256: sha256(querySource),
    };
  } catch {
    throw new XmemoryPilotManifestError();
  }
}

function sourceQuery(sourceAttemptId: string): string {
  return (
    `Return source_attempt_id for the TrainingExperience whose source_attempt_id is "${sourceAttemptId}".\n` +
    "Use exactly one column named source_attempt_id."
  );
}

function insightQuery(sourceAttemptId: string): string {
  return (
    "Return every Insight connected through derived_from to the TrainingExperience whose\n" +
    `source_attempt_id is "${sourceAttemptId}". Use exactly these columns in this order:\n` +
    "source_attempt_id, insight_statement, insight_kind."
  );
}

export function xmemoryPilotP95(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
}

export function xmemoryPilotPassesWithoutQuota(summary: XmemoryPilotSummary): boolean {
  return (
    summary.aborted === false &&
    summary.instanceQuarantined === false &&
    summary.instanceRetired === true &&
    summary.sourceIdsPreserved === 30 &&
    summary.lessonsWithGroundedInsight >= 24 &&
    summary.crossAttemptMerges === 0 &&
    summary.forbiddenClaims === 0 &&
    summary.writeFailures === 0 &&
    summary.recallFailures === 0 &&
    summary.harnessFailures === 0 &&
    summary.queriesWithExpectedAnswer >= 24 &&
    summary.writeP95Ms <= 180_000 &&
    summary.readP95Ms <= 60_000
  );
}

function initialSummary(input: {
  runId: string;
  instanceId: string;
  schemaSha256: string;
  manifests: XmemoryPilotManifests;
  startedAt: string;
}): XmemoryPilotSummary {
  return {
    runId: input.runId,
    instanceId: input.instanceId,
    schemaSha256: input.schemaSha256,
    lessonManifestSha256: input.manifests.lessonManifestSha256,
    queryManifestSha256: input.manifests.queryManifestSha256,
    startedAt: input.startedAt,
    finishedAt: input.startedAt,
    lessonCases: 30,
    sourceIdsPreserved: 0,
    lessonsWithGroundedInsight: 0,
    crossAttemptMerges: 0,
    forbiddenClaims: 0,
    queryCases: 30,
    queriesWithExpectedAnswer: 0,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 0,
    writeP95Ms: Number.POSITIVE_INFINITY,
    readP95Ms: Number.POSITIVE_INFINITY,
    aborted: false,
    instanceQuarantined: false,
    instanceRetired: false,
    passedWithoutQuota: false,
  };
}

function finishSummary(
  summary: XmemoryPilotSummary,
  now: () => number,
  writeDurations: readonly number[],
  readDurations: readonly number[],
): XmemoryPilotSummary {
  summary.finishedAt = new Date(now()).toISOString();
  summary.writeP95Ms = xmemoryPilotP95(writeDurations);
  summary.readP95Ms = xmemoryPilotP95(readDurations);
  summary.passedWithoutQuota = xmemoryPilotPassesWithoutQuota(summary);
  return summary;
}

async function rawRead(
  platform: XmemoryPlatformPort,
  query: string,
  timeoutMs: number,
  createTraceId: () => string,
): Promise<unknown> {
  const traceId = createTraceId();
  const result = await platform.read({ query, readMode: "raw-tables", traceId, timeoutMs });
  return result.readerResult;
}

function containsEvery(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function countForbidden(texts: readonly string[], forbidden: readonly string[]): number {
  let count = 0;
  for (const text of texts) {
    const normalized = text.toLowerCase();
    if (forbidden.some((term) => normalized.includes(term.toLowerCase()))) count += 1;
  }
  return count;
}

export type XmemoryPilotMemoryFactory = (
  config: XmemoryMemoryConfig,
  platform: XmemoryPlatformPort,
  observers: {
    onRememberCompleted: (result: XmemoryRememberResult) => void;
    onInstanceQuarantined: (result: XmemoryQuarantineResult) => void;
  },
) => Promise<XmemoryMemory>;

export async function runXmemoryPilot(options: {
  manifests: XmemoryPilotManifests;
  config: XmemoryMemoryConfig;
  platform: XmemoryPlatformPort;
  schemaSha256: string;
  createMemory: XmemoryPilotMemoryFactory;
  now?: () => number;
  createRunId?: () => string;
  createTraceId?: () => string;
}): Promise<XmemoryPilotSummary> {
  const validated = validateXmemoryPilotManifests(options.manifests.lessons, options.manifests.queries);
  if (
    !/^[0-9a-f]{64}$/.test(options.manifests.lessonManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(options.manifests.queryManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(options.schemaSha256)
  ) {
    throw new XmemoryPilotManifestError();
  }
  const manifests = { ...options.manifests, ...validated };
  const now = options.now ?? Date.now;
  const createTraceId = options.createTraceId ?? randomUUID;
  const summary = initialSummary({
    runId: (options.createRunId ?? randomUUID)(),
    instanceId: options.config.instanceId,
    schemaSha256: options.schemaSha256,
    manifests,
    startedAt: new Date(now()).toISOString(),
  });
  const writeDurations: number[] = [];
  const readDurations: number[] = [];
  summary.instanceRetired = true;

  try {
    const preflight = decodeXmemoryRawTables(
      await rawRead(options.platform, XMEMORY_PILOT_EMPTY_QUERY, options.config.readTimeoutMs, createTraceId),
    );
    if (preflight !== null && preflight.rows.length !== 0) throw new XmemoryPilotHarnessError();
  } catch {
    summary.harnessFailures = 1;
    summary.aborted = true;
    return finishSummary(summary, now, writeDurations, readDurations);
  }

  let activeSourceAttemptId: string | undefined;
  let observerCalls = 0;
  let memory: XmemoryMemory;
  try {
    memory = await options.createMemory(options.config, options.platform, {
      onRememberCompleted: (result) => {
        if (
          activeSourceAttemptId === undefined ||
          observerCalls !== 0 ||
          result.sourceAttemptId !== activeSourceAttemptId
        ) {
          throw new XmemoryPilotHarnessError();
        }
        observerCalls += 1;
      },
      onInstanceQuarantined: (result) => {
        if (result.instanceId === options.config.instanceId) summary.instanceQuarantined = true;
      },
    });
  } catch {
    summary.harnessFailures = 1;
    summary.aborted = true;
    return finishSummary(summary, now, writeDurations, readDurations);
  }

  const manifestSourceIds = new Set(manifests.lessons.map((entry) => entry.lesson.sourceAttemptId));
  for (const lessonCase of manifests.lessons) {
    activeSourceAttemptId = lessonCase.lesson.sourceAttemptId;
    observerCalls = 0;
    const started = now();
    try {
      await memory.remember(lessonCase.lesson);
      if (observerCalls !== 1) throw new XmemoryPilotHarnessError();
      writeDurations.push(now() - started);
    } catch (error) {
      activeSourceAttemptId = undefined;
      if (error instanceof XmemoryMemoryError && error.code === "observer_failed") {
        summary.harnessFailures += 1;
      } else {
        summary.writeFailures += 1;
      }
      if (
        error instanceof XmemoryMemoryError &&
        (error.code === "write_outcome_unknown" || error.code === "instance_quarantined")
      ) {
        summary.aborted = true;
        summary.instanceQuarantined = true;
        return finishSummary(summary, now, writeDurations, readDurations);
      }
      continue;
    }
    activeSourceAttemptId = undefined;

    try {
      const sourceRows = decodePilotExperienceRows(
        await rawRead(
          options.platform,
          sourceQuery(lessonCase.lesson.sourceAttemptId),
          options.config.readTimeoutMs,
          createTraceId,
        ),
      );
      const insightRows = decodePilotInsightRows(
        await rawRead(
          options.platform,
          insightQuery(lessonCase.lesson.sourceAttemptId),
          options.config.readTimeoutMs,
          createTraceId,
        ),
      );
      if (
        insightRows.some(
          (row) =>
            row.sourceAttemptId !== lessonCase.lesson.sourceAttemptId &&
            !manifestSourceIds.has(row.sourceAttemptId),
        )
      ) {
        throw new XmemoryPilotHarnessError();
      }
      const ownInsights = insightRows.filter(
        (row) => row.sourceAttemptId === lessonCase.lesson.sourceAttemptId,
      );
      if (
        sourceRows.length === 1 &&
        sourceRows[0]?.sourceAttemptId === lessonCase.lesson.sourceAttemptId
      ) {
        summary.sourceIdsPreserved += 1;
      }
      summary.crossAttemptMerges += insightRows.filter(
        (row) =>
          row.sourceAttemptId !== lessonCase.lesson.sourceAttemptId &&
          manifestSourceIds.has(row.sourceAttemptId),
      ).length;
      if (
        ownInsights.some((row) =>
          lessonCase.expectedInsights.some(
            (expected) => row.kind === expected.kind && containsEvery(row.statement, expected.allOf),
          ),
        )
      ) {
        summary.lessonsWithGroundedInsight += 1;
      }
      summary.forbiddenClaims += countForbidden(
        insightRows.map((row) => row.statement),
        lessonCase.forbiddenSubstrings,
      );
    } catch {
      summary.harnessFailures += 1;
    }
  }

  for (const queryCase of manifests.queries) {
    const started = now();
    let hints: Hint[];
    try {
      hints = await memory.recall(queryCase.features, 5);
      readDurations.push(now() - started);
    } catch {
      summary.recallFailures += 1;
      continue;
    }
    try {
      if (!Array.isArray(hints) || hints.length > 1) throw new XmemoryPilotHarnessError();
      if (hints.length === 0) continue;
      const hint = hints[0];
      if (!isRecord(hint) || !nonEmptyString(hint.text) || !nonEmptyString(hint.lessonId)) {
        throw new XmemoryPilotHarnessError();
      }
      const forbidden = countForbidden([hint.text], queryCase.forbiddenSubstrings);
      summary.forbiddenClaims += forbidden;
      if (forbidden === 0 && containsEvery(hint.text, queryCase.expectedAllOf)) {
        summary.queriesWithExpectedAnswer += 1;
      }
    } catch {
      summary.harnessFailures += 1;
    }
  }

  return finishSummary(summary, now, writeDurations, readDurations);
}

export async function writeXmemoryPilotSummaryAtomic(
  path: string,
  summary: XmemoryPilotSummary,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${serializeXmemoryPilotSummary(summary)}\n`, "utf8");
  await rename(temporary, path);
}

export function serializeXmemoryPilotSummary(summary: XmemoryPilotSummary): string {
  return JSON.stringify(summary, (key, value: unknown) => {
    if (
      (key === "writeP95Ms" || key === "readP95Ms") &&
      value === Number.POSITIVE_INFINITY
    ) {
      return "__xmemory_positive_infinity__";
    }
    return value;
  }).replaceAll('"__xmemory_positive_infinity__"', "1e999");
}

function configuredInstanceId(env: NodeJS.ProcessEnv): string {
  try {
    return env.XMEM_INSTANCE_ID?.trim() || "unconfigured";
  } catch {
    return "unconfigured";
  }
}

export type ExecuteXmemoryPilotOptions = {
  env?: NodeJS.ProcessEnv;
  lessonsPath?: string;
  queriesPath?: string;
  gitCwd?: string;
  summaryPath?: string;
  verifyTrackedClean?: (path: string) => boolean | Promise<boolean>;
  loadReviewedSource?: (path: string) => string | Promise<string>;
  selectEnv?: () => NodeJS.ProcessEnv;
  loadSchema?: () => Promise<LoadedXmemorySchema>;
  createPlatform?: (config: XmemoryMemoryConfig) => XmemoryPlatformPort;
  createMemory?: XmemoryPilotMemoryFactory;
  writeSummary?: (path: string, summary: XmemoryPilotSummary) => Promise<void>;
  printSummary?: (line: string) => void;
};

export async function executeXmemoryPilot(
  options: ExecuteXmemoryPilotOptions = {},
): Promise<number> {
  const printSummary = options.printSummary ?? console.log;
  let manifests: XmemoryPilotManifests;
  try {
    manifests = await loadXmemoryPilotManifests({
      lessonsPath: options.lessonsPath,
      queriesPath: options.queriesPath,
      gitCwd: options.gitCwd,
      verifyTrackedClean: options.verifyTrackedClean,
      loadReviewedSource: options.loadReviewedSource,
    });
  } catch {
    printSummary(JSON.stringify({ instanceRetired: false, errorCode: "invalid_input" }));
    return 1;
  }

  let env: NodeJS.ProcessEnv | undefined;
  let config: XmemoryMemoryConfig | undefined;
  let summary: XmemoryPilotSummary;
  const now = Date.now;
  let schemaSha256 = "0".repeat(64);
  let cloudStarted = false;
  try {
    env = (options.selectEnv ?? (() => options.env ?? process.env))();
    const schema = await (options.loadSchema ?? loadXmemorySchema)();
    if (!/^[0-9a-f]{64}$/.test(schema.sha256)) throw new Error("invalid schema hash");
    schemaSha256 = schema.sha256;
    if (!xmemoryIntegrationEnabled(env)) throw new Error("integration disabled");
    const integration = loadXmemoryIntegrationConfig(env);
    config = loadXmemoryMemoryConfig(env);
    if (
      integration.apiKey !== config.apiKey ||
      integration.runtimeInstanceId !== config.instanceId
    ) {
      throw new Error("integration config mismatch");
    }
    const platform = (options.createPlatform ?? ((value) =>
      createXmemoryPlatformPort({ apiKey: value.apiKey, instanceId: value.instanceId })))(config);
    const createMemory = options.createMemory ?? (async (value, sharedPlatform, observers) =>
      createXmemoryMemory({ snapshots: false }, value, { platform: sharedPlatform, ...observers }));
    cloudStarted = true;
    summary = await runXmemoryPilot({
      manifests,
      config,
      platform,
      schemaSha256,
      createMemory,
    });
  } catch {
    const timestamp = new Date(now()).toISOString();
    summary = initialSummary({
      runId: randomUUID(),
      instanceId: config?.instanceId ?? configuredInstanceId(env ?? {}),
      schemaSha256,
      manifests,
      startedAt: timestamp,
    });
    summary.finishedAt = timestamp;
    summary.harnessFailures = 1;
    summary.aborted = true;
    summary.instanceRetired = cloudStarted;
  }

  try {
    await (options.writeSummary ?? writeXmemoryPilotSummaryAtomic)(
      options.summaryPath ?? XMEMORY_PILOT_SUMMARY_PATH,
      summary,
    );
  } catch {
    summary.harnessFailures += 1;
    summary.aborted = true;
    summary.passedWithoutQuota = false;
  }
  printSummary(serializeXmemoryPilotSummary(summary));
  return summary.passedWithoutQuota ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const provisioned = await provisionDisposableXmemoryInstance("pilot");
    if (!provisioned.created || !provisioned.schemaVerified || provisioned.instanceId === null) {
      process.stdout.write(
        `${JSON.stringify({
          instanceRetired: provisioned.instanceRetired,
          errorCode: provisioned.errorCode ?? "protocol_error",
        })}\n`,
      );
      process.exitCode = 1;
    } else {
      process.exitCode = await executeXmemoryPilot({
        env: {
          ...process.env,
          XMEM_INSTANCE_ID: provisioned.instanceId,
          XMEM_INTEGRATION: "1",
          XMEM_INTEGRATION_INSTANCE_ID: `internal-${randomUUID()}`,
        },
      });
    }
  } catch {
    process.stdout.write(
      `${JSON.stringify({ instanceRetired: false, errorCode: "unsupported_configuration" })}\n`,
    );
    process.exitCode = 1;
  }
}
