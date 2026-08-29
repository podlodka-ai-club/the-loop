import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  XMEMORY_CAPABILITIES,
  XmemoryMemoryError,
  createXmemoryMemory,
  loadXmemoryMemoryConfig,
  type XmemoryMemoryDependencies,
} from "./memory.ts";
import type { XmemoryMemoryErrorCode } from "./error.ts";
import {
  loadXmemoryIntegrationConfig,
  xmemoryIntegrationEnabled,
} from "./integration.ts";
import { createXmemoryAdminPort, createXmemoryPlatformPort, XMEMORY_API_BASE_URL } from "./platform.ts";
import type { XmemoryPlatformPort } from "./platform-contract.ts";
import { loadXmemorySchema } from "./schema.ts";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function assertSecretAbsent(error: XmemoryMemoryError, secret: string): void {
  for (const representation of [
    error.message,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(Object.fromEntries(Object.entries(error))),
  ]) {
    assert.equal(representation.includes(secret), false);
  }
  assert.equal("cause" in error, false);
}

test("xmemory dependencies, lockfile and scripts are pinned to the Phase 1 contract", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const dependencies = manifest.dependencies as Record<string, unknown>;
  const scripts = manifest.scripts as Record<string, unknown>;
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  const rootDependencies = packages[""]?.dependencies as Record<string, unknown>;

  assert.equal(dependencies.xmemory, "3.8.1");
  assert.equal(dependencies.yaml, "2.9.0");
  assert.equal(rootDependencies.xmemory, "3.8.1");
  assert.equal(rootDependencies.yaml, "2.9.0");
  assert.equal(packages["node_modules/xmemory"]?.version, "3.8.1");
  assert.equal(packages["node_modules/yaml"]?.version, "2.9.0");
  assert.deepEqual(
    Object.fromEntries(Object.entries(scripts).filter(([name]) => name.includes("xmemory"))),
    {
      "test:xmemory": "node --test src/memory/xmemory/*.test.ts",
      "xmemory:schema:validate": "node src/memory/xmemory/schema-validate.ts",
      "xmemory:provision": "node --env-file-if-exists=.env src/memory/xmemory/provision.ts",
      "xmemory:pilot": "node --env-file-if-exists=.env src/memory/xmemory/pilot.ts",
      "xmemory:pilot:finalize": "node src/memory/xmemory/pilot-finalize.ts",
    },
  );
});

test("runtime config uses exact variables and safe timeout defaults", () => {
  assert.deepEqual(loadXmemoryMemoryConfig({ XMEM_API_KEY: " key ", XMEM_INSTANCE_ID: " id " }), {
    apiKey: "key",
    instanceId: "id",
    writeTimeoutMs: 180_000,
    readTimeoutMs: 60_000,
  });
  assert.deepEqual(
    loadXmemoryMemoryConfig({
      XMEM_API_KEY: "key",
      XMEM_INSTANCE_ID: "id",
      XMEM_WRITE_TIMEOUT_MS: "42",
      XMEM_READ_TIMEOUT_MS: "17",
      XMEM_API_URL: "https://ignored.invalid",
      XMEM_AUTH_TOKEN: "ignored",
    }),
    { apiKey: "key", instanceId: "id", writeTimeoutMs: 42, readTimeoutMs: 17 },
  );
  assert.equal(XMEMORY_API_BASE_URL, "https://api.xmemory.ai");
});

test("xmemory environment example pins the exact runtime, integration and provisioning variables", async () => {
  const source = await readFile(".env.example", "utf8");
  assert.deepEqual(
    source
      .split("\n")
      .filter((line) => line.startsWith("XMEM_")),
    [
      "XMEM_API_KEY=",
      "XMEM_INSTANCE_ID=",
      "XMEM_WRITE_TIMEOUT_MS=180000",
      "XMEM_READ_TIMEOUT_MS=60000",
      "XMEM_INTEGRATION=0",
      "XMEM_INTEGRATION_INSTANCE_ID=",
      "XMEM_ADMIN_API_KEY=",
      "XMEM_CLUSTER_ID=",
      "XMEM_INSTANCE_NAME=",
    ],
  );
  assert.equal(source.includes("XMEM_API_URL="), false);
  assert.equal(source.includes("XMEM_AUTH_TOKEN="), false);
});

test("runtime config rejects missing credentials and unsafe timeout values without secrets", () => {
  const invalid: NodeJS.ProcessEnv[] = [
    {},
    { XMEM_API_KEY: "secret" },
    { XMEM_INSTANCE_ID: "id" },
    { XMEM_API_KEY: "secret", XMEM_INSTANCE_ID: "id", XMEM_WRITE_TIMEOUT_MS: "0" },
    { XMEM_API_KEY: "secret", XMEM_INSTANCE_ID: "id", XMEM_READ_TIMEOUT_MS: " 1" },
    { XMEM_API_KEY: "secret", XMEM_INSTANCE_ID: "id", XMEM_READ_TIMEOUT_MS: "1.5" },
    {
      XMEM_API_KEY: "secret",
      XMEM_INSTANCE_ID: "id",
      XMEM_WRITE_TIMEOUT_MS: "9007199254740992",
    },
  ];
  for (const env of invalid) {
    assert.throws(() => loadXmemoryMemoryConfig(env), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assert.equal(error.retryable, false);
      assertSecretAbsent(error, "secret");
      return true;
    });
  }
});

test("integration requires exact opt-in and an instance distinct from runtime", () => {
  assert.equal(xmemoryIntegrationEnabled({}), false);
  assert.equal(xmemoryIntegrationEnabled({ XMEM_INTEGRATION: "0" }), false);
  assert.equal(xmemoryIntegrationEnabled({ XMEM_INTEGRATION: "true" }), false);
  assert.equal(xmemoryIntegrationEnabled({ XMEM_INTEGRATION: "1" }), true);
  assert.deepEqual(
    loadXmemoryIntegrationConfig({
      XMEM_API_KEY: " key ",
      XMEM_INSTANCE_ID: "runtime",
      XMEM_INTEGRATION_INSTANCE_ID: "integration",
      XMEM_ADMIN_API_KEY: "ignored-admin-secret",
    }),
    { apiKey: "key", runtimeInstanceId: "runtime", integrationInstanceId: "integration" },
  );
  assert.throws(
    () =>
      loadXmemoryIntegrationConfig({
        XMEM_API_KEY: "secret",
        XMEM_INSTANCE_ID: "same",
        XMEM_INTEGRATION_INSTANCE_ID: "same",
      }),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSecretAbsent(error, "secret");
      return true;
    },
  );

  for (const env of [
    {
      XMEM_INSTANCE_ID: "runtime",
      XMEM_INTEGRATION_INSTANCE_ID: "integration",
    },
    {
      XMEM_API_KEY: "secret",
      XMEM_INTEGRATION_INSTANCE_ID: "integration",
    },
    {
      XMEM_API_KEY: "secret",
      XMEM_INSTANCE_ID: "runtime",
    },
  ]) {
    assert.throws(() => loadXmemoryIntegrationConfig(env), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSecretAbsent(error, "secret");
      return true;
    });
  }
});

test("runtime and integration config sanitize hostile and revoked environments", () => {
  const revoked = Proxy.revocable<NodeJS.ProcessEnv>({}, {});
  revoked.revoke();
  const hostile = new Proxy<NodeJS.ProcessEnv>({}, {
    get: () => { throw new Error("raw environment secret"); },
  });

  for (const value of [revoked.proxy, hostile]) {
    for (const call of [
      () => loadXmemoryMemoryConfig(value),
      () => loadXmemoryIntegrationConfig(value),
      () => xmemoryIntegrationEnabled(value),
    ]) {
      assert.throws(call, (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.equal(error.code, "unsupported_configuration");
        assert.equal(error.operation, "schema");
        assertSecretAbsent(error, "secret");
        return true;
      });
    }
  }
});

test("capabilities are closed and public port config rejects before SDK use", () => {
  assert.deepEqual(XMEMORY_CAPABILITIES, { snapshot: false, restore: false });
  for (const call of [
    () => createXmemoryPlatformPort({ apiKey: "", instanceId: "instance" }),
    () => createXmemoryPlatformPort({ apiKey: "secret", instanceId: "" }),
    () => createXmemoryAdminPort({ adminApiKey: "" }),
  ]) {
    assert.throws(call, (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSecretAbsent(error, "secret");
      return true;
    });
  }
});

function runtimeConfig() {
  return {
    apiKey: "runtime-key",
    instanceId: "runtime-instance",
    writeTimeoutMs: 180_000,
    readTimeoutMs: 60_000,
  };
}

function schemaPort(getSchema: XmemoryPlatformPort["getSchema"]): XmemoryPlatformPort {
  return {
    getSchema,
    write: async () => { throw new Error("unexpected write"); },
    read: async () => { throw new Error("unexpected read"); },
  };
}

test("snapshot requirements reject before config, schema or platform dependency access", async () => {
  let dependencyAccessed = false;
  const dependencies = Object.defineProperties({}, {
    platform: {
      get: () => {
        dependencyAccessed = true;
        throw new Error("raw platform secret");
      },
    },
    schemaPath: {
      get: () => {
        dependencyAccessed = true;
        throw new Error("raw schema secret");
      },
    },
  });

  const revoked = Proxy.revocable<{ snapshots: boolean }>({ snapshots: false }, {});
  revoked.revoke();
  const hostile = new Proxy(
    { snapshots: false },
    { ownKeys: () => { throw new Error("raw requirement secret"); } },
  );
  for (const requirements of [
    { snapshots: true },
    { snapshots: false, extra: true },
    Object.assign({ snapshots: false }, { [Symbol("extra")]: true }),
    Object.defineProperty({}, "snapshots", { get: () => false }),
    {},
    [],
    null,
    revoked.proxy,
    hostile,
  ]) {
    await assert.rejects(
      createXmemoryMemory(
        requirements as { snapshots: boolean },
        { apiKey: "", instanceId: "", writeTimeoutMs: 0, readTimeoutMs: 0 },
        dependencies,
      ),
      (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.equal(error.code, "unsupported_configuration");
        assert.equal(error.operation, "schema");
        assertSecretAbsent(error, "secret");
        return true;
      },
    );
  }
  assert.equal(dependencyAccessed, false);
});

test("factory validates direct config before schema and platform access", async () => {
  let dependencyAccessed = false;
  const dependencies = Object.defineProperty({}, "schemaPath", {
    get: () => {
      dependencyAccessed = true;
      return "unused";
    },
  });
  for (const config of [
    { ...runtimeConfig(), apiKey: " " },
    { ...runtimeConfig(), instanceId: " " },
    { ...runtimeConfig(), writeTimeoutMs: 0 },
    { ...runtimeConfig(), readTimeoutMs: 1.5 },
  ]) {
    await assert.rejects(createXmemoryMemory({ snapshots: false }, config, dependencies), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      return true;
    });
  }
  assert.equal(dependencyAccessed, false);
});

test("factory completes schema loading before reading the platform dependency", async () => {
  let platformAccessed = false;
  const dependencies = Object.defineProperty(
    { schemaPath: "src/memory/xmemory/missing-schema-for-ordering-test.xmd.yml" },
    "platform",
    {
      get: () => {
        platformAccessed = true;
        throw new Error("raw platform secret");
      },
    },
  );

  await assert.rejects(
    createXmemoryMemory({ snapshots: false }, runtimeConfig(), dependencies),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "protocol_error");
      assert.equal(error.operation, "schema");
      assertSecretAbsent(error, "secret");
      return true;
    },
  );
  assert.equal(platformAccessed, false);
});

test("factory loads the committed schema and reads the live schema exactly once", async () => {
  const expected = await loadXmemorySchema();
  const timeouts: number[] = [];
  const platform = schemaPort(async (timeoutMs) => {
    timeouts.push(timeoutMs);
    return expected.value;
  });

  const memory = await createXmemoryMemory(
    { snapshots: false },
    { ...runtimeConfig(), apiKey: " key ", instanceId: " instance " },
    { platform },
  );
  assert.deepEqual(timeouts, [60_000]);
  assert.equal(typeof memory.recall, "function");
  assert.equal(typeof memory.remember, "function");
  assert.equal(typeof memory.snapshot, "function");
  assert.equal(typeof memory.restore, "function");
});

test("factory rejects exact schema drift after one live schema read", async () => {
  const expected = await loadXmemorySchema();
  let calls = 0;
  const platform = schemaPort(async () => {
    calls += 1;
    return { ...expected.value, title: "drift" };
  });

  await assert.rejects(
    createXmemoryMemory({ snapshots: false }, runtimeConfig(), { platform }),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "schema_mismatch");
      assert.equal(error.operation, "schema");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("factory sanitizes injected schema transport failure as non-retryable unavailable", async () => {
  const platform = schemaPort(async () => {
    throw new TypeError("raw transport secret");
  });
  await assert.rejects(
    createXmemoryMemory({ snapshots: false }, runtimeConfig(), { platform }),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unavailable");
      assert.equal(error.operation, "schema");
      assert.equal(error.retryable, false);
      assertSecretAbsent(error, "raw transport secret");
      return true;
    },
  );
});

test("factory preserves every allowed schema code and rejects foreign or wrong-operation codes", async () => {
  const allowed: XmemoryMemoryErrorCode[] = [
    "unsupported_configuration",
    "invalid_input",
    "authentication",
    "authorization",
    "instance_not_found",
    "rate_limited",
    "quota_exceeded",
    "unavailable",
    "protocol_error",
    "schema_mismatch",
  ];
  for (const code of allowed) {
    const platform = schemaPort(async () => {
      throw new XmemoryMemoryError(code, "schema", "raw schema secret");
    });
    await assert.rejects(
      createXmemoryMemory({ snapshots: false }, runtimeConfig(), { platform }),
      (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.equal(error.code, code);
        assert.equal(error.operation, "schema");
        assert.equal(error.retryable, false);
        assertSecretAbsent(error, "raw schema secret");
        return true;
      },
    );
  }

  for (const injected of [
    new XmemoryMemoryError("write_failed", "schema", "raw schema secret"),
    new XmemoryMemoryError("invalid_input", "read", "raw schema secret"),
  ]) {
    const platform = schemaPort(async () => { throw injected; });
    await assert.rejects(
      createXmemoryMemory({ snapshots: false }, runtimeConfig(), { platform }),
      (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.equal(error.code, "protocol_error");
        assert.equal(error.operation, "schema");
        assertSecretAbsent(error, "raw schema secret");
        return true;
      },
    );
  }
});

const traceId = "123e4567-e89b-12d3-a456-426614174000";
const emptyChanges = {
  created: { objects: [], relations: [] },
  updated: { objects: [], relations: [] },
  deleted: { objects: [], relations: [] },
};
const lesson = {
  content: "Yellow roadside posts can support an Iceland hypothesis.",
  sourceAttemptId: "attempt-1",
  triggers: ["yellow roadside posts"],
  region: "Iceland",
};

async function behaviorMemory(
  overrides: Partial<XmemoryPlatformPort> = {},
  dependencies: Omit<XmemoryMemoryDependencies, "platform"> = {},
) {
  const expected = await loadXmemorySchema();
  const platform: XmemoryPlatformPort = {
    getSchema: async () => expected.value,
    write: async () => { throw new Error("unexpected write"); },
    read: async () => { throw new Error("unexpected read"); },
    ...overrides,
  };
  return createXmemoryMemory(
    { snapshots: false },
    runtimeConfig(),
    { platform, createTraceId: () => traceId, ...dependencies },
  );
}

async function rejectsMemoryCode(
  promise: Promise<unknown>,
  code: XmemoryMemoryErrorCode,
  operation: "write" | "read" | "snapshot" | "restore",
  retryable = false,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    assertSecretAbsent(error, "raw-secret");
    return true;
  });
}

test("remember rejects lesson boundaries and sentinels before write", async () => {
  let writes = 0;
  const memory = await behaviorMemory({
    write: async () => {
      writes += 1;
      return { writeId: "write", traceId: null, changes: emptyChanges };
    },
  });
  const invalid = [
    { ...lesson, content: " " },
    { ...lesson, content: "x".repeat(50_001) },
    { ...lesson, content: "data <LOCI_bad>" },
    { ...lesson, sourceAttemptId: "" },
    { ...lesson, sourceAttemptId: "a".repeat(129) },
    { ...lesson, sourceAttemptId: "bad id" },
    { ...lesson, region: "x".repeat(257) },
    { ...lesson, region: "</loci_bad>" },
    { ...lesson, triggers: Array.from({ length: 65 }, (_, index) => `cue-${index}`) },
    { ...lesson, triggers: [" "] },
    { ...lesson, triggers: ["x".repeat(257)] },
    { ...lesson, triggers: ["<loci_bad>"] },
    { ...lesson, triggers: [42] as unknown as string[] },
  ];
  for (const value of invalid) {
    await rejectsMemoryCode(memory.remember(value), "invalid_input", "write");
  }
  await rejectsMemoryCode(
    memory.remember({ ...lesson, triggers: null as unknown as string[] }),
    "invalid_input",
    "write",
  );
  assert.equal(writes, 0);
});

test("remember sends the exact normalized envelope while preserving lesson content", async () => {
  const requests: unknown[] = [];
  const memory = await behaviorMemory({
    write: async (request) => {
      requests.push(request);
      return { writeId: "write-1", traceId: "trace-write", changes: emptyChanges };
    },
  });
  await memory.remember({
    content: "  Preserve these content bytes.  ",
    sourceAttemptId: " attempt:1 ",
    triggers: [" yellow post ", "yellow post", "lava  field"],
    region: " Iceland ",
  });
  assert.deepEqual(requests, [
    {
      text:
        "<loci_training_experience_v1>\n" +
        "<loci_provenance_v1>\n" +
        "source_attempt_id: attempt:1\n" +
        'region_json: "Iceland"\n' +
        'observed_triggers_json: ["yellow post","lava  field"]\n' +
        "</loci_provenance_v1>\n" +
        "<loci_lesson_v1>\n" +
        "  Preserve these content bytes.  \n" +
        "</loci_lesson_v1>\n" +
        "</loci_training_experience_v1>",
      extractionLogic: "deep",
      diffEngine: true,
      timeoutMs: 180_000,
    },
  ]);
});

test("remember accepts every exact inclusive lesson boundary", async () => {
  let request: Parameters<XmemoryPlatformPort["write"]>[0] | undefined;
  const memory = await behaviorMemory({
    write: async (value) => {
      request = value;
      return { writeId: "boundary-write", traceId: null, changes: emptyChanges };
    },
  });
  const sourceAttemptId = `a${"b".repeat(127)}`;
  const region = "r".repeat(256);
  const triggers = Array.from(
    { length: 64 },
    (_, index) => `${String(index).padStart(2, "0")}${"t".repeat(254)}`,
  );
  await memory.remember({
    content: "c".repeat(50_000),
    sourceAttemptId,
    region,
    triggers,
  });
  assert.ok(request !== undefined);
  assert.equal(sourceAttemptId.length, 128);
  assert.equal(region.length, 256);
  assert.equal(triggers.length, 64);
  assert.ok(triggers.every((trigger) => trigger.length === 256));
  assert.equal(request.extractionLogic, "deep");
  assert.equal(request.diffEngine, true);
  assert.equal(request.text.includes(`source_attempt_id: ${sourceAttemptId}`), true);
  assert.equal(request.text.includes(`region_json: ${JSON.stringify(region)}`), true);
  assert.equal(request.text.includes(`observed_triggers_json: ${JSON.stringify(triggers)}`), true);
});

test("remember accepts minimum source ID with empty region and trigger boundaries", async () => {
  const requests: Parameters<XmemoryPlatformPort["write"]>[0][] = [];
  const memory = await behaviorMemory({
    write: async (request) => {
      requests.push(request);
      return { writeId: "minimum-write", traceId: null, changes: emptyChanges };
    },
  });
  await memory.remember({ content: "x", sourceAttemptId: "A", region: "", triggers: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.text.includes("source_attempt_id: A\n"), true);
  assert.equal(requests[0]?.text.includes('region_json: ""\n'), true);
  assert.equal(requests[0]?.text.includes("observed_triggers_json: []\n"), true);
});

test("remember sanitizes hostile and revoked lesson inputs before write", async () => {
  let writes = 0;
  const memory = await behaviorMemory({
    write: async () => {
      writes += 1;
      return { writeId: "unexpected", traceId: null, changes: emptyChanges };
    },
  });
  const revoked = Proxy.revocable<typeof lesson>({ ...lesson }, {});
  revoked.revoke();
  const hostileLesson = new Proxy(
    { ...lesson },
    { get: () => { throw new Error("raw-secret hostile lesson"); } },
  );
  const hostileTriggers = new Proxy(["cue"], {
    get: () => { throw new Error("raw-secret hostile triggers"); },
  });
  for (const value of [
    revoked.proxy,
    hostileLesson,
    { ...lesson, triggers: hostileTriggers },
  ]) {
    await rejectsMemoryCode(memory.remember(value), "invalid_input", "write");
  }
  assert.equal(writes, 0);
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("remember performs FIFO writes and observes each validated success once", async () => {
  const first = deferred<{ writeId: string; traceId: string | null; changes: typeof emptyChanges }>();
  const second = deferred<{ writeId: string; traceId: string | null; changes: typeof emptyChanges }>();
  const calls: string[] = [];
  const observed: unknown[] = [];
  const memory = await behaviorMemory(
    {
      write: async (request) => {
        calls.push(request.text.includes("attempt-1") ? "first" : "second");
        return calls.length === 1 ? first.promise : second.promise;
      },
    },
    { onRememberCompleted: (result) => observed.push(result) },
  );

  const one = memory.remember(lesson);
  const two = memory.remember({ ...lesson, sourceAttemptId: "attempt-2" });
  assert.deepEqual(calls, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  first.resolve({ writeId: "write-1", traceId: null, changes: emptyChanges });
  await one;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first", "second"]);
  second.resolve({ writeId: "write-2", traceId: "trace-2", changes: emptyChanges });
  await two;
  assert.deepEqual(observed, [
    { sourceAttemptId: "attempt-1", writeId: "write-1", traceId: null, changes: emptyChanges },
    {
      sourceAttemptId: "attempt-2",
      writeId: "write-2",
      traceId: "trace-2",
      changes: emptyChanges,
    },
  ]);
});

test("definite write rejection matrix never retries or quarantines", async () => {
  const codes: XmemoryMemoryErrorCode[] = [
    "invalid_input",
    "authentication",
    "authorization",
    "instance_not_found",
    "rate_limited",
    "quota_exceeded",
    "write_failed",
  ];
  for (const code of codes) {
    let writes = 0;
    let quarantines = 0;
    const memory = await behaviorMemory(
      {
        write: async () => {
          writes += 1;
          throw new XmemoryMemoryError(code, "write", "raw-secret provider body");
        },
      },
      { onInstanceQuarantined: () => { quarantines += 1; } },
    );
    await rejectsMemoryCode(memory.remember(lesson), code, "write");
    assert.equal(writes, 1);
    assert.equal(quarantines, 0);
  }
});

test("ambiguous write and malformed success quarantine once and block later work", async () => {
  const scenarios: Array<() => Promise<unknown>> = [
    async () => { throw new TypeError("raw-secret transport"); },
    async () => { throw new XmemoryMemoryError("write_outcome_unknown", "write", "raw-secret"); },
    async () => { throw new XmemoryMemoryError("unavailable", "write", "raw-secret"); },
    async () => { throw new XmemoryMemoryError("invalid_input", "read", "raw-secret"); },
    async () => null,
    async () => ({ writeId: "", traceId: null, changes: emptyChanges }),
    async () => ({ writeId: "write", traceId: 1, changes: emptyChanges }),
    async () => ({ writeId: "write", traceId: null, changes: {} }),
  ];
  for (const write of scenarios) {
    let writes = 0;
    const quarantines: unknown[] = [];
    const memory = await behaviorMemory(
      { write: async () => { writes += 1; return write() as never; } },
      {
        onInstanceQuarantined: (result) => {
          quarantines.push(result);
          throw new Error("ignored quarantine observer failure");
        },
      },
    );
    await rejectsMemoryCode(memory.remember(lesson), "write_outcome_unknown", "write");
    await rejectsMemoryCode(
      memory.remember({ ...lesson, content: " " }),
      "instance_quarantined",
      "write",
    );
    await rejectsMemoryCode(memory.recall([], 0), "instance_quarantined", "read");
    assert.equal(writes, 1);
    assert.deepEqual(quarantines, [
      { instanceId: "runtime-instance", code: "write_outcome_unknown" },
    ]);
  }
});

test("an ambiguous FIFO head blocks already queued remembers without another write", async () => {
  const first = deferred<never>();
  let writes = 0;
  let quarantines = 0;
  const memory = await behaviorMemory(
    { write: async () => { writes += 1; return first.promise; } },
    { onInstanceQuarantined: () => { quarantines += 1; } },
  );
  const one = memory.remember(lesson);
  const two = memory.remember({ ...lesson, sourceAttemptId: "attempt-2" });
  await new Promise((resolve) => setImmediate(resolve));
  first.reject(new TypeError("ambiguous"));
  await rejectsMemoryCode(one, "write_outcome_unknown", "write");
  await rejectsMemoryCode(two, "instance_quarantined", "write");
  assert.equal(writes, 1);
  assert.equal(quarantines, 1);
});

test("remember observer failure is sanitized and leaves the adapter usable", async () => {
  let writes = 0;
  let observations = 0;
  let quarantines = 0;
  const memory = await behaviorMemory(
    {
      write: async () => {
        writes += 1;
        return { writeId: `write-${writes}`, traceId: null, changes: emptyChanges };
      },
    },
    {
      onRememberCompleted: () => {
        observations += 1;
        if (observations === 1) throw new Error("raw-secret observer");
      },
      onInstanceQuarantined: () => { quarantines += 1; },
    },
  );
  await rejectsMemoryCode(memory.remember(lesson), "observer_failed", "write");
  await memory.remember({ ...lesson, sourceAttemptId: "attempt-2" });
  assert.equal(writes, 2);
  assert.equal(observations, 2);
  assert.equal(quarantines, 0);
});

test("remember awaits an async observer before completing and advancing FIFO", async () => {
  const observerGate = deferred<void>();
  let writes = 0;
  let observations = 0;
  const memory = await behaviorMemory(
    {
      write: async () => {
        writes += 1;
        return { writeId: `write-${writes}`, traceId: null, changes: emptyChanges };
      },
    },
    {
      onRememberCompleted: () => {
        observations += 1;
        if (observations === 1) return observerGate.promise;
      },
    },
  );

  let firstSettled = false;
  const first = memory.remember(lesson);
  void first.then(() => { firstSettled = true; });
  const second = memory.remember({ ...lesson, sourceAttemptId: "attempt-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(firstSettled, false);
  observerGate.resolve();
  await first;
  await second;
  assert.equal(writes, 2);
  assert.equal(observations, 2);
});

test("async and hostile remember observer failures are handled and leave the adapter usable", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const failures: Array<() => unknown> = [
    () => Promise.reject(new Error("raw-secret async observer")),
    () => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error("raw-secret thenable")) }),
    () => revoked.proxy,
  ];
  for (const failure of failures) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let observations = 0;
      let quarantines = 0;
      const memory = await behaviorMemory(
        {
          write: async () => ({ writeId: "write", traceId: null, changes: emptyChanges }),
        },
        {
          onRememberCompleted: () => {
            observations += 1;
            if (observations === 1) return failure();
          },
          onInstanceQuarantined: () => { quarantines += 1; },
        },
      );
      await rejectsMemoryCode(memory.remember(lesson), "observer_failed", "write");
      await memory.remember({ ...lesson, sourceAttemptId: "attempt-2" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(quarantines, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("quarantine notification absorbs sync, async and hostile failures without delaying original error", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const notifications: Array<() => unknown> = [
    () => { throw new Error("raw-secret sync notification"); },
    () => Promise.reject(new Error("raw-secret async notification")),
    () => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error("raw-secret thenable")) }),
    () => revoked.proxy,
    () => ({ then: () => undefined }),
  ];

  for (const notification of notifications) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      const memory = await behaviorMemory(
        { write: async () => { throw new TypeError("raw-secret ambiguous write"); } },
        {
          onInstanceQuarantined: () => {
            calls += 1;
            return notification();
          },
        },
      );
      await assert.rejects(memory.remember(lesson), (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.equal(error.code, "write_outcome_unknown");
        assert.equal(error.message, "The xmemory write outcome is unknown");
        assert.equal("cause" in error, false);
        return true;
      });
      await rejectsMemoryCode(memory.remember(lesson), "instance_quarantined", "write");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("hostile platform write and read thenables are contained without unhandled rejections", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const failures: Array<{
    make: () => unknown;
    readCode: XmemoryMemoryErrorCode;
    readRetryable: boolean;
  }> = [
    {
      make: () => ({
        then: (_resolve: unknown, reject: (reason: unknown) => void) => {
          queueMicrotask(() => reject(new Error("raw-secret async thenable")));
        },
      }),
      readCode: "protocol_error",
      readRetryable: false,
    },
    {
      make: () => new Proxy({}, {
        get: () => { throw new Error("raw-secret hostile then getter"); },
      }),
      readCode: "protocol_error",
      readRetryable: false,
    },
    {
      make: () => revoked.proxy,
      readCode: "unavailable",
      readRetryable: true,
    },
  ];

  for (const failure of failures) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let writes = 0;
      const writeMemory = await behaviorMemory({
        write: () => {
          writes += 1;
          return failure.make() as ReturnType<XmemoryPlatformPort["write"]>;
        },
      });
      await rejectsMemoryCode(
        writeMemory.remember(lesson),
        "write_outcome_unknown",
        "write",
      );
      assert.equal(writes, 1);

      let reads = 0;
      const readMemory = await behaviorMemory({
        read: () => {
          reads += 1;
          return failure.make() as ReturnType<XmemoryPlatformPort["read"]>;
        },
      });
      await rejectsMemoryCode(
        readMemory.recall([], 5),
        failure.readCode,
        "read",
        failure.readRetryable,
      );
      assert.equal(reads, 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("recall validates limit before features and trace creation", async () => {
  let reads = 0;
  let traces = 0;
  const memory = await behaviorMemory(
    {
      read: async () => {
        reads += 1;
        return { traceId: null, readerResult: { answer: "" } };
      },
    },
    { createTraceId: () => { traces += 1; return traceId; } },
  );

  for (const limit of [0, 1_001, 1.5, Number.NaN]) {
    await rejectsMemoryCode(memory.recall(null as unknown as string[], limit), "invalid_input", "read");
  }
  assert.equal(traces, 0);

  const revokedFeatures = Proxy.revocable<string[]>(["cue"], {});
  revokedFeatures.revoke();
  const hostileFeatures = new Proxy(["cue"], {
    get: () => { throw new Error("raw-secret hostile features"); },
  });
  const invalidFeatures: unknown[] = [
    null,
    {},
    Array.from({ length: 65 }, (_, index) => `feature-${index}`),
    [42] as unknown as string[],
    ["x".repeat(257)],
    ["<LOCI_bad>"],
    revokedFeatures.proxy,
    hostileFeatures,
  ];
  for (const features of invalidFeatures) {
    await rejectsMemoryCode(
      memory.recall(features as string[], 1),
      "invalid_input",
      "read",
    );
  }
  assert.equal(traces, 0);
  assert.equal(reads, 0);
});

test("recall sends exact normalized feature and prior templates", async () => {
  const requests: unknown[] = [];
  const memory = await behaviorMemory({
    read: async (request) => {
      requests.push(request);
      return { traceId: request.traceId, readerResult: { answer: " " } };
    },
  });

  assert.deepEqual(
    await memory.recall(["  yellow\troadside\nposts ", "yellow roadside posts", "", " lava field "], 5),
    [],
  );
  assert.deepEqual(await memory.recall([" ", "\n"], 7), []);
  assert.deepEqual(requests, [
    {
      query:
        "Use only stored Loci Insights to help interpret a new photograph.\n" +
        "Visible features:\n" +
        "- yellow roadside posts\n" +
        "- lava field\n" +
        "Return at most 5 distinct grounded insights. Preserve conditions, counter-signals,\n" +
        "comparisons and caveats. Do not invent observations or claim a final location.",
      readMode: "single-answer",
      traceId,
      timeoutMs: 60_000,
    },
    {
      query:
        "Return at most 7 high-value stored Loci Insights that are broadly useful before any visual\n" +
        "features are available. Preserve conditions, counter-signals, comparisons and caveats. Do not\n" +
        "invent observations or claim a final location.",
      readMode: "single-answer",
      traceId,
      timeoutMs: 60_000,
    },
  ]);
});

test("recall accepts 64 distinct features at the exact 256-code-unit boundary", async () => {
  let request: Parameters<XmemoryPlatformPort["read"]>[0] | undefined;
  const memory = await behaviorMemory({
    read: async (value) => {
      request = value;
      return { traceId: null, readerResult: { answer: "" } };
    },
  });
  const features = Array.from(
    { length: 64 },
    (_, index) => `${String(index).padStart(2, "0")}${"f".repeat(254)}`,
  );
  assert.deepEqual(await memory.recall(features, 1), []);
  assert.ok(request !== undefined);
  assert.equal(features.length, 64);
  assert.ok(features.every((feature) => feature.length === 256));
  assert.equal(request.query.split("\n").filter((line) => line.startsWith("- ")).length, 64);
  assert.equal(request.query.includes(`- ${features[0]}`), true);
  assert.equal(request.query.includes(`- ${features[63]}`), true);
});

test("recall accepts provider trace metadata and maps blank or non-empty answer to at most one Hint", async () => {
  for (const scenario of [
    {
      response: { traceId: null, readerResult: { answer: "  grounded insight  " } },
      expected: [{ lessonId: `xmemory-read:${traceId}`, text: "grounded insight" }],
    },
    {
      response: { traceId, readerResult: { answer: "\n\t" } },
      expected: [],
    },
    {
      response: { traceId: "provider-generated-trace", readerResult: { answer: "fact" } },
      expected: [{ lessonId: `xmemory-read:${traceId}`, text: "fact" }],
    },
  ]) {
    const memory = await behaviorMemory({ read: async () => scenario.response });
    assert.deepEqual(await memory.recall(["cue"], 1_000), scenario.expected);
  }

  const malformed: unknown[] = [
    null,
    {},
    { traceId: 1, readerResult: { answer: "fact" } },
    { traceId: null, readerResult: null },
    { traceId: null, readerResult: {} },
    { traceId: null, readerResult: { answer: 42 } },
  ];
  for (const response of malformed) {
    const memory = await behaviorMemory({ read: async () => response as never });
    await rejectsMemoryCode(memory.recall(["cue"], 5), "protocol_error", "read");
  }

  for (const invalidTrace of [
    "123E4567-E89B-12D3-A456-426614174000",
    "not-a-uuid",
    "",
  ]) {
    let reads = 0;
    const memory = await behaviorMemory(
      { read: async () => { reads += 1; return { traceId: null, readerResult: { answer: "" } }; } },
      { createTraceId: () => invalidTrace },
    );
    await rejectsMemoryCode(memory.recall([], 5), "protocol_error", "read");
    assert.equal(reads, 0);
  }
});

test("read errors never become empty recall and retryability is read-only", async () => {
  const codes: Array<{ code: XmemoryMemoryErrorCode; retryable: boolean }> = [
    { code: "invalid_input", retryable: false },
    { code: "authentication", retryable: false },
    { code: "authorization", retryable: false },
    { code: "instance_not_found", retryable: false },
    { code: "rate_limited", retryable: true },
    { code: "quota_exceeded", retryable: false },
    { code: "unavailable", retryable: true },
    { code: "protocol_error", retryable: false },
  ];
  for (const item of codes) {
    let reads = 0;
    const memory = await behaviorMemory({
      read: async () => {
        reads += 1;
        throw new XmemoryMemoryError(item.code, "read", "raw-secret provider body");
      },
    });
    await rejectsMemoryCode(memory.recall([], 5), item.code, "read", item.retryable);
    assert.equal(reads, 1);
  }

  for (const error of [
    new TypeError("raw-secret transport"),
    new XmemoryMemoryError("write_failed", "read", "raw-secret"),
    new XmemoryMemoryError("rate_limited", "write", "raw-secret"),
  ]) {
    const memory = await behaviorMemory({ read: async () => { throw error; } });
    await rejectsMemoryCode(
      memory.recall([], 5),
      error instanceof TypeError ? "unavailable" : "protocol_error",
      "read",
      error instanceof TypeError,
    );
  }
});

test("snapshot and restore reject exact promises without calls or quarantine changes", async () => {
  let reads = 0;
  let writes = 0;
  const memory = await behaviorMemory({
    read: async () => {
      reads += 1;
      return { traceId: null, readerResult: { answer: "" } };
    },
    write: async () => {
      writes += 1;
      return { writeId: "write", traceId: null, changes: emptyChanges };
    },
  });
  await assert.rejects(memory.snapshot(), (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, "unsupported_operation");
    assert.equal(error.operation, "snapshot");
    assert.equal(error.message, "XmemoryMemory does not support snapshot");
    return true;
  });

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  await assert.rejects(memory.restore(revoked.proxy as unknown as string), (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, "unsupported_operation");
    assert.equal(error.operation, "restore");
    assert.equal(error.message, "XmemoryMemory does not support restore");
    return true;
  });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(await memory.recall([], 5), []);
  await memory.remember(lesson);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test("snapshot and restore remain unsupported without clearing quarantine", async () => {
  let reads = 0;
  let writes = 0;
  const memory = await behaviorMemory({
    write: async () => {
      writes += 1;
      throw new TypeError("raw-secret ambiguous write");
    },
    read: async () => {
      reads += 1;
      return { traceId: null, readerResult: { answer: "" } };
    },
  });
  await rejectsMemoryCode(memory.remember(lesson), "write_outcome_unknown", "write");
  await rejectsMemoryCode(memory.snapshot(), "unsupported_operation", "snapshot");
  await rejectsMemoryCode(memory.restore("ignored"), "unsupported_operation", "restore");
  await rejectsMemoryCode(memory.recall([], 5), "instance_quarantined", "read");
  await rejectsMemoryCode(memory.remember(lesson), "instance_quarantined", "write");
  assert.equal(reads, 0);
  assert.equal(writes, 1);
});
