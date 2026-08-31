import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XmemoryMemoryError } from "./error.ts";
import {
  XMEMORY_PILOT_SUMMARY_PATH,
  serializeXmemoryPilotSummary,
  xmemoryPilotPassesWithoutQuota,
  type XmemoryPilotSummary,
} from "./pilot.ts";

export type XmemoryPilotEvidence = XmemoryPilotSummary & {
  providerCounterBefore: number;
  providerCounterAfter: number;
  providerTokens: number;
  counterBeforeCapturedAt: string;
  counterAfterCapturedAt: string;
  isolatedAccount: true;
  passed: boolean;
};

export type XmemoryPilotCounterInput = {
  providerCounterBefore: number;
  providerCounterAfter: number;
  counterBeforeCapturedAt: string;
  counterAfterCapturedAt: string;
  isolatedAccount: true;
};

function evidenceError(): XmemoryMemoryError {
  return new XmemoryMemoryError(
    "invalid_input",
    "read",
    "The xmemory pilot evidence input is invalid",
  );
}

function safeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function snapshotExactPlainShape(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw evidenceError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw evidenceError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw evidenceError();
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor?.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw evidenceError();
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return snapshot;
}

const SUMMARY_KEYS = [
  "runId",
  "instanceId",
  "schemaSha256",
  "lessonManifestSha256",
  "queryManifestSha256",
  "startedAt",
  "finishedAt",
  "lessonCases",
  "sourceIdsPreserved",
  "lessonsWithGroundedInsight",
  "crossAttemptMerges",
  "forbiddenClaims",
  "queryCases",
  "queriesWithExpectedAnswer",
  "writeFailures",
  "recallFailures",
  "harnessFailures",
  "writeP95Ms",
  "readP95Ms",
  "aborted",
  "instanceQuarantined",
  "instanceRetired",
  "passedWithoutQuota",
] as const;

const COUNTER_INPUT_KEYS = [
  "providerCounterBefore",
  "providerCounterAfter",
  "counterBeforeCapturedAt",
  "counterAfterCapturedAt",
  "isolatedAccount",
] as const;

function isoTime(value: unknown): number {
  if (typeof value !== "string") throw evidenceError();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw evidenceError();
  }
  return milliseconds;
}

function validateSummary(summary: XmemoryPilotSummary): void {
  const strings = [
    summary.runId,
    summary.instanceId,
    summary.schemaSha256,
    summary.lessonManifestSha256,
    summary.queryManifestSha256,
  ];
  if (
    strings.some((value) => typeof value !== "string" || value.trim() === "") ||
    !/^[0-9a-f]{64}$/.test(summary.schemaSha256) ||
    !/^[0-9a-f]{64}$/.test(summary.lessonManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(summary.queryManifestSha256) ||
    summary.lessonCases !== 30 ||
    summary.queryCases !== 30 ||
    typeof summary.passedWithoutQuota !== "boolean" ||
    summary.passedWithoutQuota !== xmemoryPilotPassesWithoutQuota(summary) ||
    typeof summary.instanceRetired !== "boolean" ||
    typeof summary.instanceQuarantined !== "boolean" ||
    typeof summary.aborted !== "boolean"
  ) {
    throw evidenceError();
  }
  if (
    !safeCounter(summary.sourceIdsPreserved) ||
    summary.sourceIdsPreserved > 30 ||
    !safeCounter(summary.lessonsWithGroundedInsight) ||
    summary.lessonsWithGroundedInsight > 30 ||
    !safeCounter(summary.crossAttemptMerges) ||
    !safeCounter(summary.forbiddenClaims) ||
    !safeCounter(summary.queriesWithExpectedAnswer) ||
    summary.queriesWithExpectedAnswer > 30 ||
    !safeCounter(summary.writeFailures) ||
    summary.writeFailures > 30 ||
    !safeCounter(summary.recallFailures) ||
    summary.recallFailures > 30 ||
    !safeCounter(summary.harnessFailures) ||
    summary.harnessFailures > 60
  ) {
    throw evidenceError();
  }
  if (
    typeof summary.writeP95Ms !== "number" ||
    Number.isNaN(summary.writeP95Ms) ||
    summary.writeP95Ms === Number.NEGATIVE_INFINITY ||
    summary.writeP95Ms < 0 ||
    typeof summary.readP95Ms !== "number" ||
    Number.isNaN(summary.readP95Ms) ||
    summary.readP95Ms === Number.NEGATIVE_INFINITY ||
    summary.readP95Ms < 0
  ) {
    throw evidenceError();
  }
}

export function finalizeXmemoryPilot(
  summary: XmemoryPilotSummary,
  input: XmemoryPilotCounterInput,
): XmemoryPilotEvidence {
  try {
    const safeSummary = snapshotExactPlainShape(summary, SUMMARY_KEYS) as XmemoryPilotSummary;
    const safeInput = snapshotExactPlainShape(input, COUNTER_INPUT_KEYS) as XmemoryPilotCounterInput;
    validateSummary(safeSummary);
    if (
      !safeCounter(safeInput.providerCounterBefore) ||
      !safeCounter(safeInput.providerCounterAfter) ||
      safeInput.providerCounterAfter < safeInput.providerCounterBefore ||
      safeInput.isolatedAccount !== true
    ) {
      throw evidenceError();
    }
    const beforeCapturedAt = isoTime(safeInput.counterBeforeCapturedAt);
    const startedAt = isoTime(safeSummary.startedAt);
    const finishedAt = isoTime(safeSummary.finishedAt);
    const afterCapturedAt = isoTime(safeInput.counterAfterCapturedAt);
    if (!(beforeCapturedAt <= startedAt && startedAt <= finishedAt && finishedAt <= afterCapturedAt)) {
      throw evidenceError();
    }
    const providerTokens = safeInput.providerCounterAfter - safeInput.providerCounterBefore;
    return {
      runId: safeSummary.runId,
      instanceId: safeSummary.instanceId,
      schemaSha256: safeSummary.schemaSha256,
      lessonManifestSha256: safeSummary.lessonManifestSha256,
      queryManifestSha256: safeSummary.queryManifestSha256,
      startedAt: safeSummary.startedAt,
      finishedAt: safeSummary.finishedAt,
      lessonCases: safeSummary.lessonCases,
      sourceIdsPreserved: safeSummary.sourceIdsPreserved,
      lessonsWithGroundedInsight: safeSummary.lessonsWithGroundedInsight,
      crossAttemptMerges: safeSummary.crossAttemptMerges,
      forbiddenClaims: safeSummary.forbiddenClaims,
      queryCases: safeSummary.queryCases,
      queriesWithExpectedAnswer: safeSummary.queriesWithExpectedAnswer,
      writeFailures: safeSummary.writeFailures,
      recallFailures: safeSummary.recallFailures,
      harnessFailures: safeSummary.harnessFailures,
      writeP95Ms: safeSummary.writeP95Ms,
      readP95Ms: safeSummary.readP95Ms,
      aborted: safeSummary.aborted,
      instanceQuarantined: safeSummary.instanceQuarantined,
      instanceRetired: safeSummary.instanceRetired,
      passedWithoutQuota: safeSummary.passedWithoutQuota,
      providerCounterBefore: safeInput.providerCounterBefore,
      providerCounterAfter: safeInput.providerCounterAfter,
      providerTokens,
      counterBeforeCapturedAt: safeInput.counterBeforeCapturedAt,
      counterAfterCapturedAt: safeInput.counterAfterCapturedAt,
      isolatedAccount: true,
      passed: safeSummary.passedWithoutQuota && providerTokens <= 10_000,
    };
  } catch {
    throw evidenceError();
  }
}

async function executeFinalizer(): Promise<number> {
  try {
    const inputPath = process.argv[2];
    if (inputPath === undefined) throw evidenceError();
    const [summarySource, inputSource] = await Promise.all([
      readFile(XMEMORY_PILOT_SUMMARY_PATH, "utf8"),
      readFile(inputPath, "utf8"),
    ]);
    const evidence = finalizeXmemoryPilot(
      JSON.parse(summarySource) as XmemoryPilotSummary,
      JSON.parse(inputSource) as XmemoryPilotCounterInput,
    );
    process.stdout.write(`${serializeXmemoryPilotSummary(evidence)}\n`);
    return evidence.passed ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ passed: false, errorCode: "invalid_input" })}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await executeFinalizer();
