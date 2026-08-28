import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { XmemoryMemoryError, type XmemoryMemoryErrorCode } from "./error.ts";
import type { XmemoryAdminPort } from "./platform-contract.ts";
import {
  loadXmemoryProvisionConfig,
  provisionXmemoryInstance,
  runXmemoryProvisionCli,
} from "./provision.ts";
import { loadXmemorySchema } from "./schema.ts";

function unexpected(name: string): never {
  throw new Error(`unexpected ${name} call`);
}

function admin(overrides: Partial<XmemoryAdminPort> = {}): XmemoryAdminPort {
  return {
    getCluster: async () => unexpected("getCluster"),
    listInstances: async () => unexpected("listInstances"),
    createInstance: async () => unexpected("createInstance"),
    getSchema: async () => unexpected("getSchema"),
    ...overrides,
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XMEM_ADMIN_API_KEY: "admin-key",
    XMEM_CLUSTER_ID: "cluster-1",
    XMEM_INSTANCE_NAME: "loci-pilot-1",
    ...overrides,
  };
}

function assertSanitized(error: XmemoryMemoryError, forbidden = "raw-secret"): void {
  assert.equal(error.operation, "provision");
  assert.equal(error.retryable, false);
  assert.equal("cause" in error, false);
  for (const visible of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
    assert.equal(visible.includes(forbidden), false);
  }
}

const allErrorCodes: readonly XmemoryMemoryErrorCode[] = [
  "unsupported_operation",
  "unsupported_configuration",
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "write_failed",
  "write_outcome_unknown",
  "observer_failed",
  "protocol_error",
  "schema_mismatch",
  "provisioning_conflict",
  "provision_outcome_unknown",
  "instance_quarantined",
];

async function rejectsProvisionCode(
  promise: Promise<unknown>,
  code: XmemoryMemoryErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, code);
    assertSanitized(error);
    return true;
  });
}

test("provision config reads only admin variables, trims them and validates the exact name policy", () => {
  assert.deepEqual(
    loadXmemoryProvisionConfig({
      XMEM_ADMIN_API_KEY: " admin-key ",
      XMEM_CLUSTER_ID: " cluster-1 ",
      XMEM_INSTANCE_NAME: " Pilot_1 ",
      XMEM_API_KEY: "ignored-runtime-key",
      XMEM_INSTANCE_ID: "ignored-runtime-instance",
    }),
    { adminApiKey: "admin-key", clusterId: "cluster-1", instanceName: "Pilot_1" },
  );
  for (const instanceName of ["A", "A._-9", `a${"b".repeat(99)}`]) {
    assert.equal(
      loadXmemoryProvisionConfig(env({ XMEM_INSTANCE_NAME: ` ${instanceName} ` })).instanceName,
      instanceName,
    );
  }

  const invalid: NodeJS.ProcessEnv[] = [
    {},
    env({ XMEM_ADMIN_API_KEY: " " }),
    env({ XMEM_CLUSTER_ID: " " }),
    env({ XMEM_INSTANCE_NAME: " " }),
    env({ XMEM_INSTANCE_NAME: "-starts-with-dash" }),
    env({ XMEM_INSTANCE_NAME: "_starts-with-underscore" }),
    env({ XMEM_INSTANCE_NAME: "contains space" }),
    env({ XMEM_INSTANCE_NAME: `a${"b".repeat(100)}` }),
  ];
  for (const value of invalid) {
    assert.throws(() => loadXmemoryProvisionConfig(value), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSanitized(error, "admin-key");
      return true;
    });
  }
});

test("provision config sanitizes hostile and revoked environments", () => {
  const revoked = Proxy.revocable<NodeJS.ProcessEnv>({}, {});
  revoked.revoke();
  const hostile = new Proxy<NodeJS.ProcessEnv>({}, {
    get: () => { throw new Error("raw-secret environment"); },
  });

  for (const value of [revoked.proxy, hostile]) {
    assert.throws(() => loadXmemoryProvisionConfig(value), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSanitized(error);
      return true;
    });
  }
});

test("invalid direct config rejects before schema/admin dependency access", async () => {
  let dependencyAccessed = false;
  const dependencies = Object.defineProperties({}, {
    admin: {
      get: () => {
        dependencyAccessed = true;
        throw new Error("raw-secret");
      },
    },
    loadSchema: {
      get: () => {
        dependencyAccessed = true;
        throw new Error("raw-secret");
      },
    },
  });
  await assert.rejects(
    provisionXmemoryInstance(
      { adminApiKey: "raw-secret", clusterId: "cluster", instanceName: "bad name" },
      dependencies,
    ),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assertSanitized(error);
      return true;
    },
  );
  assert.equal(dependencyAccessed, false);
});

test("preflight preserves only stage-allowed provision errors", async () => {
  const expected = await loadXmemorySchema();
  const allowed = new Set<XmemoryMemoryErrorCode>([
    "unsupported_configuration",
    "invalid_input",
    "authentication",
    "authorization",
    "instance_not_found",
    "rate_limited",
    "quota_exceeded",
    "unavailable",
    "protocol_error",
    "provisioning_conflict",
  ]);

  for (const code of allErrorCodes) {
    await rejectsProvisionCode(
      provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
        loadSchema: async () => expected,
        admin: admin({
          getCluster: async () => {
            throw new XmemoryMemoryError(code, "provision", "raw-secret provider body");
          },
        }),
      }),
      allowed.has(code) ? code : "protocol_error",
    );
    await rejectsProvisionCode(
      provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
        loadSchema: async () => expected,
        admin: admin({
          getCluster: async () => {
            throw new XmemoryMemoryError(code, "read", "raw-secret provider body");
          },
        }),
      }),
      "protocol_error",
    );
  }
});

test("create preserves only known rejections and maps all ambiguity to one retirement summary", async () => {
  const expected = await loadXmemorySchema();
  const knownRejections = new Set<XmemoryMemoryErrorCode>([
    "invalid_input",
    "authentication",
    "authorization",
    "instance_not_found",
    "rate_limited",
    "quota_exceeded",
    "provisioning_conflict",
  ]);

  for (const code of allErrorCodes) {
    const dependencies = {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id: string) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => {
          throw new XmemoryMemoryError(code, "provision", "raw-secret provider body");
        },
      }),
    };
    if (knownRejections.has(code)) {
      await rejectsProvisionCode(
        provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), dependencies),
        code,
      );
    } else {
      const result = await provisionXmemoryInstance(
        loadXmemoryProvisionConfig(env()),
        dependencies,
      );
      assert.deepEqual(result, {
        instanceId: null,
        instanceName: "loci-pilot-1",
        schemaSha256: expected.sha256,
        created: false,
        schemaVerified: false,
        instanceRetired: true,
        errorCode: "provision_outcome_unknown",
      });
    }

    const wrongOperation = await provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => {
          throw new XmemoryMemoryError(code, "read", "raw-secret provider body");
        },
      }),
    });
    assert.equal(wrongOperation.errorCode, "provision_outcome_unknown");
    assert.equal(wrongOperation.instanceRetired, true);
  }
});

test("post-create verification preserves only stage-allowed provision errors", async () => {
  const expected = await loadXmemorySchema();
  const allowed = new Set<XmemoryMemoryErrorCode>([
    "invalid_input",
    "authentication",
    "authorization",
    "instance_not_found",
    "rate_limited",
    "quota_exceeded",
    "unavailable",
    "protocol_error",
  ]);

  for (const code of allErrorCodes) {
    for (const operation of ["provision", "read"] as const) {
      const result = await provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
        loadSchema: async () => expected,
        admin: admin({
          getCluster: async (id) => ({ id }),
          listInstances: async () => [],
          createInstance: async () => ({ id: "created-matrix" }),
          getSchema: async () => {
            throw new XmemoryMemoryError(code, operation, "raw-secret provider body");
          },
        }),
      });
      assert.deepEqual(result, {
        instanceId: "created-matrix",
        instanceName: "loci-pilot-1",
        schemaSha256: expected.sha256,
        created: true,
        schemaVerified: false,
        instanceRetired: true,
        errorCode: operation === "provision" && allowed.has(code) ? code : "protocol_error",
      });
    }
  }
});

test("cluster and unique-name preflight use fixed timeouts and never create on failure", async () => {
  const expected = await loadXmemorySchema();
  const calls: unknown[] = [];
  const fake = admin({
    getCluster: async (clusterId, timeoutMs) => {
      calls.push(["cluster", clusterId, timeoutMs]);
      return { id: clusterId };
    },
    listInstances: async (timeoutMs) => {
      calls.push(["list", timeoutMs]);
      return [{ id: "existing", name: "loci-pilot-1" }];
    },
    createInstance: async () => {
      calls.push(["create"]);
      return { id: "unexpected" };
    },
  });

  await assert.rejects(
    provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      admin: fake,
      loadSchema: async () => expected,
    }),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "provisioning_conflict");
      assertSanitized(error);
      return true;
    },
  );
  assert.deepEqual(calls, [
    ["cluster", "cluster-1", 60_000],
    ["list", 60_000],
  ]);

  await assert.rejects(
    provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      admin: admin({ getCluster: async () => ({ id: "different-cluster" }) }),
      loadSchema: async () => expected,
    }),
    (error) => error instanceof XmemoryMemoryError && error.code === "protocol_error",
  );

  await assert.rejects(
    provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      admin: admin({ getCluster: async () => { throw new TypeError("raw-secret transport"); } }),
      loadSchema: async () => expected,
    }),
    (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "unavailable");
      assertSanitized(error);
      return true;
    },
  );
});

test("provisioner sends exact create input and verifies the created schema once", async () => {
  const expected = await loadXmemorySchema();
  const calls: unknown[] = [];
  const result = await provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
    loadSchema: async () => expected,
    admin: admin({
      getCluster: async (clusterId, timeoutMs) => {
        calls.push(["cluster", clusterId, timeoutMs]);
        return { id: clusterId };
      },
      listInstances: async (timeoutMs) => {
        calls.push(["list", timeoutMs]);
        return [{ id: "other", name: "other-pilot" }];
      },
      createInstance: async (request) => {
        calls.push(["create", request]);
        return { id: "created-1" };
      },
      getSchema: async (instanceId, timeoutMs) => {
        calls.push(["schema", instanceId, timeoutMs]);
        return expected.value;
      },
    }),
  });

  assert.deepEqual(result, {
    instanceId: "created-1",
    instanceName: "loci-pilot-1",
    schemaSha256: expected.sha256,
    created: true,
    schemaVerified: true,
    instanceRetired: false,
    errorCode: null,
  });
  assert.deepEqual(calls, [
    ["cluster", "cluster-1", 60_000],
    ["list", 60_000],
    [
      "create",
      {
        clusterId: "cluster-1",
        name: "loci-pilot-1",
        description: "Disposable Loci xmemory pilot",
        schemaYml: expected.source,
        timeoutMs: 60_000,
      },
    ],
    ["schema", "created-1", 60_000],
  ]);
});

test("post-create failure preserves ID and marks the instance retired", async () => {
  const expected = await loadXmemorySchema();
  for (const scenario of [
    {
      getSchema: async () => ({ ...expected.value, title: "drift" }),
      errorCode: "schema_mismatch",
    },
    {
      getSchema: async () => Promise.reject(
        new XmemoryMemoryError("authentication", "provision", "raw-secret"),
      ),
      errorCode: "authentication",
    },
  ] as const) {
    const result = await provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => ({ id: "created-1" }),
        getSchema: scenario.getSchema,
      }),
    });
    assert.deepEqual(result, {
      instanceId: "created-1",
      instanceName: "loci-pilot-1",
      schemaSha256: expected.sha256,
      created: true,
      schemaVerified: false,
      instanceRetired: true,
      errorCode: scenario.errorCode,
    });
  }
});

test("transport and malformed create outcomes have no ID and retire without retry", async () => {
  const expected = await loadXmemorySchema();
  for (const create of [
    async () => { throw new TypeError("raw-secret transport failure"); },
    async () => ({ id: " " }),
  ]) {
    let creates = 0;
    const result = await provisionXmemoryInstance(loadXmemoryProvisionConfig(env()), {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => {
          creates += 1;
          return create();
        },
      }),
    });
    assert.equal(creates, 1);
    assert.deepEqual(result, {
      instanceId: null,
      instanceName: "loci-pilot-1",
      schemaSha256: expected.sha256,
      created: false,
      schemaVerified: false,
      instanceRetired: true,
      errorCode: "provision_outcome_unknown",
    });
  }
});

test("CLI prints exactly one sanitized summary and returns a matching exit code", async () => {
  const output: string[] = [];
  const exitCode = await runXmemoryProvisionCli({
    env: { XMEM_ADMIN_API_KEY: "raw-secret" },
    writeStdout: (value) => output.push(value),
  });
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0] ?? ""), {
    instanceId: null,
    instanceName: null,
    schemaSha256: null,
    created: false,
    schemaVerified: false,
    instanceRetired: false,
    errorCode: "unsupported_configuration",
  });
  assert.equal(output[0]?.endsWith("\n"), true);
  assert.equal(output[0]?.includes("raw-secret"), false);

  const expected = await loadXmemorySchema();
  const postCreateOutput: string[] = [];
  const postCreateExit = await runXmemoryProvisionCli({
    env: env(),
    dependencies: {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => ({ id: "created-visible" }),
        getSchema: async () => Promise.reject(new Error("raw-secret provider body")),
      }),
    },
    writeStdout: (value) => postCreateOutput.push(value),
  });
  assert.equal(postCreateExit, 1);
  assert.equal(postCreateOutput.length, 1);
  assert.deepEqual(JSON.parse(postCreateOutput[0] ?? ""), {
    instanceId: "created-visible",
    instanceName: "loci-pilot-1",
    schemaSha256: expected.sha256,
    created: true,
    schemaVerified: false,
    instanceRetired: true,
    errorCode: "protocol_error",
  });
  assert.equal(postCreateOutput[0]?.includes("raw-secret"), false);

  const successOutput: string[] = [];
  const successExit = await runXmemoryProvisionCli({
    env: env(),
    dependencies: {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => ({ id: "created-success" }),
        getSchema: async () => expected.value,
      }),
    },
    writeStdout: (value) => successOutput.push(value),
  });
  assert.equal(successExit, 0);
  assert.equal(successOutput.length, 1);
  assert.deepEqual(JSON.parse(successOutput[0] ?? ""), {
    instanceId: "created-success",
    instanceName: "loci-pilot-1",
    schemaSha256: expected.sha256,
    created: true,
    schemaVerified: true,
    instanceRetired: false,
    errorCode: null,
  });

  const ambiguousOutput: string[] = [];
  const ambiguousExit = await runXmemoryProvisionCli({
    env: env(),
    dependencies: {
      loadSchema: async () => expected,
      admin: admin({
        getCluster: async (id) => ({ id }),
        listInstances: async () => [],
        createInstance: async () => Promise.reject(
          new TypeError("raw-secret provider body https://console.invalid"),
        ),
      }),
    },
    writeStdout: (value) => ambiguousOutput.push(value),
  });
  assert.equal(ambiguousExit, 1);
  assert.equal(ambiguousOutput.length, 1);
  assert.deepEqual(JSON.parse(ambiguousOutput[0] ?? ""), {
    instanceId: null,
    instanceName: "loci-pilot-1",
    schemaSha256: expected.sha256,
    created: false,
    schemaVerified: false,
    instanceRetired: true,
    errorCode: "provision_outcome_unknown",
  });

  for (const value of [...output, ...postCreateOutput, ...successOutput, ...ambiguousOutput]) {
    for (const forbidden of [
      "raw-secret",
      "provider body",
      "console.invalid",
      expected.source,
      JSON.stringify(expected.value),
    ]) {
      assert.equal(value.includes(forbidden), false);
    }
  }
});

test("CLI executable writes one stdout summary, no stderr and exits one on preflight failure", () => {
  const result = spawnSync(process.execPath, ["src/memory/xmemory/provision.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    instanceId: null,
    instanceName: null,
    schemaSha256: null,
    created: false,
    schemaVerified: false,
    instanceRetired: false,
    errorCode: "unsupported_configuration",
  });
});
