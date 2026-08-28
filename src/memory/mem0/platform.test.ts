import assert from "node:assert/strict";
import test from "node:test";
import { Mem0MemoryError, type Mem0MemoryErrorCode } from "./memory.ts";
import {
  createMem0PlatformPortInternal,
  type Mem0PlatformDependencies,
  type Mem0SdkClient,
} from "./platform-internal.ts";
import {
  MEM0_PLATFORM_BASE_URL,
  type Mem0AddRequest,
} from "./platform.ts";

const addRequest: Mem0AddRequest = {
  messages: [{ role: "assistant", content: "approved synthetic lesson" }],
  agentId: "agent-test",
  infer: true,
  temporalReasoning: false,
  agentCustomInstructions: "extract durable facts",
  metadata: {
    loci_source_attempt_id: "attempt-test",
    loci_triggers: ["yellow posts"],
    loci_region: "Iceland",
  },
};

function unexpected(name: string): never {
  throw new Error(`unexpected ${name} call`);
}

function client(overrides: Partial<Mem0SdkClient> = {}): Mem0SdkClient {
  return {
    add: async () => unexpected("add"),
    get: async () => unexpected("get"),
    getAll: async () => unexpected("getAll"),
    search: async () => unexpected("search"),
    ...overrides,
  };
}

function portDependencies(
  sdk: Mem0SdkClient,
  fetchImplementation: typeof fetch = async () => unexpected("fetch"),
): Mem0PlatformDependencies {
  return { createClient: async () => sdk, fetch: fetchImplementation };
}

function port(sdk: Mem0SdkClient, fetchImplementation?: typeof fetch) {
  return createMem0PlatformPortInternal(
    { apiKey: "test-api-key" },
    portDependencies(sdk, fetchImplementation),
    MEM0_PLATFORM_BASE_URL,
  );
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: Mem0MemoryErrorCode,
  retryable = false,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Mem0MemoryError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    return true;
  });
}

test("SDK client construction is lazy and delayed rejection is sanitized without unhandled output", async () => {
  let constructionCalls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const adapter = createMem0PlatformPortInternal(
      { apiKey: "test-api-key" },
      {
        createClient: () => {
          constructionCalls += 1;
          return new Promise((_resolve, reject) => {
            setImmediate(() => reject(new Error("raw construction secret")));
          });
        },
        fetch: async () => Response.json({ id: "event", status: "PENDING" }),
      },
      MEM0_PLATFORM_BASE_URL,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructionCalls, 0);
    assert.deepEqual(await adapter.getEvent("event"), { eventId: "event", status: "PENDING" });
    assert.equal(constructionCalls, 0);

    await assert.rejects(
      adapter.search({
        query: "private query",
        filters: { agent_id: "agent" },
        topK: 1,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      }),
      (error) => {
        assert.ok(error instanceof Mem0MemoryError);
        assert.equal(error.code, "protocol_error");
        assert.equal(error.message.includes("raw construction secret"), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructionCalls, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("platform configuration fails before client construction with sanitized errors", () => {
  let constructionCalls = 0;
  const dependencies: Mem0PlatformDependencies = {
    createClient: async () => {
      constructionCalls += 1;
      return client();
    },
    fetch: async () => unexpected("fetch"),
  };

  for (const config of [
    { apiKey: "" },
    { apiKey: "   " },
    { apiKey: "secret-api-key", baseUrl: "https://example.invalid" },
  ]) {
    assert.throws(
      () => createMem0PlatformPortInternal(config, dependencies, MEM0_PLATFORM_BASE_URL),
      (error) => {
        assert.ok(error instanceof Mem0MemoryError);
        assert.equal(error.code, "unsupported_configuration");
        assert.equal(error.retryable, false);
        assert.equal(error.message.includes("secret-api-key"), false);
        assert.equal(error.message.includes("example.invalid"), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
  assert.equal(constructionCalls, 0);
});

test("add forwards the exact SDK policy and normalizes SDK key casing", async () => {
  let receivedMessages: unknown;
  let receivedOptions: unknown;
  const adapter = port(
    client({
      add: async (messages, options) => {
        receivedMessages = messages;
        receivedOptions = options;
        return { eventId: "event-1", status: "PENDING", ignored: "provider detail" };
      },
    }),
  );

  assert.deepEqual(await adapter.add(addRequest), { eventId: "event-1", status: "PENDING" });
  assert.deepEqual(receivedMessages, addRequest.messages);
  assert.deepEqual(receivedOptions, {
    agentId: addRequest.agentId,
    infer: true,
    temporalReasoning: false,
    agentCustomInstructions: addRequest.agentCustomInstructions,
    metadata: addRequest.metadata,
  });

  const snakeCase = port(client({ add: async () => ({ event_id: "event-2", status: "PENDING" }) }));
  assert.deepEqual(await snakeCase.add(addRequest), { eventId: "event-2", status: "PENDING" });
});

test("add rejects every malformed or non-PENDING success envelope", async () => {
  const malformed: unknown[] = [
    null,
    [],
    {},
    { eventId: "", status: "PENDING" },
    { eventId: "event", status: "RUNNING" },
    { eventId: "event", status: "SUCCEEDED" },
    { event_id: 42, status: "PENDING" },
  ];
  for (const value of malformed) {
    await rejectsWith(port(client({ add: async () => value })).add(addRequest), "protocol_error");
  }
});

test("event wire envelopes normalize casing, terminal IDs and sanitized failure", async () => {
  const envelopes: unknown[] = [
    { id: "event-1", status: "PENDING" },
    { event_id: "event-1", status: "RUNNING" },
    { eventId: "event-1", status: "SUCCEEDED", memoryIds: ["memory-1"] },
    { id: "event-1", status: "SUCCEEDED", memory_ids: ["memory-2"] },
    { id: "event-1", status: "SUCCEEDED", results: [{ memory_id: "memory-3" }] },
    { id: "event-1", status: "FAILED", error: "raw provider secret" },
  ];
  const expected = [
    { eventId: "event-1", status: "PENDING" },
    { eventId: "event-1", status: "RUNNING" },
    { eventId: "event-1", status: "SUCCEEDED", memoryIds: ["memory-1"] },
    { eventId: "event-1", status: "SUCCEEDED", memoryIds: ["memory-2"] },
    { eventId: "event-1", status: "SUCCEEDED", memoryIds: ["memory-3"] },
    { eventId: "event-1", status: "FAILED", error: "Mem0 ingestion failed" },
  ];

  for (let index = 0; index < envelopes.length; index += 1) {
    const fetchImplementation: typeof fetch = async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Token test-api-key");
      return Response.json(envelopes[index]);
    };
    assert.deepEqual(await port(client(), fetchImplementation).getEvent("event-1"), expected[index]);
  }
});

test("event rejects unknown status, malformed IDs/results and invalid JSON", async () => {
  const malformed: unknown[] = [
    {},
    { id: "event", status: "pending" },
    { id: "event", status: "UNKNOWN" },
    { id: "event", status: "SUCCEEDED" },
    { id: "event", status: "SUCCEEDED", results: null },
    { id: "event", status: "SUCCEEDED", results: [{}] },
  ];
  for (const value of malformed) {
    const fetchImplementation: typeof fetch = async () => Response.json(value);
    await rejectsWith(port(client(), fetchImplementation).getEvent("event"), "protocol_error");
  }

  const invalidJson: typeof fetch = async () => new Response("not-json");
  await rejectsWith(port(client(), invalidJson).getEvent("event"), "protocol_error");
});

test("get/list/search validate records, preserve order and list every page", async () => {
  const calls: Array<{ page: unknown; filters: unknown }> = [];
  const pages: unknown[] = [
    {
      count: 2,
      next: "https://api.mem0.ai/v3/memories/?page=2",
      previous: null,
      results: [{ id: "memory-1", memory: "first", metadata: { source: "one" } }],
    },
    {
      count: 2,
      next: null,
      previous: "https://api.mem0.ai/v3/memories/?page=1",
      results: [{ id: "memory-2", memory: "second", metadata: { source: "two" } }],
    },
  ];
  let pageIndex = 0;
  const sdk = client({
    get: async () => ({ id: "memory-1", memory: "first", metadata: { source: "one" } }),
    getAll: async (options) => {
      calls.push({ page: options.page, filters: options.filters });
      const value = pages[pageIndex];
      pageIndex += 1;
      return value;
    },
    search: async () => ({
      results: [
        { id: "memory-2", memory: "second", score: 0.9, metadata: {} },
        { id: "memory-1", memory: "first", score: 0.8, metadata: {} },
      ],
    }),
  });
  const adapter = port(sdk);

  assert.equal((await adapter.get("memory-1"))?.id, "memory-1");
  assert.deepEqual(
    (await adapter.list("agent-test")).map((record) => record.id),
    ["memory-1", "memory-2"],
  );
  assert.deepEqual(calls, [
    { page: 1, filters: { agent_id: "agent-test" } },
    { page: 2, filters: { agent_id: "agent-test" } },
  ]);
  assert.deepEqual(
    (
      await adapter.search({
        query: "yellow posts",
        filters: { agent_id: "agent-test" },
        topK: 2,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      })
    ).map((record) => record.id),
    ["memory-2", "memory-1"],
  );
});

test("get maps SDK 404 to null and malformed records/envelopes to protocol errors", async () => {
  assert.equal(
    await port(client({ get: async () => Promise.reject({ name: "MemoryNotFoundError" }) })).get(
      "missing",
    ),
    null,
  );
  await rejectsWith(
    port(client({ get: async () => ({ id: "memory", memory: "", metadata: {} }) })).get("memory"),
    "protocol_error",
  );
  await rejectsWith(
    port(
      client({
        getAll: async () => ({ count: 2, next: null, previous: null, results: [] }),
      }),
    ).list("agent"),
    "protocol_error",
  );
  await rejectsWith(
    port(client({ search: async () => ({ results: [{ id: "memory", memory: "fact" }] }) })).search({
      query: "fact",
      filters: { agent_id: "agent" },
      topK: 1,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    }),
    "protocol_error",
  );

  const malformedRecords: unknown[] = [
    null,
    [],
    {},
    { id: "", memory: "fact", metadata: {} },
    { id: "memory", memory: "", metadata: {} },
    { id: "memory", memory: "fact" },
    { id: "memory", memory: "fact", metadata: [] },
    { id: "memory", memory: "fact", score: Number.NaN, metadata: {} },
    { id: "memory", memory: "fact", score: Number.POSITIVE_INFINITY, metadata: {} },
    { id: "memory", memory: "fact", score: "0.5", metadata: {} },
  ];
  for (const value of malformedRecords) {
    await rejectsWith(port(client({ get: async () => value })).get("memory"), "protocol_error");
  }
});

test("list rejects malformed pagination instead of returning partial data", async () => {
  const malformedPageSequences: unknown[][] = [
    [{ count: -1, next: null, results: [] }],
    [{ count: 0.5, next: null, results: [] }],
    [{ count: 1, next: "", results: [] }],
    [{ count: 1, next: null, results: [] }],
    [
      { count: 2, next: "page-2", results: [{ id: "one", memory: "one", metadata: {} }] },
      { count: 3, next: null, results: [{ id: "two", memory: "two", metadata: {} }] },
    ],
    [
      { count: 3, next: "same-page", results: [{ id: "one", memory: "one", metadata: {} }] },
      { count: 3, next: "same-page", results: [{ id: "two", memory: "two", metadata: {} }] },
    ],
  ];

  for (const pages of malformedPageSequences) {
    let pageIndex = 0;
    const adapter = port(
      client({
        getAll: async () => {
          const value = pages[pageIndex];
          pageIndex += 1;
          return value;
        },
      }),
    );
    await rejectsWith(adapter.list("agent"), "protocol_error");
  }
});

test("SDK and HTTP errors map to sanitized codes and retry policy", async () => {
  const sdkCases: Array<[unknown, Mem0MemoryErrorCode, boolean]> = [
    [{ errorCode: "HTTP_401", message: "raw secret" }, "authentication", false],
    [{ errorCode: "HTTP_403", message: "raw secret" }, "authorization", false],
    [{ name: "AuthenticationError", message: "raw secret" }, "authentication", false],
    [{ name: "MemoryQuotaExceededError", message: "raw secret" }, "quota_exceeded", false],
    [{ name: "RateLimitError", message: "raw secret" }, "rate_limited", true],
    [{ name: "ValidationError", message: "raw secret" }, "invalid_input", false],
    [{ name: "ConfigurationError", message: "raw secret" }, "invalid_input", false],
    [{ name: "NetworkError", message: "raw secret" }, "unavailable", true],
    [{ name: "AbortError", message: "raw secret" }, "unavailable", true],
    [new TypeError("raw secret"), "unavailable", true],
    [new Error("raw secret"), "protocol_error", false],
  ];
  for (const [raw, code, retryable] of sdkCases) {
    const adapter = port(client({ search: async () => Promise.reject(raw) }));
    await assert.rejects(
      adapter.search({
        query: "private query",
        filters: { agent_id: "agent" },
        topK: 1,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      }),
      (error) => {
        assert.ok(error instanceof Mem0MemoryError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.message.includes("raw secret"), false);
        assert.equal(error.message.includes("private query"), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }

  const httpCases: Array<[number, Mem0MemoryErrorCode, boolean]> = [
    [400, "invalid_input", false],
    [401, "authentication", false],
    [403, "authorization", false],
    [408, "unavailable", true],
    [409, "invalid_input", false],
    [413, "quota_exceeded", false],
    [422, "invalid_input", false],
    [429, "rate_limited", true],
    [404, "unavailable", true],
    [500, "unavailable", true],
    [503, "unavailable", true],
    [418, "protocol_error", false],
  ];
  for (const [status, code, retryable] of httpCases) {
    const fetchImplementation: typeof fetch = async () =>
      new Response("raw event payload secret", { status });
    await rejectsWith(port(client(), fetchImplementation).getEvent("event"), code, retryable);
  }
});

test("raw SDK and HTTP material never enters public errors or console output", async () => {
  const raw = {
    apiKey: "secret-api-key",
    authorization: "Token secret-api-key",
    lesson: "private lesson body",
    query: "private query body",
    provider: "raw provider failure",
    response: "raw event response body",
  };
  const output: unknown[][] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values);
  console.warn = (...values: unknown[]) => output.push(values);
  console.error = (...values: unknown[]) => output.push(values);

  try {
    const sdkAdapter = createMem0PlatformPortInternal(
      { apiKey: raw.apiKey },
      portDependencies(
        client({
          add: async () =>
            Promise.reject({
              name: "AuthenticationError",
              message: raw.provider,
              request: { body: raw.lesson, headers: { Authorization: raw.authorization } },
            }),
        }),
      ),
      MEM0_PLATFORM_BASE_URL,
    );
    const sdkError = await sdkAdapter
      .add({ ...addRequest, messages: [{ role: "assistant", content: raw.lesson }] })
      .catch((error: unknown) => error);

    const httpAdapter = createMem0PlatformPortInternal(
      { apiKey: raw.apiKey },
      portDependencies(client(), async () => new Response(raw.response, { status: 401 })),
      MEM0_PLATFORM_BASE_URL,
    );
    const httpError = await httpAdapter.getEvent("event").catch((error: unknown) => error);

    for (const error of [sdkError, httpError]) {
      assert.ok(error instanceof Mem0MemoryError);
      const exposed = `${error.name} ${error.message} ${JSON.stringify(error)}`;
      for (const secret of Object.values(raw)) assert.equal(exposed.includes(secret), false);
      assert.equal("cause" in error, false);
      assert.equal("request" in error, false);
      assert.equal("response" in error, false);
      assert.equal("headers" in error, false);
    }
    assert.deepEqual(output, []);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
