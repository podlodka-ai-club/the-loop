import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  XMEMORY_CAPABILITIES,
  XmemoryMemoryError,
  createXmemoryMemory,
  loadXmemoryMemoryConfig,
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
