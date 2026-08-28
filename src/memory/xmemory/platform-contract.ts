export const XMEMORY_API_BASE_URL = "https://api.xmemory.ai";

export type XmemoryReadMode = "single-answer" | "raw-tables";

export type XmemoryChangeSet = {
  created: { objects: unknown[]; relations: unknown[] };
  updated: { objects: unknown[]; relations: unknown[] };
  deleted: { objects: unknown[]; relations: unknown[] };
};

export type XmemoryRawTablesResult = {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
};

export type XmemoryPilotExperienceRow = { sourceAttemptId: string };

export const XMEMORY_INSIGHT_KINDS = [
  "positive_evidence",
  "negative_evidence",
  "comparison",
  "caveat",
  "procedure",
] as const;

export type XmemoryInsightKind = (typeof XMEMORY_INSIGHT_KINDS)[number];

export type XmemoryPilotInsightRow = {
  sourceAttemptId: string;
  statement: string;
  kind: XmemoryInsightKind;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeChangeGroup(value: unknown): { objects: unknown[]; relations: unknown[] } {
  if (!isRecord(value) || !hasExactKeys(value, ["objects", "relations"])) {
    throw new TypeError("invalid xmemory change group");
  }
  if (!Array.isArray(value.objects) || !Array.isArray(value.relations)) {
    throw new TypeError("invalid xmemory change group");
  }
  return { objects: [...value.objects], relations: [...value.relations] };
}

export function decodeXmemoryChanges(value: unknown): XmemoryChangeSet {
  if (!isRecord(value) || !hasExactKeys(value, ["created", "updated", "deleted"])) {
    throw new TypeError("invalid xmemory changes");
  }
  return {
    created: decodeChangeGroup(value.created),
    updated: decodeChangeGroup(value.updated),
    deleted: decodeChangeGroup(value.deleted),
  };
}

export function decodeXmemoryRawTables(value: unknown): XmemoryRawTablesResult | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["columns", "rows"])) {
    throw new TypeError("invalid xmemory raw-tables result");
  }
  if (!Array.isArray(value.columns) || !Array.isArray(value.rows)) {
    throw new TypeError("invalid xmemory raw-tables result");
  }

  const columns = value.columns.map((column) => {
    if (
      !isRecord(column) ||
      !hasExactKeys(column, ["name", "type"]) ||
      typeof column.name !== "string" ||
      typeof column.type !== "string"
    ) {
      throw new TypeError("invalid xmemory raw-tables column");
    }
    return { name: column.name, type: column.type };
  });
  const rows = value.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new TypeError("invalid xmemory raw-tables row");
    }
    return [...row];
  });
  return { columns, rows };
}

function requireColumns(
  result: XmemoryRawTablesResult | null,
  expected: readonly string[],
): XmemoryRawTablesResult | null {
  if (result === null) return null;
  if (
    result.columns.length !== expected.length ||
    !result.columns.every((column, index) => column.name === expected[index])
  ) {
    throw new TypeError("unexpected xmemory pilot columns");
  }
  return result;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function decodePilotExperienceRows(value: unknown): XmemoryPilotExperienceRow[] {
  const result = requireColumns(decodeXmemoryRawTables(value), ["source_attempt_id"]);
  if (result === null) return [];
  return result.rows.map((row) => {
    const sourceAttemptId = row[0];
    if (!nonEmptyString(sourceAttemptId)) throw new TypeError("invalid pilot experience row");
    return { sourceAttemptId };
  });
}

export function decodePilotInsightRows(value: unknown): XmemoryPilotInsightRow[] {
  const result = requireColumns(decodeXmemoryRawTables(value), [
    "source_attempt_id",
    "insight_statement",
    "insight_kind",
  ]);
  if (result === null) return [];
  return result.rows.map((row) => {
    const sourceAttemptId = row[0];
    const statement = row[1];
    const kind = row[2];
    if (
      !nonEmptyString(sourceAttemptId) ||
      !nonEmptyString(statement) ||
      typeof kind !== "string" ||
      !(XMEMORY_INSIGHT_KINDS as readonly string[]).includes(kind)
    ) {
      throw new TypeError("invalid pilot insight row");
    }
    return { sourceAttemptId, statement, kind: kind as XmemoryInsightKind };
  });
}

export type XmemoryWriteRequest = {
  text: string;
  extractionLogic: "deep";
  diffEngine: true;
  timeoutMs: number;
};

export type XmemoryReadRequest = {
  query: string;
  readMode: XmemoryReadMode;
  traceId: string;
  timeoutMs: number;
};

export interface XmemoryPlatformPort {
  getSchema(timeoutMs: number): Promise<Record<string, unknown>>;
  write(request: XmemoryWriteRequest): Promise<{
    writeId: string;
    traceId: string | null;
    changes: XmemoryChangeSet;
  }>;
  read(request: XmemoryReadRequest): Promise<{
    traceId: string | null;
    readerResult: unknown;
  }>;
}

export interface XmemoryAdminPort {
  getCluster(clusterId: string, timeoutMs: number): Promise<{ id: string }>;
  listInstances(timeoutMs: number): Promise<Array<{ id: string; name: string }>>;
  createInstance(request: {
    clusterId: string;
    name: string;
    description: string;
    schemaYml: string;
    timeoutMs: number;
  }): Promise<{ id: string }>;
  getSchema(instanceId: string, timeoutMs: number): Promise<Record<string, unknown>>;
}
