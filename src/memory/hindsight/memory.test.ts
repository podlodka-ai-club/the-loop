import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HINDSIGHT_CAPABILITIES,
  HINDSIGHT_DEFAULT_MAX_TOKENS,
  HINDSIGHT_DEFAULT_PRIOR_QUERY,
  HINDSIGHT_DEFAULT_READ_TIMEOUT_MS,
  HINDSIGHT_DEFAULT_RECALL_BUDGET,
  HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS,
  createHindsightMemory,
  loadHindsightMemoryConfig,
} from "./memory.ts";
import { HindsightMemoryError } from "./error.ts";
import { resolveHindsightMemorySource } from "./platform-contract.ts";

const source = resolveHindsightMemorySource({
  memoryRef: "memory/hindsight/integration",
  bankId: "bank-integration",
  purpose: "integration",
});

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
  assert.equal(config.priorQuery, HINDSIGHT_DEFAULT_PRIOR_QUERY);

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
    { ...config, priorQuery: "" },
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
