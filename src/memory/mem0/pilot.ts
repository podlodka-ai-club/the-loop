import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Hint, LessonInput } from "../../memory.ts";
import { mem0IntegrationEnabled } from "./integration.ts";
import {
  Mem0MemoryError,
  createMem0Memory,
  loadMem0MemoryConfig,
  type Mem0MemoryConfig,
  type Mem0RememberResult,
} from "./memory.ts";
import { createMem0PlatformPort, type Mem0PlatformPort } from "./platform.ts";

export const MEM0_PILOT_LESSONS_PATH = "benchmark/samples/mem0-pilot-v1-lessons.jsonl";
export const MEM0_PILOT_QUERIES_PATH = "benchmark/samples/mem0-pilot-v1-queries.jsonl";

export type Mem0PilotLessonCase = {
  caseId: string;
  lesson: LessonInput;
  expectedAnyFact: Array<{ allOf: string[] }>;
  forbiddenFactSubstrings: string[];
};

export type Mem0PilotQueryCase = {
  caseId: string;
  features: string[];
  expectedSourceAttemptIds: string[];
};

export type Mem0PilotManifests = {
  lessons: Mem0PilotLessonCase[];
  queries: Mem0PilotQueryCase[];
};

export type Mem0PilotSummary = {
  lessonCases: number;
  lessonsWithCorrectFact: number;
  extractedFacts: number;
  distortedFacts: number;
  queryCases: number;
  queriesWithExpectedFactInTop5: number;
  writeFailures: number;
  recallFailures: number;
  harnessFailures: number;
  aborted: boolean;
  instanceQuarantined: boolean;
  scopeRetired: boolean;
  passed: boolean;
};

export type Mem0PilotMemory = {
  remember(lesson: LessonInput): Promise<void>;
  recall(features: string[], limit: number): Promise<Hint[]>;
};

export type Mem0PilotMemoryFactory = (
  config: Mem0MemoryConfig,
  platform: Mem0PlatformPort,
  onRememberCompleted: (result: Mem0RememberResult) => void,
) => Mem0PilotMemory;

export class Mem0PilotManifestError extends Error {
  constructor() {
    super("Mem0 pilot manifests are invalid");
    this.name = "Mem0PilotManifestError";
  }
}

class Mem0PilotObserverError extends Error {}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.slice().sort().every((key, i) => actual[i] === key);
}

function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      throw new Mem0PilotManifestError();
    }
  }
  return values;
}

function parseLessonCase(value: unknown): Mem0PilotLessonCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["caseId", "lesson", "expectedAnyFact", "forbiddenFactSubstrings"]) ||
    !nonEmptyString(value.caseId) ||
    !isRecord(value.lesson) ||
    !exactKeys(value.lesson, ["content", "sourceAttemptId", "triggers", "region"]) ||
    !nonEmptyString(value.lesson.content) ||
    !nonEmptyString(value.lesson.sourceAttemptId) ||
    !Array.isArray(value.lesson.triggers) ||
    value.lesson.triggers.some((trigger) => typeof trigger !== "string") ||
    typeof value.lesson.region !== "string" ||
    !Array.isArray(value.expectedAnyFact) ||
    value.expectedAnyFact.length === 0 ||
    !Array.isArray(value.forbiddenFactSubstrings) ||
    value.forbiddenFactSubstrings.some((substring) => !nonEmptyString(substring))
  ) {
    throw new Mem0PilotManifestError();
  }

  const expectedAnyFact = value.expectedAnyFact.map((signal) => {
    if (
      !isRecord(signal) ||
      !exactKeys(signal, ["allOf"]) ||
      !Array.isArray(signal.allOf) ||
      signal.allOf.length === 0 ||
      signal.allOf.some((substring) => !nonEmptyString(substring))
    ) {
      throw new Mem0PilotManifestError();
    }
    return { allOf: [...signal.allOf] as string[] };
  });

  return {
    caseId: value.caseId,
    lesson: {
      content: value.lesson.content,
      sourceAttemptId: value.lesson.sourceAttemptId,
      triggers: [...value.lesson.triggers] as string[],
      region: value.lesson.region,
    },
    expectedAnyFact,
    forbiddenFactSubstrings: [...value.forbiddenFactSubstrings] as string[],
  };
}

function parseQueryCase(value: unknown): Mem0PilotQueryCase {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["caseId", "features", "expectedSourceAttemptIds"]) ||
    !nonEmptyString(value.caseId) ||
    !Array.isArray(value.features) ||
    value.features.length === 0 ||
    value.features.some((feature) => !nonEmptyString(feature)) ||
    !Array.isArray(value.expectedSourceAttemptIds) ||
    value.expectedSourceAttemptIds.length === 0 ||
    value.expectedSourceAttemptIds.some((id) => !nonEmptyString(id)) ||
    new Set(value.expectedSourceAttemptIds).size !== value.expectedSourceAttemptIds.length
  ) {
    throw new Mem0PilotManifestError();
  }
  return {
    caseId: value.caseId,
    features: [...value.features] as string[],
    expectedSourceAttemptIds: [...value.expectedSourceAttemptIds] as string[],
  };
}

function assertThirtyUnique(values: readonly { caseId: string }[]): void {
  if (values.length !== 30 || new Set(values.map((value) => value.caseId)).size !== 30) {
    throw new Mem0PilotManifestError();
  }
}

export function validateMem0PilotManifests(
  lessonValues: readonly unknown[],
  queryValues: readonly unknown[],
): Mem0PilotManifests {
  let lessons: Mem0PilotLessonCase[] | undefined;
  let queries: Mem0PilotQueryCase[] | undefined;
  let invalid = false;
  try {
    lessons = lessonValues.map(parseLessonCase);
    assertThirtyUnique(lessons);
    if (new Set(lessons.map((entry) => entry.lesson.sourceAttemptId)).size !== 30) invalid = true;
  } catch {
    invalid = true;
  }
  try {
    queries = queryValues.map(parseQueryCase);
    assertThirtyUnique(queries);
  } catch {
    invalid = true;
  }
  if (invalid || lessons === undefined || queries === undefined) throw new Mem0PilotManifestError();

  const lessonCaseIds = new Set(lessons.map((entry) => entry.caseId));
  const sourceIds = new Set(lessons.map((entry) => entry.lesson.sourceAttemptId));
  if (
    queries.some(
      (entry) =>
        !lessonCaseIds.has(entry.caseId) ||
        entry.expectedSourceAttemptIds.some((id) => !sourceIds.has(id)),
    )
  ) {
    throw new Mem0PilotManifestError();
  }
  return { lessons, queries };
}

export async function loadMem0PilotManifests(
  lessonsPath = MEM0_PILOT_LESSONS_PATH,
  queriesPath = MEM0_PILOT_QUERIES_PATH,
): Promise<Mem0PilotManifests> {
  const reads = await Promise.allSettled([readFile(lessonsPath, "utf8"), readFile(queriesPath, "utf8")]);
  let lessonValues: unknown[] = [];
  let queryValues: unknown[] = [];
  let invalid = false;
  if (reads[0]?.status === "fulfilled") {
    try {
      lessonValues = parseJsonLines(reads[0].value);
    } catch {
      invalid = true;
    }
  } else invalid = true;
  if (reads[1]?.status === "fulfilled") {
    try {
      queryValues = parseJsonLines(reads[1].value);
    } catch {
      invalid = true;
    }
  } else invalid = true;
  if (invalid) throw new Mem0PilotManifestError();
  return validateMem0PilotManifests(lessonValues, queryValues);
}

export function factMatchesExpected(text: string, expected: Mem0PilotLessonCase["expectedAnyFact"]): boolean {
  const normalized = text.toLowerCase();
  return expected.some((signal) =>
    signal.allOf.every((substring) => normalized.includes(substring.toLowerCase())),
  );
}

export function factIsDistorted(text: string, forbidden: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return forbidden.some((substring) => normalized.includes(substring.toLowerCase()));
}

export function emptyMem0PilotSummary(): Mem0PilotSummary {
  return {
    lessonCases: 0,
    lessonsWithCorrectFact: 0,
    extractedFacts: 0,
    distortedFacts: 0,
    queryCases: 0,
    queriesWithExpectedFactInTop5: 0,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 0,
    aborted: false,
    instanceQuarantined: false,
    scopeRetired: false,
    passed: false,
  };
}

function finalizeSummary(summary: Mem0PilotSummary): Mem0PilotSummary {
  summary.passed =
    !summary.aborted &&
    summary.lessonCases === 30 &&
    summary.lessonsWithCorrectFact >= 24 &&
    summary.distortedFacts === 0 &&
    summary.queryCases === 30 &&
    summary.queriesWithExpectedFactInTop5 >= 24 &&
    summary.writeFailures === 0 &&
    summary.recallFailures === 0 &&
    summary.harnessFailures === 0;
  return summary;
}

async function detectQuarantine(memory: Mem0PilotMemory): Promise<boolean> {
  try {
    await memory.recall([], 1);
    return false;
  } catch (error) {
    return error instanceof Mem0MemoryError && error.code === "instance_quarantined";
  }
}

function observerFailure(error: unknown): boolean {
  return (
    error instanceof Mem0PilotObserverError ||
    (error instanceof Mem0MemoryError && error.code === "observer_failed")
  );
}

export async function runMem0Pilot(options: {
  manifests: Mem0PilotManifests;
  config: Mem0MemoryConfig;
  platform: Mem0PlatformPort;
  createMemory: Mem0PilotMemoryFactory;
}): Promise<Mem0PilotSummary> {
  const manifests = validateMem0PilotManifests(
    options.manifests.lessons,
    options.manifests.queries,
  );
  const summary = emptyMem0PilotSummary();
  let existing;
  try {
    existing = await options.platform.list(options.config.agentId);
  } catch {
    summary.harnessFailures = 1;
    summary.aborted = true;
    return finalizeSummary(summary);
  }
  if (!Array.isArray(existing) || existing.length !== 0) {
    summary.harnessFailures = 1;
    summary.aborted = true;
    return finalizeSummary(summary);
  }
  summary.scopeRetired = true;

  let activeSourceAttemptId: string | undefined;
  let observed: Mem0RememberResult | undefined;
  let observerCalls = 0;
  const onRememberCompleted = (result: Mem0RememberResult): void => {
    if (
      activeSourceAttemptId === undefined ||
      observerCalls !== 0 ||
      result.sourceAttemptId !== activeSourceAttemptId
    ) {
      throw new Mem0PilotObserverError();
    }
    observerCalls += 1;
    observed = { sourceAttemptId: result.sourceAttemptId, memoryIds: [...result.memoryIds] };
  };

  let memory: Mem0PilotMemory;
  try {
    memory = options.createMemory(options.config, options.platform, onRememberCompleted);
  } catch {
    summary.harnessFailures = 1;
    summary.aborted = true;
    return finalizeSummary(summary);
  }

  for (const lessonCase of manifests.lessons) {
    summary.lessonCases += 1;
    activeSourceAttemptId = lessonCase.lesson.sourceAttemptId;
    observed = undefined;
    observerCalls = 0;
    try {
      await memory.remember(lessonCase.lesson);
      if (observerCalls !== 1 || observed === undefined) throw new Mem0PilotObserverError();
    } catch (error) {
      if (observerFailure(error)) summary.harnessFailures += 1;
      else summary.writeFailures += 1;
      summary.aborted = true;
      summary.instanceQuarantined = await detectQuarantine(memory);
      return finalizeSummary(summary);
    } finally {
      activeSourceAttemptId = undefined;
    }

    const completion = observed as unknown as Mem0RememberResult;
    const facts: string[] = [];
    try {
      for (const memoryId of completion.memoryIds) {
        const record = await options.platform.get(memoryId);
        if (
          record === null ||
          record.id !== memoryId ||
          record.metadata.loci_source_attempt_id !== lessonCase.lesson.sourceAttemptId
        ) {
          throw new Mem0PilotObserverError();
        }
        facts.push(record.memory);
      }
    } catch {
      summary.harnessFailures += 1;
      summary.aborted = true;
      return finalizeSummary(summary);
    }
    summary.extractedFacts += facts.length;
    if (facts.some((fact) => factMatchesExpected(fact, lessonCase.expectedAnyFact))) {
      summary.lessonsWithCorrectFact += 1;
    }
    summary.distortedFacts += facts.filter((fact) =>
      factIsDistorted(fact, lessonCase.forbiddenFactSubstrings),
    ).length;
  }

  for (const queryCase of manifests.queries) {
    summary.queryCases += 1;
    try {
      const hints = await memory.recall(queryCase.features, 5);
      const sourceAttemptIds: string[] = [];
      for (const hint of hints) {
        const record = await options.platform.get(hint.lessonId);
        const sourceAttemptId = record?.metadata.loci_source_attempt_id;
        if (record === null || record.id !== hint.lessonId || !nonEmptyString(sourceAttemptId)) {
          throw new Error("provenance unavailable");
        }
        sourceAttemptIds.push(sourceAttemptId);
      }
      if (queryCase.expectedSourceAttemptIds.some((id) => sourceAttemptIds.includes(id))) {
        summary.queriesWithExpectedFactInTop5 += 1;
      }
    } catch {
      summary.recallFailures += 1;
    }
  }
  return finalizeSummary(summary);
}

type ExecuteMem0PilotOptions = {
  env?: NodeJS.ProcessEnv;
  lessonsPath?: string;
  queriesPath?: string;
  createPlatform?: (config: Mem0MemoryConfig) => Mem0PlatformPort;
  createMemory?: Mem0PilotMemoryFactory;
  printSummary?: (line: string) => void;
  printError?: (line: string) => void;
};

export async function executeMem0Pilot(options: ExecuteMem0PilotOptions = {}): Promise<number> {
  const printSummary = options.printSummary ?? console.log;
  const printError = options.printError ?? console.error;
  let manifests: Mem0PilotManifests;
  try {
    manifests = await loadMem0PilotManifests(options.lessonsPath, options.queriesPath);
  } catch {
    printError("Mem0 pilot manifests are invalid");
    return 1;
  }

  const env = options.env ?? process.env;
  if (!mem0IntegrationEnabled(env)) {
    const summary = emptyMem0PilotSummary();
    summary.harnessFailures = 1;
    summary.aborted = true;
    printSummary(JSON.stringify(finalizeSummary(summary)));
    return 1;
  }

  let config: Mem0MemoryConfig;
  try {
    config = loadMem0MemoryConfig(env);
  } catch {
    const summary = emptyMem0PilotSummary();
    summary.harnessFailures = 1;
    summary.aborted = true;
    printSummary(JSON.stringify(finalizeSummary(summary)));
    return 1;
  }

  let platform: Mem0PlatformPort;
  try {
    platform = (options.createPlatform ?? ((value) => createMem0PlatformPort({ apiKey: value.apiKey })))(
      config,
    );
  } catch {
    const summary = emptyMem0PilotSummary();
    summary.harnessFailures = 1;
    summary.aborted = true;
    printSummary(JSON.stringify(finalizeSummary(summary)));
    return 1;
  }

  const createMemory =
    options.createMemory ??
    ((value, sharedPlatform, observer) =>
      createMem0Memory({ snapshots: false }, value, {
        platform: sharedPlatform,
        onRememberCompleted: observer,
      }));
  let summary: Mem0PilotSummary;
  try {
    summary = await runMem0Pilot({ manifests, config, platform, createMemory });
  } catch {
    summary = emptyMem0PilotSummary();
    summary.harnessFailures = 1;
    summary.aborted = true;
  }
  printSummary(JSON.stringify(summary));
  return summary.passed ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await executeMem0Pilot();
}
