import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Hint, LessonInput } from "../memory.ts";
import {
  buildHindsightRecallQuery,
  createHindsightMemory,
  loadHindsightMemoryConfig,
  type HindsightMemory,
  type HindsightMemoryConfig,
  type HindsightRememberResult,
} from "./memory.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RETAIN_CONTEXT,
  HINDSIGHT_RETAIN_MISSION,
  createHindsightPlatformPort,
  resolveHindsightMemorySource,
  type HindsightMemoryResult,
  type HindsightMemorySource,
  type HindsightPlatformPort,
  type HindsightRecallRequest,
} from "./platform-contract.ts";
import { HindsightMemoryError } from "./error.ts";

export const HINDSIGHT_PILOT_LESSONS_PATH =
  "benchmark/samples/hindsight-pilot-v1-lessons.jsonl";
export const HINDSIGHT_PILOT_QUERIES_PATH =
  "benchmark/samples/hindsight-pilot-v1-queries.jsonl";
export const HINDSIGHT_PILOT_SUMMARY_PATH = "tmp/hindsight-pilot-v1-summary.json";

export type HindsightPilotLessonCase = {
  caseId: string;
  stratum: "positive" | "negative" | "comparison" | "ambiguous" | "incomplete";
  lesson: LessonInput;
  expectedDocumentId: string;
  expectedFactTerms: string[];
  forbiddenSubstrings: string[];
};

export type HindsightPilotQueryCase = {
  caseId: string;
  features: string[];
  expectedDocumentIds: string[];
  expectedTerms: string[];
  forbiddenSubstrings: string[];
};

export type HindsightPilotSummary = {
  runId: string;
  bankId: string;
  apiVersion: string;
  lessonManifestSha256: string;
  queryManifestSha256: string;
  lessonCases: 30;
  queryCases: 30;
  emptyFeatureCases: 5;
  sourceIdsPreserved: number;
  lessonsWithGroundedFact: number;
  crossAttemptMerges: number;
  forbiddenClaims: number;
  queriesWithExpectedEvidence: number;
  writeFailures: number;
  recallFailures: number;
  writeP95Ms: number | null;
  readP95Ms: number | null;
  quarantined: boolean;
  passed: boolean;
};

export type HindsightPilotManifests = {
  lessons: HindsightPilotLessonCase[];
  queries: HindsightPilotQueryCase[];
  lessonManifestSha256: string;
  queryManifestSha256: string;
};

export type HindsightPilotSourceBindings = {
  pilot: HindsightMemorySource;
  integration: HindsightMemorySource;
};

export class HindsightPilotManifestError extends Error {
  constructor() {
    super("Hindsight pilot manifests are invalid");
    this.name = "HindsightPilotManifestError";
  }
}

class HindsightPilotHarnessError extends Error {}

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRATA = ["positive", "negative", "comparison", "ambiguous", "incomplete"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index])
    );
  } catch {
    return false;
  }
}

function denseArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function stringArray(value: unknown, allowEmpty: boolean): string[] {
  if (
    !denseArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new HindsightPilotManifestError();
  }
  return [...value] as string[];
}

function parseJsonLines(source: string): unknown[] {
  const values: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      throw new HindsightPilotManifestError();
    }
  }
  return values;
}

function parseLessonCase(value: unknown): HindsightPilotLessonCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "caseId",
      "stratum",
      "lesson",
      "expectedDocumentId",
      "expectedFactTerms",
      "forbiddenSubstrings",
    ]) ||
    !nonEmptyString(value.caseId) ||
    typeof value.stratum !== "string" ||
    !(STRATA as readonly string[]).includes(value.stratum) ||
    !isRecord(value.lesson) ||
    !exactKeys(value.lesson, ["content", "sourceAttemptId", "triggers", "region"]) ||
    !nonEmptyString(value.lesson.content) ||
    !nonEmptyString(value.lesson.sourceAttemptId) ||
    typeof value.lesson.region !== "string" ||
    !nonEmptyString(value.expectedDocumentId)
  ) {
    throw new HindsightPilotManifestError();
  }
  const triggers = stringArray(value.lesson.triggers, true);
  const expectedFactTerms = stringArray(value.expectedFactTerms, false);
  const forbiddenSubstrings = stringArray(value.forbiddenSubstrings, true);
  const sourceAttemptId = value.lesson.sourceAttemptId.trim();
  if (
    value.lesson.content.length > 50_000 ||
    value.lesson.region.length > 256 ||
    triggers.length > 64 ||
    triggers.some((trigger) => trigger.length > 256) ||
    !SOURCE_ID.test(sourceAttemptId) ||
    value.expectedDocumentId !== sourceAttemptId ||
    expectedFactTerms.some((term) => term.trim() === "") ||
    forbiddenSubstrings.some((term) => typeof term !== "string")
  ) {
    throw new HindsightPilotManifestError();
  }
  return {
    caseId: value.caseId,
    stratum: value.stratum as HindsightPilotLessonCase["stratum"],
    lesson: {
      content: value.lesson.content,
      sourceAttemptId,
      triggers,
      region: value.lesson.region,
    },
    expectedDocumentId: value.expectedDocumentId,
    expectedFactTerms,
    forbiddenSubstrings,
  };
}

function parseQueryCase(value: unknown): HindsightPilotQueryCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["caseId", "features", "expectedDocumentIds", "expectedTerms", "forbiddenSubstrings"]) ||
    !nonEmptyString(value.caseId)
  ) {
    throw new HindsightPilotManifestError();
  }
  const features = stringArray(value.features, true);
  const expectedDocumentIds = stringArray(value.expectedDocumentIds, false);
  const expectedTerms = stringArray(value.expectedTerms, false);
  const forbiddenSubstrings = stringArray(value.forbiddenSubstrings, true);
  if (
    features.length > 64 ||
    features.some((feature) => feature.length > 256) ||
    expectedDocumentIds.some((id) => !SOURCE_ID.test(id)) ||
    expectedTerms.some((term) => term.trim() === "") ||
    forbiddenSubstrings.some((term) => typeof term !== "string")
  ) {
    throw new HindsightPilotManifestError();
  }
  return {
    caseId: value.caseId,
    features,
    expectedDocumentIds,
    expectedTerms,
    forbiddenSubstrings,
  };
}

export function validateHindsightPilotManifests(
  lessonValues: readonly unknown[],
  queryValues: readonly unknown[],
): Pick<HindsightPilotManifests, "lessons" | "queries"> {
  try {
    const lessons = lessonValues.map(parseLessonCase);
    const queries = queryValues.map(parseQueryCase);
    const lessonIds = new Set(lessons.map((entry) => entry.caseId));
    const queryIds = new Set(queries.map((entry) => entry.caseId));
    const sourceIds = new Set(lessons.map((entry) => entry.lesson.sourceAttemptId));
    const stratumCounts = new Map<string, number>();
    for (const lesson of lessons) {
      stratumCounts.set(lesson.stratum, (stratumCounts.get(lesson.stratum) ?? 0) + 1);
    }
    if (
      lessons.length !== 30 ||
      queries.length !== 30 ||
      lessonIds.size !== 30 ||
      queryIds.size !== 30 ||
      sourceIds.size !== 30 ||
      STRATA.some((stratum) => stratumCounts.get(stratum) !== 6) ||
      [...lessonIds].some((caseId) => !queryIds.has(caseId)) ||
      queries.some((query) =>
        query.expectedDocumentIds.some((documentId) => !sourceIds.has(documentId)),
      ) ||
      queries.filter((query) => query.features.length === 0).length !== 5
    ) {
      throw new HindsightPilotManifestError();
    }
    return { lessons, queries };
  } catch {
    throw new HindsightPilotManifestError();
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function reviewedGitPath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

function reviewedHead(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

export function verifyHindsightPilotTrackedClean(
  path: string,
  cwd = process.cwd(),
  head = reviewedHead(cwd),
): boolean {
  if (head === null || !reviewedGitPath(path)) return false;
  return [
    ["cat-file", "-e", `${head}:${path}`],
    ["diff", "--quiet", head, "--", path],
  ].every((args) => spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0);
}

function readReviewedBlob(path: string, cwd: string, head: string): string {
  if (!reviewedGitPath(path)) throw new HindsightPilotManifestError();
  const result = spawnSync("git", ["show", `${head}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new HindsightPilotManifestError();
  return result.stdout;
}

export async function loadHindsightPilotManifests(options: {
  lessonsPath?: string;
  queriesPath?: string;
  gitCwd?: string;
  verifyTrackedClean?: (path: string) => boolean | Promise<boolean>;
  loadReviewedSource?: (path: string) => string | Promise<string>;
} = {}): Promise<HindsightPilotManifests> {
  const lessonsPath = options.lessonsPath ?? HINDSIGHT_PILOT_LESSONS_PATH;
  const queriesPath = options.queriesPath ?? HINDSIGHT_PILOT_QUERIES_PATH;
  const cwd = options.gitCwd ?? process.cwd();
  const head = reviewedHead(cwd);
  const verify = options.verifyTrackedClean ?? ((path: string) => verifyHindsightPilotTrackedClean(path, cwd, head));
  const load = options.loadReviewedSource ?? ((path: string) => {
    if (head === null) throw new HindsightPilotManifestError();
    return readReviewedBlob(path, cwd, head);
  });
  const [lessonsClean, queriesClean] = await Promise.all([verify(lessonsPath), verify(queriesPath)]);
  if (!lessonsClean || !queriesClean) throw new HindsightPilotManifestError();
  const [lessonSource, querySource] = await Promise.all([load(lessonsPath), load(queriesPath)]);
  const manifests = validateHindsightPilotManifests(
    parseJsonLines(lessonSource),
    parseJsonLines(querySource),
  );
  return {
    ...manifests,
    lessonManifestSha256: sha256(lessonSource),
    queryManifestSha256: sha256(querySource),
  };
}

export function hindsightPilotP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

function containsEvery(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function containsForbidden(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function initialSummary(input: {
  runId: string;
  bankId: string;
  apiVersion: string;
  manifests: HindsightPilotManifests;
}): HindsightPilotSummary {
  return {
    runId: input.runId,
    bankId: input.bankId,
    apiVersion: input.apiVersion,
    lessonManifestSha256: input.manifests.lessonManifestSha256,
    queryManifestSha256: input.manifests.queryManifestSha256,
    lessonCases: 30,
    queryCases: 30,
    emptyFeatureCases: 5,
    sourceIdsPreserved: 0,
    lessonsWithGroundedFact: 0,
    crossAttemptMerges: 0,
    forbiddenClaims: 0,
    queriesWithExpectedEvidence: 0,
    writeFailures: 0,
    recallFailures: 0,
    writeP95Ms: null,
    readP95Ms: null,
    quarantined: false,
    passed: false,
  };
}

export function hindsightPilotPasses(summary: HindsightPilotSummary): boolean {
  return (
    summary.lessonCases === 30 &&
    summary.queryCases === 30 &&
    summary.emptyFeatureCases === 5 &&
    summary.sourceIdsPreserved === 30 &&
    summary.lessonsWithGroundedFact >= 24 &&
    summary.crossAttemptMerges === 0 &&
    summary.forbiddenClaims === 0 &&
    summary.queriesWithExpectedEvidence >= 24 &&
    summary.writeFailures === 0 &&
    summary.recallFailures === 0 &&
    summary.quarantined === false &&
    summary.writeP95Ms !== null &&
    summary.readP95Ms !== null &&
    summary.writeP95Ms <= 180_000 &&
    summary.readP95Ms <= 60_000
  );
}

export type HindsightPilotRetirementReason =
  | "non_empty_preflight"
  | "unknown_write_outcome"
  | "harness_failure";

export type HindsightPilotMemoryFactory = (
  config: HindsightMemoryConfig,
  platform: HindsightPlatformPort,
  observers: {
    onRememberCompleted: (result: HindsightRememberResult) => void | Promise<void>;
    onInstanceQuarantined: (result: { bankId: string; code: "write_outcome_unknown" }) => void | Promise<void>;
  },
) => HindsightMemory | Promise<HindsightMemory>;

export type HindsightPilotRunOptions = {
  manifests: HindsightPilotManifests;
  config: HindsightMemoryConfig;
  sources: HindsightPilotSourceBindings;
  platform: HindsightPlatformPort;
  createMemory?: HindsightPilotMemoryFactory;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  createRunId?: () => string;
  onBankRetirementRequired?: (reason: HindsightPilotRetirementReason) => void | Promise<void>;
};

function validSource(source: unknown, purpose: "integration" | "pilot"): source is HindsightMemorySource {
  try {
    return (
      isRecord(source) &&
      typeof source.memoryRef === "string" &&
      source.memoryRef.trim() !== "" &&
      source.provider === "hindsight" &&
      source.deployment === "cloud" &&
      typeof source.bankId === "string" &&
      source.bankId.trim() !== "" &&
      source.purpose === purpose &&
      source.credentialEnv === "HINDSIGHT_API_KEY"
    );
  } catch {
    return false;
  }
}

export function validateHindsightPilotSourceBindings(
  sources: HindsightPilotSourceBindings,
): void {
  if (
    !validSource(sources.pilot, "pilot") ||
    !validSource(sources.integration, "integration") ||
    sources.pilot.bankId === sources.integration.bankId
  ) {
    throw new HindsightPilotManifestError();
  }
}

function rawRecallRequest(config: HindsightMemoryConfig, query: string): HindsightRecallRequest {
  return {
    bankId: config.source.bankId,
    query,
    maxTokens: config.maxTokens,
    budget: config.recallBudget,
    types: ["world", "experience", "observation"],
    preferObservations: true,
    includeSourceFacts: false,
    includeChunks: false,
    includeEntities: false,
    timeoutMs: config.readTimeoutMs,
    signal: AbortSignal.timeout(config.readTimeoutMs),
  };
}

async function withAbort<T>(
  signal: AbortSignal,
  operation: "read" | "config",
  call: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new HindsightMemoryError("timeout", operation);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectOnAbort = () => reject(new HindsightMemoryError("timeout", operation));
    if (signal.aborted) rejectOnAbort();
    else {
      onAbort = rejectOnAbort;
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    }
  });
  try {
    const result = await Promise.race([call(), aborted]);
    if (signal.aborted) throw new HindsightMemoryError("timeout", operation);
    return result;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function rawRecall(
  platform: HindsightPlatformPort,
  config: HindsightMemoryConfig,
  query: string,
): Promise<HindsightMemoryResult[]> {
  const request = rawRecallRequest(config, query);
  const response = await withAbort(request.signal, "read", () => platform.recall(request));
  if (!isRecord(response) || !denseArray(response.results)) {
    throw new HindsightPilotHarnessError();
  }
  const results: HindsightMemoryResult[] = [];
  for (const result of response.results) {
    if (
      !isRecord(result) ||
      !nonEmptyString(result.id) ||
      !nonEmptyString(result.text) ||
      (result.documentId !== null && typeof result.documentId !== "string")
    ) {
      throw new HindsightPilotHarnessError();
    }
    results.push(result as unknown as HindsightMemoryResult);
  }
  return results;
}

function inspectLessonResults(
  summary: HindsightPilotSummary,
  lessonCase: HindsightPilotLessonCase,
  results: readonly HindsightMemoryResult[],
): void {
  let sourcePreserved = false;
  let grounded = false;
  for (const result of results) {
    if (result.documentId === lessonCase.expectedDocumentId) {
      sourcePreserved = true;
      if (lessonCase.expectedFactTerms.some((term) => result.text.toLowerCase().includes(term.toLowerCase()))) {
        grounded = true;
      }
    }
    if (
      result.documentId !== null &&
      result.documentId !== "" &&
      result.documentId !== lessonCase.expectedDocumentId
    ) {
      summary.crossAttemptMerges += 1;
    }
    if (containsForbidden(result.text, lessonCase.forbiddenSubstrings)) {
      summary.forbiddenClaims += 1;
    }
  }
  if (sourcePreserved) summary.sourceIdsPreserved += 1;
  if (grounded) summary.lessonsWithGroundedFact += 1;
}

function inspectQueryResults(
  summary: HindsightPilotSummary,
  queryCase: HindsightPilotQueryCase,
  results: readonly HindsightMemoryResult[],
): boolean {
  let expected = false;
  const expectedIds = new Set(queryCase.expectedDocumentIds);
  for (const result of results) {
    if (
      result.documentId !== null &&
      result.documentId !== "" &&
      !expectedIds.has(result.documentId)
    ) {
      summary.crossAttemptMerges += 1;
    }
    if (containsForbidden(result.text, queryCase.forbiddenSubstrings)) {
      summary.forbiddenClaims += 1;
    }
    if (
      result.documentId !== null &&
      result.documentId !== "" &&
      expectedIds.has(result.documentId) &&
      containsEvery(result.text, queryCase.expectedTerms) &&
      !containsForbidden(result.text, queryCase.forbiddenSubstrings)
    ) {
      expected = true;
    }
  }
  return expected;
}

async function notifyRetirement(
  callback: HindsightPilotRunOptions["onBankRetirementRequired"],
  reason: HindsightPilotRetirementReason,
): Promise<void> {
  if (callback === undefined) return;
  try {
    await callback(reason);
  } catch {
    // Retirement notification is advisory; never expose its error or raw context.
  }
}

function finishSummary(
  summary: HindsightPilotSummary,
  writeDurations: readonly number[],
  readDurations: readonly number[],
): HindsightPilotSummary {
  summary.writeP95Ms = hindsightPilotP95(writeDurations);
  summary.readP95Ms = hindsightPilotP95(readDurations);
  summary.passed = hindsightPilotPasses(summary);
  return summary;
}

export async function runHindsightPilot(options: HindsightPilotRunOptions): Promise<HindsightPilotSummary> {
  const manifests = validateHindsightPilotManifests(options.manifests.lessons, options.manifests.queries);
  if (
    !/^[0-9a-f]{64}$/.test(options.manifests.lessonManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(options.manifests.queryManifestSha256)
  ) {
    throw new HindsightPilotManifestError();
  }
  validateHindsightPilotSourceBindings(options.sources);
  if (
    !validSource(options.config.source, "pilot") ||
    options.config.source.bankId !== options.sources.pilot.bankId
  ) {
    throw new HindsightPilotManifestError();
  }
  const validated = { ...options.manifests, ...manifests };
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? ((milliseconds: number) => sleep(milliseconds));
  const summary = initialSummary({
    runId: (options.createRunId ?? randomUUID)(),
    bankId: options.sources.pilot.bankId,
    apiVersion: "unknown",
    manifests: validated,
  });
  const writeDurations: number[] = [];
  const readDurations: number[] = [];

  try {
    const versionSignal = AbortSignal.timeout(options.config.readTimeoutMs);
    const version = await withAbort(versionSignal, "config", () =>
      options.platform.getVersion({ timeoutMs: options.config.readTimeoutMs, signal: versionSignal }),
    );
    summary.apiVersion = version.apiVersion;
  } catch {
    summary.recallFailures += 1;
    await notifyRetirement(options.onBankRetirementRequired, "harness_failure");
    return finishSummary(summary, writeDurations, readDurations);
  }

  try {
    const preflightSignal = AbortSignal.timeout(options.config.readTimeoutMs);
    const preflight = await withAbort(preflightSignal, "read", () =>
      options.platform.listDocuments({
        bankId: options.sources.pilot.bankId,
        timeoutMs: options.config.readTimeoutMs,
        signal: preflightSignal,
      }),
    );
    if (preflight.total !== 0) {
      summary.writeFailures += 1;
      await notifyRetirement(options.onBankRetirementRequired, "non_empty_preflight");
      return finishSummary(summary, writeDurations, readDurations);
    }
  } catch {
    summary.writeFailures += 1;
    await notifyRetirement(options.onBankRetirementRequired, "harness_failure");
    return finishSummary(summary, writeDurations, readDurations);
  }

  let activeSourceAttemptId: string | undefined;
  let observerCalls = 0;
  let memory: HindsightMemory;
  try {
    memory = await (options.createMemory ?? ((config, platform, observers) =>
      createHindsightMemory({ snapshots: false }, config, { platform, ...observers })))(
      options.config,
      options.platform,
      {
        onRememberCompleted: (result) => {
          if (
            activeSourceAttemptId === undefined ||
            observerCalls !== 0 ||
            result.sourceAttemptId !== activeSourceAttemptId
          ) {
            throw new HindsightPilotHarnessError();
          }
          observerCalls += 1;
        },
        onInstanceQuarantined: async (result) => {
          if (result.bankId === options.sources.pilot.bankId) summary.quarantined = true;
          await notifyRetirement(options.onBankRetirementRequired, "unknown_write_outcome");
        },
      },
    );
  } catch {
    summary.writeFailures += 1;
    await notifyRetirement(options.onBankRetirementRequired, "harness_failure");
    return finishSummary(summary, writeDurations, readDurations);
  }

  for (const lessonCase of validated.lessons) {
    if (summary.quarantined) break;
    activeSourceAttemptId = lessonCase.lesson.sourceAttemptId;
    observerCalls = 0;
    const started = now();
    try {
      await memory.remember(lessonCase.lesson);
      if (observerCalls !== 1) throw new HindsightPilotHarnessError();
      writeDurations.push(now() - started);
    } catch (error) {
      activeSourceAttemptId = undefined;
      summary.writeFailures += 1;
      if (error instanceof HindsightMemoryError &&
        (error.code === "write_outcome_unknown" || error.code === "instance_quarantined")) {
        summary.quarantined = true;
        await notifyRetirement(options.onBankRetirementRequired, "unknown_write_outcome");
        break;
      }
      await notifyRetirement(options.onBankRetirementRequired, "harness_failure");
      continue;
    }
    activeSourceAttemptId = undefined;

    try {
      const startedRead = now();
      const results = await rawRecall(
        options.platform,
        options.config,
        buildHindsightRecallQuery(lessonCase.lesson.triggers, options.config.priorQuery),
      );
      readDurations.push(now() - startedRead);
      inspectLessonResults(summary, lessonCase, results);
    } catch {
      summary.recallFailures += 1;
    }
  }

  if (summary.quarantined) return finishSummary(summary, writeDurations, readDurations);

  const matchedQueries = new Set<string>();
  const checkpoint = async (): Promise<void> => {
    for (const queryCase of validated.queries) {
      const started = now();
      try {
        const results = await rawRecall(
          options.platform,
          options.config,
          buildHindsightRecallQuery(queryCase.features, options.config.priorQuery),
        );
        readDurations.push(now() - started);
        if (inspectQueryResults(summary, queryCase, results)) {
          matchedQueries.add(queryCase.caseId);
        }
      } catch {
        summary.recallFailures += 1;
      }
    }
  };

  try {
    await wait(60_000);
    await checkpoint();
    await wait(240_000);
    await checkpoint();
  } catch {
    summary.recallFailures += 1;
    await notifyRetirement(options.onBankRetirementRequired, "harness_failure");
  }

  summary.queriesWithExpectedEvidence = matchedQueries.size;
  return finishSummary(summary, writeDurations, readDurations);
}

export type HindsightPilotSourceInput = {
  memoryRef: string;
  bankId: string;
};

export function parseHindsightPilotArgs(
  args: readonly string[] = process.argv.slice(2),
): { pilot: HindsightPilotSourceInput; integration: HindsightPilotSourceInput } | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name === "--pilot-memory-ref" ||
        name === "--pilot-bank-id" ||
        name === "--integration-memory-ref" ||
        name === "--integration-bank-id") &&
      typeof value === "string" &&
      value !== "" &&
      !value.startsWith("--")
    ) {
      values.set(name, value);
      index += 1;
    }
  }
  const pilotMemoryRef = values.get("--pilot-memory-ref");
  const pilotBankId = values.get("--pilot-bank-id");
  const integrationMemoryRef = values.get("--integration-memory-ref");
  const integrationBankId = values.get("--integration-bank-id");
  if (
    pilotMemoryRef === undefined ||
    pilotBankId === undefined ||
    integrationMemoryRef === undefined ||
    integrationBankId === undefined
  ) {
    return null;
  }
  return {
    pilot: { memoryRef: pilotMemoryRef, bankId: pilotBankId },
    integration: { memoryRef: integrationMemoryRef, bankId: integrationBankId },
  };
}

export async function writeHindsightPilotSummaryAtomic(
  path: string,
  summary: HindsightPilotSummary,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${serializeHindsightPilotSummary(summary)}\n`, "utf8");
  await rename(temporary, path);
}

export function serializeHindsightPilotSummary(summary: HindsightPilotSummary): string {
  return JSON.stringify(summary);
}

export type ExecuteHindsightPilotOptions = {
  env?: NodeJS.ProcessEnv;
  args?: readonly string[];
  manifests?: HindsightPilotManifests;
  lessonsPath?: string;
  queriesPath?: string;
  gitCwd?: string;
  summaryPath?: string;
  verifyTrackedClean?: (path: string) => boolean | Promise<boolean>;
  loadReviewedSource?: (path: string) => string | Promise<string>;
  pilotSource?: HindsightPilotSourceInput;
  integrationSource?: HindsightPilotSourceInput;
  createPlatform?: (config: HindsightMemoryConfig) => HindsightPlatformPort;
  createMemory?: HindsightPilotMemoryFactory;
  writeSummary?: (path: string, summary: HindsightPilotSummary) => Promise<void>;
  printSummary?: (line: string) => void;
};

function sourceBindings(
  input: { pilot: HindsightPilotSourceInput; integration: HindsightPilotSourceInput },
): HindsightPilotSourceBindings {
  return {
    pilot: resolveHindsightMemorySource({ ...input.pilot, purpose: "pilot" }),
    integration: resolveHindsightMemorySource({ ...input.integration, purpose: "integration" }),
  };
}

export async function executeHindsightPilot(
  options: ExecuteHindsightPilotOptions = {},
): Promise<number> {
  const printSummary = options.printSummary ?? console.log;
  let manifests: HindsightPilotManifests;
  try {
    manifests = options.manifests ?? await loadHindsightPilotManifests({
      lessonsPath: options.lessonsPath,
      queriesPath: options.queriesPath,
      gitCwd: options.gitCwd,
      verifyTrackedClean: options.verifyTrackedClean,
      loadReviewedSource: options.loadReviewedSource,
    });
  } catch {
    printSummary(JSON.stringify({ errorCode: "invalid_input" }));
    return 1;
  }

  let summary: HindsightPilotSummary | undefined;
  try {
    const parsed = parseHindsightPilotArgs(options.args);
    const pilotInput = options.pilotSource ?? parsed?.pilot;
    const integrationInput = options.integrationSource ?? parsed?.integration;
    if (pilotInput === undefined || integrationInput === undefined) {
      throw new HindsightPilotHarnessError();
    }
    const sources = sourceBindings({ pilot: pilotInput, integration: integrationInput });
    validateHindsightPilotSourceBindings(sources);
    const config = loadHindsightMemoryConfig(sources.pilot, options.env ?? process.env);
    const platform = (options.createPlatform ?? ((value) =>
      createHindsightPlatformPort({ apiKey: value.apiKey, baseUrl: value.baseUrl })))(config);
    summary = await runHindsightPilot({
      manifests,
      config,
      sources,
      platform,
      createMemory: options.createMemory,
    });
  } catch {
    const parsed = parseHindsightPilotArgs(options.args);
    const bankId = options.pilotSource?.bankId ?? parsed?.pilot.bankId ?? "unconfigured";
    summary = initialSummary({
      runId: randomUUID(),
      bankId,
      apiVersion: "unknown",
      manifests,
    });
    summary.writeFailures = 1;
  }

  try {
    await (options.writeSummary ?? writeHindsightPilotSummaryAtomic)(
      options.summaryPath ?? HINDSIGHT_PILOT_SUMMARY_PATH,
      summary,
    );
  } catch {
    summary.writeFailures += 1;
    summary.passed = false;
  }
  printSummary(serializeHindsightPilotSummary(summary));
  return summary.passed ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = await executeHindsightPilot();
}
