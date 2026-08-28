import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MEM0_CAPABILITIES,
  Mem0MemoryError,
  type Mem0MemoryErrorCode,
  loadMem0MemoryConfig,
} from "./memory.ts";
import { mem0IntegrationEnabled } from "./integration.ts";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function configEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MEM0_API_KEY: "test-api-key", MEM0_AGENT_ID: "test-agent", ...overrides };
}

test("mem0ai is pinned exactly in package.json and package-lock.json", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const dependencies = manifest.dependencies as Record<string, unknown>;
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  const rootDependencies = packages[""]?.dependencies as Record<string, unknown>;

  assert.equal(dependencies.mem0ai, "3.1.7");
  assert.equal(rootDependencies.mem0ai, "3.1.7");
  assert.equal(packages["node_modules/mem0ai"]?.version, "3.1.7");
});

test("config loader applies defaults and trims required identifiers", () => {
  assert.deepEqual(
    loadMem0MemoryConfig({ MEM0_API_KEY: " key ", MEM0_AGENT_ID: " agent " }),
    {
      apiKey: "key",
      agentId: "agent",
      ingestionTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
    },
  );
  assert.deepEqual(
    loadMem0MemoryConfig(
      configEnv({ MEM0_INGESTION_TIMEOUT_MS: "9000", MEM0_POLL_INTERVAL_MS: "250" }),
    ),
    {
      apiKey: "test-api-key",
      agentId: "test-agent",
      ingestionTimeoutMs: 9_000,
      pollIntervalMs: 250,
    },
  );
});

test("config loader rejects missing credentials and invalid timing without echoing values", () => {
  const invalid: NodeJS.ProcessEnv[] = [
    { MEM0_AGENT_ID: "agent" },
    { MEM0_API_KEY: "secret" },
    { MEM0_API_KEY: "   ", MEM0_AGENT_ID: "agent" },
    { MEM0_API_KEY: "secret", MEM0_AGENT_ID: "   " },
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: "0" }),
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: "1.5" }),
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: " 1000" }),
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: "9007199254740992" }),
    configEnv({ MEM0_POLL_INTERVAL_MS: "-1" }),
    configEnv({ MEM0_POLL_INTERVAL_MS: "NaN" }),
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: "1000", MEM0_POLL_INTERVAL_MS: "1000" }),
    configEnv({ MEM0_INGESTION_TIMEOUT_MS: "999", MEM0_POLL_INTERVAL_MS: "1000" }),
  ];

  for (const env of invalid) {
    assert.throws(
      () => loadMem0MemoryConfig(env),
      (error) => {
        assert.ok(error instanceof Mem0MemoryError);
        assert.equal(error.code, "unsupported_configuration");
        assert.equal(error.retryable, false);
        assert.equal(error.message.includes("secret"), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
});

test("real .env is ignored and Cloud integration requires exact opt-in", () => {
  assert.equal(spawnSync("git", ["check-ignore", "-q", ".env"]).status, 0);
  assert.notEqual(spawnSync("git", ["check-ignore", "-q", ".env.example"]).status, 0);
  assert.equal(mem0IntegrationEnabled({}), false);
  assert.equal(mem0IntegrationEnabled({ MEM0_INTEGRATION: "0" }), false);
  assert.equal(mem0IntegrationEnabled({ MEM0_INTEGRATION: "true" }), false);
  assert.equal(mem0IntegrationEnabled({ MEM0_INTEGRATION: "1" }), true);
});

test("capabilities and Phase-1 error retry policy are closed by default", () => {
  assert.deepEqual(MEM0_CAPABILITIES, { snapshot: false, restore: false });

  const codes: Mem0MemoryErrorCode[] = [
    "unsupported_operation",
    "unsupported_configuration",
    "invalid_input",
    "authentication",
    "authorization",
    "rate_limited",
    "quota_exceeded",
    "unavailable",
    "ingestion_failed",
    "ingestion_outcome_unknown",
    "observer_failed",
    "protocol_error",
    "instance_quarantined",
  ];
  for (const code of codes) {
    const defaultError = new Mem0MemoryError(code, "sanitized");
    assert.equal(defaultError.retryable, false);
    assert.equal("cause" in defaultError, false);

    const transientError = new Mem0MemoryError(code, "sanitized", {
      context: "transient_operation",
    });
    assert.equal(transientError.retryable, code === "rate_limited" || code === "unavailable");
  }
});
