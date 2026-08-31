import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryWriteError, encodeMemoryRetrieveQuery, normalizeMemoryQuery, sharedMemoryPromptMetadata } from "../memory.ts";
import {
  HINDSIGHT_CAPABILITIES,
  HINDSIGHT_DEFAULT_MAX_TOKENS,
  HINDSIGHT_DEFAULT_READ_TIMEOUT_MS,
  HINDSIGHT_DEFAULT_RECALL_BUDGET,
  HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS,
  buildHindsightRetainRequest,
  createHindsightMemory,
  loadHindsightMemoryConfig,
} from "./memory.ts";
import { HindsightMemoryError } from "./error.ts";
import {
  resolveHindsightMemorySource,
  type HindsightPlatformPort,
  type HindsightRecallRequest,
  type HindsightRetainRequest,
  type HindsightRetainResponse,
} from "./platform-contract.ts";

const source = resolveHindsightMemorySource({
  memoryRef: "memory/hindsight/integration",
  bankId: "bank-integration",
  purpose: "integration",
});

function config() {
  return loadHindsightMemoryConfig(source, { HINDSIGHT_API_KEY: "test-api-key" });
}

function platform(overrides: Partial<HindsightPlatformPort> = {}): HindsightPlatformPort {
  return {
    retain: async () => ({
      success: true,
      bankId: source.bankId,
      itemsCount: 1,
      async: false,
      operationId: null,
      usage: null,
    }),
    recall: async () => ({ results: [] }),
    getVersion: async () => ({ apiVersion: "test" }),
    listDocuments: async () => ({ total: 0 }),
    ...overrides,
  };
}

function assertMemoryError(
  action: () => unknown,
  code: string,
  operation: string,
  retryable = false,
): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof HindsightMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    return true;
  });
}

async function assertAsyncMemoryError(
  promise: Promise<unknown>,
  code: string,
  operation: string,
  retryable = false,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    if (operation === "write" && error instanceof MemoryWriteError) {
      assert.equal(error.code, code === "write_outcome_unknown" ? "write_outcome_unknown" : "write_failed");
      assert.equal("cause" in error, false);
      return true;
    }
    assert.ok(error instanceof HindsightMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    return true;
  });
}

function assertConfigError(action: () => unknown): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof HindsightMemoryError);
    assert.equal(error.code, "unsupported_configuration");
    assert.equal(error.operation, "config");
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    return true;
  });
}

test("package, scripts and env contract are exact and Hindsight config reads one key", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.dependencies["@vectorize-io/hindsight-client"], "0.9.2");
  assert.equal(packageJson.scripts["test:hindsight"], "node --test src/memory/hindsight/*.test.ts");
  assert.equal(packageJson.scripts["test:hindsight"].includes("--env-file-if-exists=.env"), false);
  assert.equal(
    packageJson.scripts["test:hindsight:integration"],
    "node --env-file-if-exists=.env --test src/memory/hindsight/platform.integration.test.ts",
  );
  assert.equal(
    packageJson.scripts["hindsight:pilot"],
    "node --env-file-if-exists=.env src/memory/hindsight/pilot.ts",
  );

  const config = loadHindsightMemoryConfig(source, {
    HINDSIGHT_API_KEY: "  test-api-key  ",
    MEM0_API_KEY: "must-not-be-read",
    HINDSIGHT_READ_TIMEOUT_MS: "999999",
  });
  assert.equal(config.apiKey, "test-api-key");
  assert.deepEqual(config.source, source);
  assert.equal(config.baseUrl, "https://api.hindsight.vectorize.io");
  assert.equal(config.writeTimeoutMs, HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS);
  assert.equal(config.readTimeoutMs, HINDSIGHT_DEFAULT_READ_TIMEOUT_MS);
  assert.equal(config.maxTokens, HINDSIGHT_DEFAULT_MAX_TOKENS);
  assert.equal(config.recallBudget, HINDSIGHT_DEFAULT_RECALL_BUDGET);

  assert.match(await readFile(".env.example", "utf8"), /HINDSIGHT_API_KEY=\n/);
  const hindsightEnvironmentEntries = (await readFile(".env.example", "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.startsWith("HINDSIGHT_"));
  assert.deepEqual(hindsightEnvironmentEntries, ["HINDSIGHT_API_KEY="]);
});

test("resolved source purpose is preserved and only its credential binding is read", () => {
  for (const purpose of ["integration", "pilot"] as const) {
    const resolvedSource = resolveHindsightMemorySource({
      memoryRef: `memory/hindsight/${purpose}`,
      bankId: `bank-${purpose}`,
      purpose,
    });
    const config = loadHindsightMemoryConfig(resolvedSource, {
      HINDSIGHT_API_KEY: "test-api-key",
      MEM0_API_KEY: "must-not-be-read",
    });

    assert.deepEqual(config.source, resolvedSource);
    assert.equal(config.source.purpose, purpose);
    assert.equal(config.apiKey, "test-api-key");
  }

  assertConfigError(() =>
    loadHindsightMemoryConfig(source, {
      MEM0_API_KEY: "must-not-be-used-as-a-fallback",
    }),
  );
});

test("source and policy validation rejects non-Cloud or malformed configuration", () => {
  for (const invalidSource of [
    { ...source, provider: "mem0" },
    { ...source, deployment: "self-hosted" },
    { ...source, purpose: "production" },
    { ...source, credentialEnv: "OTHER_KEY" },
    { ...source, memoryRef: "   " },
    { ...source, bankId: "" },
  ]) {
    assertConfigError(() => loadHindsightMemoryConfig(invalidSource as never, {}));
  }

  assertConfigError(() => loadHindsightMemoryConfig(source, null as never));

  const config = loadHindsightMemoryConfig(source, { HINDSIGHT_API_KEY: "test-api-key" });
  assert.doesNotThrow(() =>
    createHindsightMemory({ snapshots: false }, {
      ...config,
      writeTimeoutMs: 1,
      readTimeoutMs: 1,
      maxTokens: 1,
    }),
  );
  assert.doesNotThrow(() =>
    createHindsightMemory({ snapshots: false }, {
      ...config,
      writeTimeoutMs: 600_000,
      readTimeoutMs: 600_000,
      maxTokens: Number.MAX_SAFE_INTEGER,
    }),
  );
  for (const invalid of [
    { ...config, baseUrl: "https://example.invalid" },
    { ...config, writeTimeoutMs: 0 },
    { ...config, writeTimeoutMs: 1.5 },
    { ...config, readTimeoutMs: 600_001 },
    { ...config, readTimeoutMs: 0 },
    { ...config, maxTokens: 1.5 },
    { ...config, maxTokens: 0 },
    { ...config, recallBudget: "max" },
  ]) {
    assertConfigError(() => createHindsightMemory({ snapshots: false }, invalid as never));
  }
});

test("revoked source, config and environment proxies are sanitized", () => {
  const sourceProxy = Proxy.revocable({ ...source }, {});
  sourceProxy.revoke();
  assertConfigError(() => loadHindsightMemoryConfig(sourceProxy.proxy as never, {}));

  const config = loadHindsightMemoryConfig(source, { HINDSIGHT_API_KEY: "test-api-key" });
  const configProxy = Proxy.revocable({ ...config }, {});
  configProxy.revoke();
  assertConfigError(() => createHindsightMemory({ snapshots: false }, configProxy.proxy as never));

  const environmentProxy = Proxy.revocable({ HINDSIGHT_API_KEY: "test-api-key" }, {});
  environmentProxy.revoke();
  assertConfigError(() => loadHindsightMemoryConfig(source, environmentProxy.proxy as never));
});

test("malformed and snapshot-required requirements fail before configuration use", () => {
  const invalidConfig = null as never;
  for (const requirements of [
    null,
    [],
    {},
    { snapshots: true },
    { snapshots: false, extra: true },
  ]) {
    assertConfigError(() => createHindsightMemory(requirements as never, invalidConfig));
  }
});

test("valid capability gate returns exact unsupported snapshot capabilities without constructing a port", () => {
  let platformCalls = 0;
  const config = loadHindsightMemoryConfig(source, { HINDSIGHT_API_KEY: "test-api-key" });
  const memory = createHindsightMemory({ snapshots: false }, config, {
    platform: {
      retain: async () => {
        platformCalls += 1;
        throw new Error("not called");
      },
      recall: async () => {
        platformCalls += 1;
        throw new Error("not called");
      },
      getVersion: async () => ({ apiVersion: "test" }),
      listDocuments: async () => ({ total: 0 }),
    },
  });

  assert.deepEqual(HINDSIGHT_CAPABILITIES, { snapshot: false, restore: false });
  assert.equal(platformCalls, 0);
  assert.equal(typeof memory.remember, "function");
  assert.equal(typeof memory.recall, "function");
});

test("configured Hindsight memory exposes the application-owned common prompt metadata", () => {
  const memory = createHindsightMemory({ snapshots: false }, config(), { platform: platform() });
  assert.deepEqual(memory.promptMetadata, sharedMemoryPromptMetadata());
});

test("retain builder validates lesson boundaries and emits the exact canonical envelope", () => {
  const lesson = {
    content: "  preserve this lesson exactly\n",
    sourceAttemptId: "  attempt-01:west  ",
    triggers: ["yellow posts", "yellow posts", "  spaced trigger  "],
    region: "Iceland",
  };
  const request = buildHindsightRetainRequest(source.bankId, lesson, 1_000);

  assert.equal(request.bankId, source.bankId);
  assert.equal(request.content, lesson.content);
  assert.equal(request.documentId, "attempt-01:west");
  assert.equal(request.retainMission, sharedMemoryPromptMetadata().store.text);
  assert.equal(request.context, "loci_training_reflection");
  assert.deepEqual(request.metadata, {
    loci_source_attempt_id: "attempt-01:west",
    loci_region: "Iceland",
    loci_triggers_json: '["yellow posts","yellow posts","  spaced trigger  "]',
  });
  assert.equal(request.async, false);
  assert.equal(request.timeoutMs, 1_000);
  assert.equal(typeof request.signal.aborted, "boolean");

  const tooLong = "x".repeat(50_001);
  const tooManyTriggers = Array.from({ length: 65 }, () => "cue");
  const tooLongTrigger = "x".repeat(257);
  for (const invalid of [
    { ...lesson, content: "   " },
    { ...lesson, content: tooLong },
    { ...lesson, sourceAttemptId: "not valid" },
    { ...lesson, sourceAttemptId: "a".repeat(129) },
    { ...lesson, region: "x".repeat(257) },
    { ...lesson, triggers: tooManyTriggers },
    { ...lesson, triggers: [tooLongTrigger] },
    { ...lesson, triggers: ["cue", 1] },
  ]) {
    assertMemoryError(
      () => buildHindsightRetainRequest(source.bankId, invalid as never, 1_000),
      "invalid_input",
      "write",
    );
  }
});

test("remember is FIFO, uses replace identity, accepts zero-fact success and observes completion", async () => {
  const started: string[] = [];
  const completed: string[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const retain = async (request: HindsightRetainRequest): Promise<HindsightRetainResponse> => {
    started.push(request.documentId);
    if (started.length === 1) await firstReleased;
    return {
      success: true,
      bankId: source.bankId,
      itemsCount: 1,
      async: false,
      operationId: null,
      usage: null,
    };
  };
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({ retain }),
    onRememberCompleted: (result) => {
      completed.push(result.documentId);
    },
  });
  const first = memory.remember({
    content: "first lesson",
    sourceAttemptId: "attempt-1",
    triggers: ["first"],
    region: "one",
  });
  const second = memory.remember({
    content: "replacement lesson",
    sourceAttemptId: "attempt-1",
    triggers: ["second"],
    region: "two",
  });

  await Promise.resolve();
  assert.deepEqual(started, ["attempt-1"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["attempt-1", "attempt-1"]);
  assert.deepEqual(completed, ["attempt-1", "attempt-1"]);
});

test("remember validates retain success envelopes and sanitizes observer failures", async () => {
  const valid = {
    success: true,
    bankId: source.bankId,
    itemsCount: 1,
    async: false,
    operationId: null,
    usage: null,
  } satisfies HindsightRetainResponse;
  const lesson = {
    content: "lesson",
    sourceAttemptId: "attempt-response",
    triggers: [],
    region: "region",
  };

  for (const response of [
    { ...valid, success: false },
    { ...valid, bankId: "other-bank" },
    { ...valid, itemsCount: 0 },
    { ...valid, async: true },
    { ...valid, operationId: "operation" },
    { ...valid, usage: { input_tokens: "secret" } },
    null,
  ]) {
    const memory = createHindsightMemory({ snapshots: false }, config(), {
      platform: platform({ retain: async () => response as HindsightRetainResponse }),
    });
    await assertAsyncMemoryError(
      memory.remember(lesson),
      response !== null && "success" in response && response.success === false
        ? "write_failed"
        : "protocol_error",
      "write",
    );
  }

  let calls = 0;
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({
      retain: async () => {
        calls += 1;
        return valid;
      },
    }),
    onRememberCompleted: () => {
      throw new Error("observer secret");
    },
  });
  await assertAsyncMemoryError(memory.remember(lesson), "observer_failed", "write");
  await assertAsyncMemoryError(memory.remember({ ...lesson, sourceAttemptId: "attempt-next" }), "observer_failed", "write");
  assert.equal(calls, 2);
});

test("unknown write outcome quarantines once, blocks queued and future reads/writes, and never retries", async () => {
  let retainCalls = 0;
  let quarantineCalls = 0;
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({
      retain: async () => {
        retainCalls += 1;
        throw new HindsightMemoryError("write_outcome_unknown", "write");
      },
      recall: async () => {
        throw new Error("recall must be blocked");
      },
    }),
    onInstanceQuarantined: () => {
      quarantineCalls += 1;
    },
  });
  const first = memory.remember({ content: "first", sourceAttemptId: "attempt-q1", triggers: [], region: "" });
  const queued = memory.remember({ content: "queued", sourceAttemptId: "attempt-q2", triggers: [], region: "" });
  await assertAsyncMemoryError(first, "write_outcome_unknown", "write");
  await assertAsyncMemoryError(queued, "instance_quarantined", "write");
  await assertAsyncMemoryError(memory.remember({ content: "future", sourceAttemptId: "attempt-q3", triggers: [], region: "" }), "instance_quarantined", "write");
  await assertAsyncMemoryError(memory.recall([], 1), "instance_quarantined", "read");
  assert.equal(retainCalls, 1);
  assert.equal(quarantineCalls, 1);
});

test("recall sends exact native options, preserves provider order and defensively slices", async () => {
  let received!: HindsightRecallRequest;
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({
      recall: async (request) => {
        received = request;
        return {
          results: [
            { id: "fact-2", text: "second", type: null, context: null, metadata: null, documentId: null, sourceFactIds: null, scores: null },
            { id: "fact-1", text: "first", type: null, context: null, metadata: null, documentId: null, sourceFactIds: null, scores: null },
            { id: "fact-3", text: "third", type: null, context: null, metadata: null, documentId: null, sourceFactIds: null, scores: null },
          ],
        };
      },
    }),
  });
  assert.deepEqual(await memory.recall(["  yellow\tposts ", "", "yellow posts"], 2), [
    { lessonId: "fact-2", text: "second" },
    { lessonId: "fact-1", text: "first" },
  ]);
  assert.equal(received.bankId, source.bankId);
  assert.equal(
    received.query,
    encodeMemoryRetrieveQuery(sharedMemoryPromptMetadata().retrieve, normalizeMemoryQuery(["yellow\tposts", "yellow posts"])),
  );
  assert.deepEqual(received.types, ["world", "experience", "observation"]);
  assert.equal(received.preferObservations, true);
  assert.equal(received.maxTokens, config().maxTokens);
  assert.equal(received.budget, "mid");
  assert.equal(received.includeSourceFacts, false);
  assert.equal(received.includeChunks, false);
  assert.equal(received.includeEntities, false);
  assert.equal(received.timeoutMs, config().readTimeoutMs);
  assert.equal(typeof received.signal.aborted, "boolean");

  let emptyQueryCalls = 0;
  const emptyQueryMemory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({ recall: async (request) => {
      emptyQueryCalls += 1;
      assert.equal(request.query, encodeMemoryRetrieveQuery(sharedMemoryPromptMetadata().retrieve, ""));
      return { results: [] };
    } }),
  });
  assert.deepEqual(await emptyQueryMemory.recall([], 1), []);
  assert.equal(emptyQueryCalls, 1);
});

test("recall validates limit and features before platform calls and rejects malformed results", async () => {
  let calls = 0;
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({
      recall: async () => {
        calls += 1;
        return { results: [] };
      },
    }),
  });
  for (const limit of [0, -1, 1.5, 1_001]) {
    await assertAsyncMemoryError(memory.recall([], limit), "invalid_input", "read");
  }
  await assertAsyncMemoryError(memory.recall(new Array(1) as string[], 1), "invalid_input", "read");
  await assertAsyncMemoryError(memory.recall(["x".repeat(513)], 1), "invalid_input", "read");
  assert.equal(calls, 0);

  for (const results of [
    null,
    [{ id: "", text: "text" }],
    [{ id: "fact", text: "   " }],
    [{ id: "fact", text: "one" }, { id: "fact", text: "two" }],
    new Array(1),
  ]) {
    const malformed = createHindsightMemory({ snapshots: false }, config(), {
      platform: platform({ recall: async () => ({ results } as never) }),
    });
    await assertAsyncMemoryError(malformed.recall([], 1), "protocol_error", "read");
  }
});

test("read provider failures stay errors, retain retry is never automatic, and snapshots remain unsupported", async () => {
  for (const [code, retryable] of [
    ["rate_limited", true],
    ["unavailable", true],
    ["timeout", true],
  ] as const) {
    let calls = 0;
    const memory = createHindsightMemory({ snapshots: false }, config(), {
      platform: platform({
        recall: async () => {
          calls += 1;
          throw new HindsightMemoryError(code, "read");
        },
      }),
    });
    await assertAsyncMemoryError(memory.recall([], 1), code, "read", retryable);
    assert.equal(calls, 1);
  }

  let platformCalls = 0;
  const memory = createHindsightMemory({ snapshots: false }, config(), {
    platform: platform({
      retain: async () => {
        platformCalls += 1;
        throw new HindsightMemoryError("rate_limited", "write");
      },
      recall: async () => {
        platformCalls += 1;
        return { results: [] };
      },
    }),
  });
  await assertAsyncMemoryError(
    memory.remember({ content: "lesson", sourceAttemptId: "attempt-rate", triggers: [], region: "" }),
    "rate_limited",
    "write",
  );
  await assertAsyncMemoryError(memory.snapshot(), "unsupported_operation", "snapshot");
  await assertAsyncMemoryError(memory.restore("secret-id"), "unsupported_operation", "restore");
  assert.equal(platformCalls, 1);
});
