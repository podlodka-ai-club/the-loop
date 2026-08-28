import assert from "node:assert/strict";
import test from "node:test";
import { XmemoryMemoryError, type XmemoryMemoryErrorCode } from "./error.ts";
import {
  createXmemoryAdminPortInternal,
  createXmemoryPlatformPortInternal,
  normalizeXmemoryProviderError,
  type XmemoryPlatformDependencies,
  type XmemorySdkAdmin,
  type XmemorySdkClient,
  type XmemorySdkInstance,
} from "./platform-internal.ts";
import {
  XMEMORY_API_BASE_URL,
  decodePilotExperienceRows,
  decodePilotInsightRows,
  decodeXmemoryChanges,
  decodeXmemoryRawTables,
  type XmemoryChangeSet,
} from "./platform.ts";

const changes: XmemoryChangeSet = {
  created: { objects: [{ type: "TrainingExperience" }], relations: [] },
  updated: { objects: [], relations: [] },
  deleted: { objects: [], relations: [] },
};

function unexpected(name: string): never {
  throw new Error(`unexpected ${name} call`);
}

function instance(overrides: Partial<XmemorySdkInstance> = {}): XmemorySdkInstance {
  return {
    id: "instance-test",
    getSchema: async () => unexpected("getSchema"),
    write: async () => unexpected("write"),
    read: async () => unexpected("read"),
    ...overrides,
  };
}

function admin(overrides: Partial<XmemorySdkAdmin> = {}): XmemorySdkAdmin {
  return {
    getCluster: async () => unexpected("getCluster"),
    listInstances: async () => unexpected("listInstances"),
    createInstance: async () => unexpected("createInstance"),
    getInstanceSchema: async () => unexpected("getInstanceSchema"),
    ...overrides,
  };
}

function dependencies(
  sdkInstance: XmemorySdkInstance,
  sdkAdmin: XmemorySdkAdmin = admin(),
  observer?: (apiKey: string, baseUrl: string) => void,
): XmemoryPlatformDependencies {
  const sdkClient: XmemorySdkClient = { admin: sdkAdmin, instance: () => sdkInstance };
  return {
    createClient: (apiKey, baseUrl) => {
      observer?.(apiKey, baseUrl);
      return sdkClient;
    },
  };
}

function platform(sdkInstance: XmemorySdkInstance) {
  return createXmemoryPlatformPortInternal(
    { apiKey: "test-api-key", instanceId: "test-instance" },
    dependencies(sdkInstance),
    XMEMORY_API_BASE_URL,
  );
}

async function rejectsCode(
  promise: Promise<unknown>,
  code: XmemoryMemoryErrorCode,
  retryable = false,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes("provider-secret"), false);
    return true;
  });
}

test("data port pins the hosted URL and forwards exact SDK envelopes", async () => {
  const calls: unknown[] = [];
  let clientConfig: unknown;
  const sdkInstance = instance({
    getSchema: async (options) => {
      calls.push(["schema", options]);
      return { data_schema: { xmd_version: "v1" } };
    },
    write: async (text, options) => {
      calls.push(["write", text, options]);
      return { write_id: "write-1", trace_id: "trace-1", changes, console_url: "sensitive" };
    },
    read: async (query, options) => {
      calls.push(["read", query, options]);
      return { trace_id: null, reader_result: { answer: "grounded" }, console_url: "sensitive" };
    },
  });
  const port = createXmemoryPlatformPortInternal(
    { apiKey: " key ", instanceId: " instance " },
    dependencies(sdkInstance, admin(), (apiKey, baseUrl) => {
      clientConfig = { apiKey, baseUrl };
    }),
    XMEMORY_API_BASE_URL,
  );

  assert.deepEqual(clientConfig, { apiKey: "key", baseUrl: XMEMORY_API_BASE_URL });
  assert.deepEqual(await port.getSchema(10), { xmd_version: "v1" });
  assert.deepEqual(
    await port.write({ text: "lesson", extractionLogic: "deep", diffEngine: true, timeoutMs: 20 }),
    { writeId: "write-1", traceId: "trace-1", changes },
  );
  assert.deepEqual(
    await port.read({ query: "query", readMode: "single-answer", traceId: "trace-2", timeoutMs: 30 }),
    { traceId: null, readerResult: { answer: "grounded" } },
  );
  assert.deepEqual(calls, [
    ["schema", { timeoutMs: 10 }],
    ["write", "lesson", { extractionLogic: "deep", diffEngine: true, timeoutMs: 20 }],
    ["read", "query", { readMode: "single-answer", traceId: "trace-2", timeoutMs: 30 }],
  ]);
});

test("admin port forwards exact SDK calls and returns normalized identifiers", async () => {
  const calls: unknown[] = [];
  const sdkAdmin = admin({
    getCluster: async (clusterId, options) => {
      calls.push(["cluster", clusterId, options]);
      return { id: clusterId, ignored: "provider" };
    },
    listInstances: async (options) => {
      calls.push(["list", options]);
      return [{ id: "one", name: "first", data_schema: {} }];
    },
    createInstance: async (clusterId, name, schemaYml, schemaType, options) => {
      calls.push(["create", clusterId, name, schemaYml, schemaType, options]);
      return { id: "created" };
    },
    getInstanceSchema: async (instanceId, options) => {
      calls.push(["schema", instanceId, options]);
      return { data_schema: { title: "schema" } };
    },
  });
  const port = createXmemoryAdminPortInternal(
    { adminApiKey: "admin-key" },
    dependencies(instance(), sdkAdmin),
    XMEMORY_API_BASE_URL,
  );

  assert.deepEqual(await port.getCluster("cluster", 60_000), { id: "cluster" });
  assert.deepEqual(await port.listInstances(60_000), [{ id: "one", name: "first" }]);
  assert.deepEqual(
    await port.createInstance({
      clusterId: "cluster",
      name: "pilot",
      description: "Disposable Loci xmemory pilot",
      schemaYml: "xmd_version: v1\n",
      timeoutMs: 60_000,
    }),
    { id: "created" },
  );
  assert.deepEqual(await port.getSchema("created", 60_000), { title: "schema" });
  assert.deepEqual(calls, [
    ["cluster", "cluster", { timeoutMs: 60_000 }],
    ["list", { timeoutMs: 60_000 }],
    [
      "create",
      "cluster",
      "pilot",
      "xmd_version: v1\n",
      0,
      { description: "Disposable Loci xmemory pilot", timeoutMs: 60_000 },
    ],
    ["schema", "created", { timeoutMs: 60_000 }],
  ]);
});

test("change decoder requires the exact three-by-two containers", () => {
  assert.deepEqual(decodeXmemoryChanges(changes), changes);
  const malformed: unknown[] = [
    null,
    {},
    { ...changes, extra: [] },
    { created: {}, updated: changes.updated, deleted: changes.deleted },
    { ...changes, created: { objects: [], relations: [], extra: [] } },
    { ...changes, created: { objects: null, relations: [] } },
  ];
  for (const value of malformed) assert.throws(() => decodeXmemoryChanges(value), TypeError);
});

test("raw table and provenance decoders enforce exact columns, rows and kinds", () => {
  assert.equal(decodeXmemoryRawTables(null), null);
  assert.deepEqual(
    decodePilotExperienceRows({
      columns: [{ name: "source_attempt_id", type: "str" }],
      rows: [["attempt-1"], ["attempt-2"]],
    }),
    [{ sourceAttemptId: "attempt-1" }, { sourceAttemptId: "attempt-2" }],
  );
  assert.deepEqual(
    decodePilotInsightRows({
      columns: [
        { name: "source_attempt_id", type: "str" },
        { name: "insight_statement", type: "str" },
        { name: "insight_kind", type: "str" },
      ],
      rows: [["attempt-1", "Yellow posts can support Iceland.", "positive_evidence"]],
    }),
    [
      {
        sourceAttemptId: "attempt-1",
        statement: "Yellow posts can support Iceland.",
        kind: "positive_evidence",
      },
    ],
  );

  const malformed: unknown[] = [
    {},
    { columns: [], rows: [], extra: true },
    { columns: [{ name: "source_attempt_id" }], rows: [] },
    { columns: [{ name: "source_attempt_id", type: "str", extra: true }], rows: [] },
    { columns: [{ name: "source_attempt_id", type: "str" }], rows: [[]] },
  ];
  for (const value of malformed) assert.throws(() => decodeXmemoryRawTables(value), TypeError);
  assert.throws(
    () =>
      decodePilotInsightRows({
        columns: [
          { name: "source_attempt_id", type: "str" },
          { name: "insight_statement", type: "str" },
          { name: "insight_kind", type: "str" },
        ],
        rows: [["attempt-1", "statement", "unsupported"]],
      }),
    TypeError,
  );
});

test("provider code/status matrix is normalized without retaining raw failures", () => {
  const cases: Array<{
    error: unknown;
    code: XmemoryMemoryErrorCode;
    retryable?: boolean;
  }> = [
    { error: { code: "UNAUTHORIZED", status: 401, message: "provider-secret" }, code: "authentication" },
    { error: { code: "FORBIDDEN", status: 403 }, code: "authorization" },
    { error: { code: "QUOTA_EXCEEDED", status: 402 }, code: "quota_exceeded" },
    { error: { code: "RATE_LIMITED", status: 429 }, code: "rate_limited", retryable: true },
    { error: { code: "NOT_FOUND", status: 404 }, code: "instance_not_found" },
    { error: { status: 400 }, code: "invalid_input" },
    { error: { status: 409 }, code: "invalid_input" },
    { error: { status: 422 }, code: "invalid_input" },
    { error: { status: 500 }, code: "unavailable", retryable: true },
    { error: { code: "UNKNOWN", status: 429 }, code: "rate_limited", retryable: true },
    { error: { code: "UNAUTHORIZED", status: 403 }, code: "protocol_error" },
    { error: { status: 418 }, code: "protocol_error" },
    { error: new Error("provider-secret"), code: "protocol_error" },
    { error: new TypeError("provider-secret"), code: "unavailable", retryable: true },
    { error: { name: "AbortError" }, code: "unavailable", retryable: true },
  ];

  for (const item of cases) {
    const normalized = normalizeXmemoryProviderError(item.error, "read");
    assert.equal(normalized.code, item.code);
    assert.equal(normalized.retryable, item.retryable ?? false);
    assert.equal(normalized.operation, "read");
    assert.equal(normalized.message.includes("provider-secret"), false);
    assert.equal("cause" in normalized, false);
  }
});

test("state-changing ambiguity differs from read/schema/provision preflight", () => {
  for (const error of [new TypeError("network"), { status: 408 }, { status: 503 }]) {
    assert.equal(normalizeXmemoryProviderError(error, "write", "write").code, "write_outcome_unknown");
    assert.equal(
      normalizeXmemoryProviderError(error, "provision", "create").code,
      "provision_outcome_unknown",
    );
    assert.equal(normalizeXmemoryProviderError(error, "schema").code, "unavailable");
    assert.equal(normalizeXmemoryProviderError(error, "provision").code, "unavailable");
  }
  assert.equal(
    normalizeXmemoryProviderError({ status: 400 }, "write", "write").code,
    "invalid_input",
  );
  assert.equal(
    normalizeXmemoryProviderError({ code: "RATE_LIMITED", status: 429 }, "write", "write").code,
    "rate_limited",
  );
});

test("malformed SDK success envelopes are normalized by operation", async () => {
  await rejectsCode(
    platform(instance({ getSchema: async () => ({ schema: {} }) })).getSchema(1),
    "protocol_error",
  );
  await rejectsCode(
    platform(instance({ write: async () => ({ write_id: "", trace_id: null, changes }) })).write({
      text: "lesson",
      extractionLogic: "deep",
      diffEngine: true,
      timeoutMs: 1,
    }),
    "write_outcome_unknown",
  );
  await rejectsCode(
    platform(instance({ read: async () => ({ trace_id: 12, reader_result: null }) })).read({
      query: "query",
      readMode: "raw-tables",
      traceId: "trace",
      timeoutMs: 1,
    }),
    "protocol_error",
  );
});
