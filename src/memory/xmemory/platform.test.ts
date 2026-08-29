import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  XmemoryMemoryError,
  type XmemoryMemoryErrorCode,
  type XmemoryOperation,
} from "./error.ts";
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
  decodePilotExperienceRows,
  decodePilotInsightRows,
  decodeXmemoryChanges,
  decodeXmemoryRawTables,
  XMEMORY_API_BASE_URL,
  type XmemoryChangeSet,
} from "./platform-contract.ts";

const changes: XmemoryChangeSet = {
  created: { objects: [{ type: "TrainingExperience" }], relations: [] },
  updated: { objects: [], relations: [] },
  deleted: { objects: [], relations: [] },
};

const providerChangesWithKeyless = {
  ...changes,
  created_keyless_objects: [{ type: "Insight" }],
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

function adminPlatform(sdkAdmin: XmemorySdkAdmin) {
  return createXmemoryAdminPortInternal(
    { adminApiKey: "test-admin-key" },
    dependencies(instance(), sdkAdmin),
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
    assertSanitized(error);
    return true;
  });
}

test("platform contract stays dependency-free and the SDK adapter has no facade cycle", async () => {
  const [contractSource, adapterSource] = await Promise.all([
    readFile("src/memory/xmemory/platform-contract.ts", "utf8"),
    readFile("src/memory/xmemory/platform-internal.ts", "utf8"),
  ]);
  assert.equal(/^import\s/m.test(contractSource), false);
  assert.equal(adapterSource.includes('from "./platform-contract.ts"'), true);
  assert.equal(adapterSource.includes('from "./platform.ts"'), false);
});

function assertSanitized(error: XmemoryMemoryError): void {
  const visible = [
    error.message,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(Object.fromEntries(Object.entries(error))),
  ];
  for (const representation of visible) {
    assert.equal(representation.includes("provider-secret"), false);
    assert.equal(representation.includes("provider-body"), false);
    assert.equal(representation.includes("console.invalid"), false);
  }
  assert.equal("cause" in error, false);
}

async function rejectsHostileReason(
  promise: Promise<unknown>,
  expected: {
    code: XmemoryMemoryErrorCode;
    operation: XmemoryOperation;
    message: string;
  },
  original: unknown,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.notEqual(error, original);
    assert.equal(error.code, expected.code);
    assert.equal(error.operation, expected.operation);
    assert.equal(error.retryable, false);
    assert.equal(error.message, expected.message);
    assertSanitized(error);
    for (const visible of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
      assert.equal(visible.includes("hostile-descriptor"), false);
      assert.equal(visible.includes("revoked"), false);
    }
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
      return {
        write_id: "write-1",
        trace_id: "trace-1",
        changes: providerChangesWithKeyless,
        console_url: "sensitive",
      };
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
    {
      writeId: "write-1",
      traceId: "trace-1",
      changes: {
        ...changes,
        created: {
          objects: [...changes.created.objects, { type: "Insight" }],
          relations: [],
        },
      },
    },
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

test("change decoder normalizes keyless creates and requires exact provider containers", () => {
  assert.deepEqual(decodeXmemoryChanges(changes), changes);
  assert.deepEqual(decodeXmemoryChanges(providerChangesWithKeyless), {
    ...changes,
    created: {
      objects: [...changes.created.objects, { type: "Insight" }],
      relations: [],
    },
  });
  const malformed: unknown[] = [
    null,
    {},
    { ...changes, extra: [] },
    { created: {}, updated: changes.updated, deleted: changes.deleted },
    { ...changes, created: { objects: [], relations: [], extra: [] } },
    { ...changes, created: { objects: null, relations: [] } },
    { ...changes, created_keyless_objects: null },
    { ...providerChangesWithKeyless, extra: [] },
  ];
  for (const value of malformed) assert.throws(() => decodeXmemoryChanges(value), TypeError);
});

test("raw table and provenance decoders enforce exact columns, rows and kinds", () => {
  assert.equal(decodeXmemoryRawTables(null), null);
  assert.deepEqual(decodePilotExperienceRows(null), []);
  assert.deepEqual(decodePilotInsightRows(null), []);
  assert.deepEqual(
    decodePilotExperienceRows({
      columns: [{ name: "source_attempt_id", type: "str" }],
      rows: [["attempt-1"], ["attempt-2"]],
    }),
    [{ sourceAttemptId: "attempt-1" }, { sourceAttemptId: "attempt-2" }],
  );
  const insightKinds = [
    "positive_evidence",
    "negative_evidence",
    "comparison",
    "caveat",
    "procedure",
  ] as const;
  const insightRows = insightKinds.map((kind, index) => [
    `attempt-${index}`,
    `Grounded statement ${index}`,
    kind,
  ]);
  assert.deepEqual(
    decodePilotInsightRows({
      columns: [
        { name: "source_attempt_id", type: "str" },
        { name: "insight_statement", type: "str" },
        { name: "insight_kind", type: "str" },
      ],
      rows: insightRows,
    }),
    insightKinds.map((kind, index) => ({
      sourceAttemptId: `attempt-${index}`,
      statement: `Grounded statement ${index}`,
      kind,
    })),
  );

  const malformed: unknown[] = [
    {},
    { columns: [], rows: [], extra: true },
    { columns: [{ name: "source_attempt_id" }], rows: [] },
    { columns: [{ name: "source_attempt_id", type: "str", extra: true }], rows: [] },
    { columns: [{ name: "source_attempt_id", type: "str" }], rows: [[]] },
  ];
  for (const value of malformed) assert.throws(() => decodeXmemoryRawTables(value), TypeError);
  for (const value of [
    {
      columns: [{ name: "wrong", type: "str" }],
      rows: [["attempt-1"]],
    },
    {
      columns: [{ name: "source_attempt_id", type: "str" }],
      rows: [[""]],
    },
  ]) {
    assert.throws(() => decodePilotExperienceRows(value), TypeError);
  }
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

type ErrorContext = {
  operation: XmemoryOperation;
  stateChanging: "none" | "write" | "create";
  protocolCode: XmemoryMemoryErrorCode;
  unavailableCode: XmemoryMemoryErrorCode;
};

const errorContexts: readonly ErrorContext[] = [
  {
    operation: "read",
    stateChanging: "none",
    protocolCode: "protocol_error",
    unavailableCode: "unavailable",
  },
  {
    operation: "schema",
    stateChanging: "none",
    protocolCode: "protocol_error",
    unavailableCode: "unavailable",
  },
  {
    operation: "provision",
    stateChanging: "none",
    protocolCode: "protocol_error",
    unavailableCode: "unavailable",
  },
  {
    operation: "write",
    stateChanging: "write",
    protocolCode: "write_outcome_unknown",
    unavailableCode: "write_outcome_unknown",
  },
  {
    operation: "provision",
    stateChanging: "create",
    protocolCode: "provision_outcome_unknown",
    unavailableCode: "provision_outcome_unknown",
  },
];

function assertNormalized(
  input: unknown,
  context: ErrorContext,
  expectedCode: XmemoryMemoryErrorCode,
): void {
  const normalized = normalizeXmemoryProviderError(
    input,
    context.operation,
    context.stateChanging,
  );
  assert.equal(normalized.code, expectedCode);
  assert.equal(normalized.operation, context.operation);
  assert.equal(
    normalized.retryable,
    context.operation === "read" &&
      (expectedCode === "rate_limited" || expectedCode === "unavailable"),
  );
  assertSanitized(normalized);
}

test("every recognized provider code accepts absent or compatible status in every operation", () => {
  const recognized = [
    { providerCode: "UNAUTHORIZED", status: 401, expectedCode: "authentication" },
    { providerCode: "FORBIDDEN", status: 403, expectedCode: "authorization" },
    { providerCode: "QUOTA_EXCEEDED", status: 402, expectedCode: "quota_exceeded" },
    { providerCode: "RATE_LIMITED", status: 429, expectedCode: "rate_limited" },
    { providerCode: "NOT_FOUND", status: 404, expectedCode: "instance_not_found" },
  ] as const;

  for (const item of recognized) {
    for (const status of [undefined, item.status]) {
      for (const context of errorContexts) {
        assertNormalized(
          {
            code: item.providerCode,
            ...(status === undefined ? {} : { status }),
            message: "provider-secret provider-body https://console.invalid",
          },
          context,
          item.expectedCode,
        );
      }
    }
  }
});

test("every conflicting recognized code/status pair fails closed by operation", () => {
  const recognized = [
    { providerCode: "UNAUTHORIZED", status: 401 },
    { providerCode: "FORBIDDEN", status: 403 },
    { providerCode: "QUOTA_EXCEEDED", status: 402 },
    { providerCode: "RATE_LIMITED", status: 429 },
    { providerCode: "NOT_FOUND", status: 404 },
  ] as const;

  for (const item of recognized) {
    for (const conflictingStatus of [200, 400, 408, 500, ...recognized.map((entry) => entry.status)]) {
      if (conflictingStatus === item.status) continue;
      for (const context of errorContexts) {
        assertNormalized(
          {
            code: item.providerCode,
            status: conflictingStatus,
            message: "provider-secret provider-body https://console.invalid",
          },
          context,
          context.protocolCode,
        );
      }
    }
  }
});

test("present malformed status never behaves like an absent status", () => {
  const malformedStatuses: unknown[] = ["403", 403.5, Number.NaN, null, true, {}, [], 0, 600];
  const providerCodes: ReadonlyArray<string | undefined> = [
    undefined,
    "UNKNOWN_PROVIDER_CODE",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "QUOTA_EXCEEDED",
    "RATE_LIMITED",
    "NOT_FOUND",
  ];

  for (const providerCode of providerCodes) {
    for (const status of malformedStatuses) {
      for (const context of errorContexts) {
        assertNormalized(
          {
            ...(providerCode === undefined ? {} : { code: providerCode }),
            status,
            message: "provider-secret provider-body https://console.invalid",
          },
          context,
          context.protocolCode,
        );
      }
    }
  }
});

test("absent and unknown codes fall back through the complete HTTP status matrix", () => {
  const statuses = [
    { status: 400, expectedCode: "invalid_input" },
    { status: 409, expectedCode: "invalid_input" },
    { status: 422, expectedCode: "invalid_input" },
    { status: 401, expectedCode: "authentication" },
    { status: 402, expectedCode: "quota_exceeded" },
    { status: 403, expectedCode: "authorization" },
    { status: 404, expectedCode: "instance_not_found" },
    { status: 429, expectedCode: "rate_limited" },
  ] as const;

  for (const item of statuses) {
    for (const providerCode of [undefined, "UNKNOWN_PROVIDER_CODE"]) {
      for (const context of errorContexts) {
        assertNormalized(
          {
            ...(providerCode === undefined ? {} : { code: providerCode }),
            status: item.status,
            message: "provider-secret provider-body https://console.invalid",
          },
          context,
          item.expectedCode,
        );
      }
    }
  }
});

test("unknown 4xx, transport, timeout, 5xx and unknown errors preserve state semantics", () => {
  const unavailableErrors: unknown[] = [
    new TypeError("provider-secret provider-body https://console.invalid"),
    { name: "AbortError", message: "provider-secret" },
    { name: "TimeoutError", message: "provider-secret" },
    { code: "ECONNRESET", message: "provider-secret" },
    { code: "ECONNREFUSED", message: "provider-secret" },
    { code: "ENOTFOUND", message: "provider-secret" },
    { code: "EAI_AGAIN", message: "provider-secret" },
    { code: "ETIMEDOUT", message: "provider-secret" },
    { status: 408, message: "provider-secret" },
    { status: 500, message: "provider-secret" },
    { status: 503, message: "provider-secret" },
    { status: 599, message: "provider-secret" },
  ];
  const unknownErrors: unknown[] = [
    new Error("provider-secret provider-body https://console.invalid"),
    "provider-secret provider-body https://console.invalid",
    null,
    {},
    { code: "UNKNOWN_PROVIDER_CODE", message: "provider-secret" },
    { status: 200, message: "provider-secret" },
    { status: 600, message: "provider-secret" },
    new XmemoryMemoryError("rate_limited", "read", "provider-secret provider-body"),
  ];

  for (const context of errorContexts) {
    for (const error of unavailableErrors) {
      assertNormalized(error, context, context.unavailableCode);
    }
    for (const error of unknownErrors) {
      assertNormalized(error, context, context.protocolCode);
    }
    for (const providerCode of [undefined, "UNKNOWN_PROVIDER_CODE"]) {
      assertNormalized(
        {
          ...(providerCode === undefined ? {} : { code: providerCode }),
          status: 418,
          message: "provider-secret provider-body https://console.invalid",
        },
        context,
        context.protocolCode,
      );
    }
  }
});

test("public data and admin ports sanitize revoked and hostile Proxy rejection reasons", async () => {
  const revoked = Proxy.revocable<Record<string, unknown>>({ status: 401 }, {});
  revoked.revoke();
  const descriptorError = new Error(
    "provider-secret provider-body hostile-descriptor https://console.invalid",
  );
  const hostileDescriptor = new Proxy(
    { status: 401 },
    { getOwnPropertyDescriptor: () => { throw descriptorError; } },
  );

  for (const reason of [revoked.proxy, hostileDescriptor]) {
    const data = platform(
      instance({
        getSchema: async () => Promise.reject(reason),
        read: async () => Promise.reject(reason),
        write: async () => Promise.reject(reason),
      }),
    );
    await rejectsHostileReason(
      data.getSchema(1),
      {
        code: "protocol_error",
        operation: "schema",
        message: "xmemory returned an invalid schema response",
      },
      reason,
    );
    await rejectsHostileReason(
      data.read({ query: "query", readMode: "single-answer", traceId: "trace", timeoutMs: 1 }),
      {
        code: "protocol_error",
        operation: "read",
        message: "xmemory returned an invalid read response",
      },
      reason,
    );
    await rejectsHostileReason(
      data.write({ text: "lesson", extractionLogic: "deep", diffEngine: true, timeoutMs: 1 }),
      {
        code: "write_outcome_unknown",
        operation: "write",
        message: "The xmemory write outcome is unknown",
      },
      reason,
    );

    const control = adminPlatform(
      admin({
        getCluster: async () => Promise.reject(reason),
        listInstances: async () => Promise.reject(reason),
        getInstanceSchema: async () => Promise.reject(reason),
        createInstance: async () => Promise.reject(reason),
      }),
    );
    for (const call of [
      () => control.getCluster("cluster", 1),
      () => control.listInstances(1),
      () => control.getSchema("instance", 1),
    ]) {
      await rejectsHostileReason(
        call(),
        {
          code: "protocol_error",
          operation: "provision",
          message: "xmemory returned an invalid provision response",
        },
        reason,
      );
    }
    await rejectsHostileReason(
      control.createInstance({
        clusterId: "cluster",
        name: "pilot",
        description: "Disposable Loci xmemory pilot",
        schemaYml: "xmd_version: v1\n",
        timeoutMs: 1,
      }),
      {
        code: "provision_outcome_unknown",
        operation: "provision",
        message: "The xmemory instance creation outcome is unknown",
      },
      reason,
    );
  }
});

test("public data and admin ports sanitize hostile fulfilled SDK envelopes", async () => {
  const descriptorError = new Error(
    "provider-secret provider-body hostile-descriptor https://console.invalid",
  );
  const hostileEnvelope = new Proxy(
    { data_schema: {} },
    { getOwnPropertyDescriptor: () => { throw descriptorError; } },
  );
  const data = platform(
    instance({
      getSchema: async () => hostileEnvelope,
      read: async () => hostileEnvelope,
      write: async () => hostileEnvelope,
    }),
  );

  await rejectsHostileReason(
    data.getSchema(1),
    {
      code: "protocol_error",
      operation: "schema",
      message: "xmemory returned an invalid schema response",
    },
    descriptorError,
  );
  await rejectsHostileReason(
    data.read({ query: "query", readMode: "single-answer", traceId: "trace", timeoutMs: 1 }),
    {
      code: "protocol_error",
      operation: "read",
      message: "xmemory returned an invalid read response",
    },
    descriptorError,
  );
  await rejectsHostileReason(
    data.write({ text: "lesson", extractionLogic: "deep", diffEngine: true, timeoutMs: 1 }),
    {
      code: "write_outcome_unknown",
      operation: "write",
      message: "The xmemory write outcome is unknown",
    },
    descriptorError,
  );

  const control = adminPlatform(
    admin({
      getCluster: async () => hostileEnvelope,
      listInstances: async () => hostileEnvelope,
      getInstanceSchema: async () => hostileEnvelope,
      createInstance: async () => hostileEnvelope,
    }),
  );
  for (const call of [
    () => control.getCluster("cluster", 1),
    () => control.listInstances(1),
    () => control.getSchema("instance", 1),
  ]) {
    await rejectsHostileReason(
      call(),
      {
        code: "protocol_error",
        operation: "provision",
        message: "xmemory returned an invalid provision response",
      },
      descriptorError,
    );
  }
  await rejectsHostileReason(
    control.createInstance({
      clusterId: "cluster",
      name: "pilot",
      description: "Disposable Loci xmemory pilot",
      schemaYml: "xmd_version: v1\n",
      timeoutMs: 1,
    }),
    {
      code: "provision_outcome_unknown",
      operation: "provision",
      message: "The xmemory instance creation outcome is unknown",
    },
    descriptorError,
  );
});

test("malformed SDK success and injected errors are normalized by operation", async () => {
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

  const injectedBoundaryError = new XmemoryMemoryError(
    "rate_limited",
    "write",
    "provider-secret provider-body https://console.invalid",
  );
  await rejectsCode(
    platform(instance({ read: async () => Promise.reject(injectedBoundaryError) })).read({
      query: "query",
      readMode: "single-answer",
      traceId: "trace",
      timeoutMs: 1,
    }),
    "protocol_error",
  );
  await rejectsCode(
    platform(instance({ write: async () => Promise.reject(injectedBoundaryError) })).write({
      text: "lesson",
      extractionLogic: "deep",
      diffEngine: true,
      timeoutMs: 1,
    }),
    "write_outcome_unknown",
  );
});
