import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { XMEMORY_CAPABILITIES, XmemoryMemoryError, loadXmemoryMemoryConfig } from "./memory.ts";
import {
  loadXmemoryIntegrationConfig,
  xmemoryIntegrationEnabled,
} from "./integration.ts";
import { createXmemoryAdminPort, createXmemoryPlatformPort, XMEMORY_API_BASE_URL } from "./platform.ts";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
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
      assert.equal(JSON.stringify(error).includes("secret"), false);
      assert.equal("cause" in error, false);
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
    (error) => error instanceof XmemoryMemoryError && error.code === "unsupported_configuration",
  );
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
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    });
  }
});
