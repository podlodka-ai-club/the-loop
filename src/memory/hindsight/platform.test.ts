import assert from "node:assert/strict";
import test from "node:test";
import { HindsightError } from "@vectorize-io/hindsight-client";
import { HindsightMemoryError, normalizeHindsightError } from "./error.ts";
import {
  createHindsightPlatformPortInternal,
  type HindsightSdkClient,
} from "./platform-internal.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  createHindsightPlatformPort,
  type HindsightRecallRequest,
  type HindsightRetainRequest,
} from "./platform-contract.ts";

const retainRequest: HindsightRetainRequest = {
  bankId: "bank-test",
  content: "synthetic lesson",
  documentId: "attempt-001",
  context: "loci_training_reflection",
  metadata: {
    loci_source_attempt_id: "attempt-001",
    loci_region: "Iceland",
    loci_triggers_json: "[\"yellow posts\"]",
  },
  async: false,
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

const recallRequest: HindsightRecallRequest = {
  bankId: "bank-test",
  query: "yellow posts",
  maxTokens: 4_096,
  budget: "mid",
  types: ["world", "experience", "observation"],
  preferObservations: true,
  includeSourceFacts: false,
  includeChunks: false,
  includeEntities: false,
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

function sdk(overrides: Partial<HindsightSdkClient> = {}): HindsightSdkClient {
  return {
    retain: async () => ({
      success: true,
      bank_id: "bank-test",
      items_count: 1,
      async: false,
      operation_id: null,
      usage: { input_tokens: 3 },
    }),
    recall: async () => ({ results: [] }),
    getVersion: async () => ({ api_version: "v1" }),
    listDocuments: async () => ({ items: [], total: 0, limit: 1, offset: 0 }),
    ...overrides,
  };
}

function port(client: HindsightSdkClient, config: { apiKey?: string; baseUrl?: string } = {}) {
  return createHindsightPlatformPortInternal(
    {
      apiKey: config.apiKey ?? "test-api-key",
      baseUrl: config.baseUrl ?? HINDSIGHT_CLOUD_BASE_URL,
    },
    { createClient: () => client },
  );
}

function assertError(promise: Promise<unknown>, code: string, operation: string, retryable: boolean) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof HindsightMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
}

test("Cloud allowlist is checked before lazy SDK construction", () => {
  assert.equal(typeof createHindsightPlatformPort, "function");
  let constructions = 0;
  const dependencies = {
    createClient: () => {
      constructions += 1;
      return sdk();
    },
  };

  for (const config of [
    { apiKey: "", baseUrl: HINDSIGHT_CLOUD_BASE_URL },
    { apiKey: "   ", baseUrl: HINDSIGHT_CLOUD_BASE_URL },
    { apiKey: "test-api-key", baseUrl: "https://example.invalid" },
    { apiKey: "test-api-key", baseUrl: undefined as never },
  ]) {
    assert.throws(
      () => createHindsightPlatformPortInternal(config, dependencies),
      (error) => error instanceof HindsightMemoryError && error.code === "unsupported_configuration",
    );
  }
  assert.equal(constructions, 0);

  const adapter = createHindsightPlatformPortInternal(
    { apiKey: "test-api-key", baseUrl: HINDSIGHT_CLOUD_BASE_URL },
    dependencies,
  );
  assert.equal(constructions, 0);
  assert.equal(typeof adapter.recall, "function");
});

test("SDK constructor and Cloud calls are lazy and map normalized envelopes", async () => {
  let constructionConfig: unknown;
  let retainArgs: unknown[] = [];
  let recallArgs: unknown[] = [];
  let versionOptions: unknown;
  let documentArgs: unknown[] = [];
  const client = sdk({
    retain: async (...args) => {
      retainArgs = args;
      return {
        success: true,
        bank_id: "bank-test",
        items_count: 1,
        async: false,
        operation_id: null,
        usage: { input_tokens: 3 },
      };
    },
    recall: async (...args) => {
      recallArgs = args;
      return {
        results: [{
          id: "fact-1",
          text: "yellow posts are useful",
          type: "world",
          context: "loci_training_reflection",
          metadata: { region: "Iceland" },
          document_id: "attempt-001",
          source_fact_ids: ["fact-0"],
          scores: { final: 0.9, semantic: null },
        }],
      };
    },
    getVersion: async (options) => {
      versionOptions = options;
      return { api_version: "v1" };
    },
    listDocuments: async (...args) => {
      documentArgs = args;
      return { items: [], total: 0, limit: 1, offset: 0 };
    },
  });
  const adapter = createHindsightPlatformPortInternal(
    { apiKey: "test-api-key", baseUrl: HINDSIGHT_CLOUD_BASE_URL },
    {
      createClient: (config) => {
        constructionConfig = config;
        return client;
      },
    },
  );

  assert.equal(constructionConfig, undefined);
  assert.deepEqual(await adapter.retain(retainRequest), {
    success: true,
    bankId: "bank-test",
    itemsCount: 1,
    async: false,
    operationId: null,
    usage: { input_tokens: 3 },
  });
  assert.deepEqual(retainArgs.slice(0, 2), ["bank-test", "synthetic lesson"]);
  assert.deepEqual(retainArgs[2], {
    documentId: "attempt-001",
    context: "loci_training_reflection",
    metadata: retainRequest.metadata,
    async: false,
    signal: (retainArgs[2] as { signal: AbortSignal }).signal,
  });
  assert.deepEqual(constructionConfig, {
    baseUrl: HINDSIGHT_CLOUD_BASE_URL,
    apiKey: "test-api-key",
    userAgent: "loci-hindsight-adapter/1.0",
  });

  assert.deepEqual(await adapter.recall(recallRequest), {
    results: [{
      id: "fact-1",
      text: "yellow posts are useful",
      type: "world",
      context: "loci_training_reflection",
      metadata: { region: "Iceland" },
      documentId: "attempt-001",
      sourceFactIds: ["fact-0"],
      scores: { final: 0.9, semantic: null },
    }],
  });
  assert.deepEqual(recallArgs.slice(0, 2), ["bank-test", "yellow posts"]);
  assert.deepEqual(recallArgs[2], {
    types: recallRequest.types,
    preferObservations: true,
    maxTokens: 4_096,
    budget: "mid",
    includeSourceFacts: false,
    includeChunks: false,
    includeEntities: false,
    signal: (recallArgs[2] as { signal: AbortSignal }).signal,
  });

  assert.deepEqual(await adapter.getVersion({ timeoutMs: 1_000, signal: new AbortController().signal }), {
    apiVersion: "v1",
  });
  assert.equal(typeof (versionOptions as { signal: AbortSignal }).signal, "object");
  assert.notEqual(
    (versionOptions as { signal: AbortSignal }).signal,
    (retainArgs[2] as { signal: AbortSignal }).signal,
  );
  const listRequestSignal = new AbortController().signal;
  assert.deepEqual(
    await adapter.listDocuments({ bankId: "bank-test", timeoutMs: 1_000, signal: listRequestSignal }),
    { total: 0 },
  );
  const listOptions = documentArgs[1] as { limit: number; offset: number; signal: AbortSignal };
  assert.deepEqual(documentArgs, ["bank-test", listOptions]);
  assert.deepEqual(listOptions, { limit: 1, offset: 0, signal: listOptions.signal });
  assert.notEqual(listOptions.signal, listRequestSignal);
});

test("status, malformed response and transport failures are decoded without raw details", async () => {
  await assertError(
    port(sdk({ recall: async () => { throw new HindsightError("secret", 429, { body: "secret" }); } })).recall(recallRequest),
    "rate_limited",
    "read",
    true,
  );
  await assertError(
    port(sdk({ retain: async () => { throw new HindsightError("secret", 500, { body: "secret" }); } })).retain(retainRequest),
    "write_outcome_unknown",
    "write",
    false,
  );
  await assertError(
    port(sdk({ retain: async () => ({ success: true }) })).retain(retainRequest),
    "protocol_error",
    "write",
    false,
  );
  await assertError(
    port(sdk({ recall: async () => { throw new TypeError("private secret"); } })).recall(recallRequest),
    "unavailable",
    "read",
    true,
  );
  await assertError(
    port(sdk({ recall: async () => { throw { statusCode: 401, body: "private secret" }; } })).recall(recallRequest),
    "protocol_error",
    "read",
    false,
  );
  await assertError(
    port(sdk({ recall: async () => { throw new HindsightError("secret", 418, { body: "private secret" }); } })).recall(recallRequest),
    "protocol_error",
    "read",
    false,
  );
  const foreign = normalizeHindsightError({ statusCode: 401, body: "private secret" }, "read");
  assert.equal(foreign.code, "protocol_error");
});

test("already-aborted calls return timeout without SDK calls; later aborts preserve write uncertainty", async () => {
  let sdkCalls = 0;
  const client = sdk({
    recall: async () => {
      sdkCalls += 1;
      return { results: [] };
    },
  });
  const adapter = port(client);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assertError(
    adapter.recall({ ...recallRequest, signal: alreadyAborted.signal }),
    "timeout",
    "read",
    true,
  );
  assert.equal(sdkCalls, 0);

  const writeClient = sdk({
    retain: async () => {
      sdkCalls += 1;
      return {
        success: true,
        bank_id: "bank-test",
        items_count: 1,
        async: false,
        operation_id: null,
      };
    },
  });
  const writeAdapter = port(writeClient);
  await assertError(
    writeAdapter.retain({ ...retainRequest, signal: alreadyAborted.signal }),
    "timeout",
    "write",
    false,
  );
  assert.equal(sdkCalls, 0);

  const afterStart = new AbortController();
  const pending = adapter.recall({ ...recallRequest, signal: afterStart.signal });
  afterStart.abort();
  await assertError(pending, "timeout", "read", true);
  assert.equal(sdkCalls, 1);
});

test("post-invocation abort maps write and config operations without exposing provider details", async () => {
  const writeController = new AbortController();
  let writeStarted!: () => void;
  let resolveWrite!: (value: unknown) => void;
  const writeStartedPromise = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  let writeSignal: AbortSignal | undefined;
  const writeAdapter = port(sdk({
    retain: async (...args) => {
      writeSignal = (args[2] as { signal: AbortSignal }).signal;
      writeStarted();
      return new Promise<unknown>((resolve) => {
        resolveWrite = resolve;
      });
    },
  }));
  const writePending = writeAdapter.retain({ ...retainRequest, signal: writeController.signal });
  await writeStartedPromise;
  writeController.abort();
  resolveWrite({
    success: true,
    bank_id: "bank-test",
    items_count: 1,
    async: false,
    operation_id: null,
  });
  await assertError(writePending, "write_outcome_unknown", "write", false);
  assert.ok(writeSignal);
  assert.notEqual(writeSignal, writeController.signal);

  const configController = new AbortController();
  let configStarted!: () => void;
  let resolveConfig!: (value: unknown) => void;
  const configStartedPromise = new Promise<void>((resolve) => {
    configStarted = resolve;
  });
  let configSignal: AbortSignal | undefined;
  const configAdapter = port(sdk({
    getVersion: async (options) => {
      configSignal = options?.signal;
      configStarted();
      return new Promise<unknown>((resolve) => {
        resolveConfig = resolve;
      });
    },
  }));
  const configPending = configAdapter.getVersion({ timeoutMs: 1_000, signal: configController.signal });
  await configStartedPromise;
  configController.abort();
  resolveConfig({ api_version: "v1" });
  await assertError(configPending, "timeout", "config", false);
  assert.ok(configSignal);
  assert.notEqual(configSignal, configController.signal);
});

test("each SDK operation receives a fresh composed timeout signal", async () => {
  const callerSignals = [
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
    new AbortController().signal,
  ];
  const sdkSignals: AbortSignal[] = [];
  const client = sdk({
    retain: async (...args) => {
      sdkSignals.push((args[2] as { signal: AbortSignal }).signal);
      return {
        success: true,
        bank_id: "bank-test",
        items_count: 1,
        async: false,
        operation_id: null,
      };
    },
    recall: async (...args) => {
      sdkSignals.push((args[2] as { signal: AbortSignal }).signal);
      return { results: [] };
    },
    getVersion: async (options) => {
      sdkSignals.push(options?.signal as AbortSignal);
      return { api_version: "v1" };
    },
    listDocuments: async (...args) => {
      sdkSignals.push((args[1] as { signal: AbortSignal }).signal);
      return { total: 0 };
    },
  });
  const adapter = port(client);

  await adapter.retain({ ...retainRequest, signal: callerSignals[0] });
  await adapter.recall({ ...recallRequest, signal: callerSignals[1] });
  await adapter.getVersion({ timeoutMs: 1_000, signal: callerSignals[2] });
  await adapter.listDocuments({ bankId: "bank-test", timeoutMs: 1_000, signal: callerSignals[3] });

  assert.equal(sdkSignals.length, 4);
  assert.equal(new Set(sdkSignals).size, 4);
  for (let index = 0; index < callerSignals.length; index += 1) {
    assert.notEqual(sdkSignals[index], callerSignals[index]);
  }
});

test("optional empty response strings are preserved and sparse arrays fail closed", async () => {
  await assert.deepEqual(
    await port(sdk({ recall: async () => ({
      results: [{
        id: "fact-empty-fields",
        text: "grounded fact",
        type: "",
        context: "",
        document_id: "",
        source_fact_ids: [""],
        scores: null,
      }],
    }) })).recall(recallRequest),
    {
      results: [{
        id: "fact-empty-fields",
        text: "grounded fact",
        type: "",
        context: "",
        metadata: null,
        documentId: "",
        sourceFactIds: [""],
        scores: null,
      }],
    },
  );

  const sparseResults = new Array(1) as unknown[];
  await assertError(
    port(sdk({ recall: async () => ({ results: sparseResults }) })).recall(recallRequest),
    "protocol_error",
    "read",
    false,
  );
  const sparseSourceFacts = new Array(1) as unknown[];
  await assertError(
    port(sdk({ recall: async () => ({ results: [{ id: "fact", text: "text", source_fact_ids: sparseSourceFacts }] }) })).recall(recallRequest),
    "protocol_error",
    "read",
    false,
  );
});

test("null and malformed requests are sanitized before SDK construction", async () => {
  let constructions = 0;
  const client = sdk();
  const adapter = createHindsightPlatformPortInternal(
    { apiKey: "test-api-key", baseUrl: HINDSIGHT_CLOUD_BASE_URL },
    { createClient: () => { constructions += 1; return client; } },
  );

  await assertError(adapter.retain(null as never), "protocol_error", "write", false);
  await assertError(adapter.recall(null as never), "protocol_error", "read", false);
  await assertError(adapter.getVersion(null as never), "protocol_error", "config", false);
  await assertError(adapter.listDocuments(null as never), "protocol_error", "read", false);
  await assertError(adapter.retain({ ...retainRequest, metadata: null } as never), "protocol_error", "write", false);
  assert.equal(constructions, 0);
});

test("wrong retain context is rejected before the SDK call", async () => {
  let sdkCalls = 0;
  const adapter = port(sdk({
    retain: async () => {
      sdkCalls += 1;
      return {};
    },
  }));
  await assertError(
    adapter.retain({ ...retainRequest, context: "wrong-context" } as never),
    "protocol_error",
    "write",
    false,
  );
  assert.equal(sdkCalls, 0);
});
