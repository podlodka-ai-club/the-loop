import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { XmemoryMemoryError } from "./error.ts";
import { finalizeXmemoryPilot } from "./pilot-finalize.ts";
import type { XmemoryPilotSummary } from "./pilot.ts";

function summary(overrides: Partial<XmemoryPilotSummary> = {}): XmemoryPilotSummary {
  return {
    runId: "run-1",
    instanceId: "retired-instance",
    schemaSha256: "a".repeat(64),
    lessonManifestSha256: "b".repeat(64),
    queryManifestSha256: "c".repeat(64),
    startedAt: "2026-08-28T10:00:00.000Z",
    finishedAt: "2026-08-28T10:30:00.000Z",
    lessonCases: 30,
    sourceIdsPreserved: 30,
    lessonsWithGroundedInsight: 24,
    crossAttemptMerges: 0,
    forbiddenClaims: 0,
    queryCases: 30,
    queriesWithExpectedAnswer: 24,
    writeFailures: 0,
    recallFailures: 0,
    harnessFailures: 0,
    writeP95Ms: 180_000,
    readP95Ms: 60_000,
    aborted: false,
    instanceQuarantined: false,
    instanceRetired: true,
    passedWithoutQuota: true,
    ...overrides,
  };
}

const input = {
  providerCounterBefore: 1_000,
  providerCounterAfter: 11_000,
  counterBeforeCapturedAt: "2026-08-28T09:59:59.000Z",
  counterAfterCapturedAt: "2026-08-28T10:30:01.000Z",
  isolatedAccount: true as const,
};

test("finalizer copies provenance, computes delta and accepts exact quota/window boundaries", () => {
  const source = summary();
  const evidence = finalizeXmemoryPilot(source, input);
  assert.deepEqual(evidence, {
    ...source,
    providerCounterBefore: 1_000,
    providerCounterAfter: 11_000,
    providerTokens: 10_000,
    counterBeforeCapturedAt: input.counterBeforeCapturedAt,
    counterAfterCapturedAt: input.counterAfterCapturedAt,
    isolatedAccount: true,
    passed: true,
  });

  const equalWindow = finalizeXmemoryPilot(source, {
    ...input,
    counterBeforeCapturedAt: source.startedAt,
    counterAfterCapturedAt: source.finishedAt,
  });
  assert.equal(equalWindow.passed, true);
  assert.equal(
    finalizeXmemoryPilot(source, { ...input, providerCounterAfter: 11_001 }).passed,
    false,
  );
  assert.equal(
    finalizeXmemoryPilot(
      summary({ passedWithoutQuota: false, queriesWithExpectedAnswer: 23 }),
      input,
    ).passed,
    false,
  );
});

test("finalizer rejects unsafe counters, invalid windows and missing literal attestation", () => {
  const invalid = [
    { ...input, providerCounterBefore: -1 },
    { ...input, providerCounterAfter: 999 },
    { ...input, providerCounterAfter: 1.5 },
    { ...input, providerCounterAfter: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, counterBeforeCapturedAt: "not-iso" },
    { ...input, counterBeforeCapturedAt: "2026-08-28T10:00:01.000Z" },
    { ...input, counterAfterCapturedAt: "2026-08-28T10:29:59.000Z" },
    { ...input, isolatedAccount: false as true },
  ];
  for (const value of invalid) {
    assert.throws(() => finalizeXmemoryPilot(summary(), value), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "invalid_input");
      assert.equal(error.retryable, false);
      assert.equal("cause" in error, false);
      return true;
    });
  }

  for (const invalidSummary of [
    summary({ startedAt: "not-iso" }),
    summary({ finishedAt: "2026-08-28T09:00:00.000Z" }),
    summary({ lessonCases: 29 as 30 }),
    summary({ sourceIdsPreserved: -1 }),
    summary({ writeP95Ms: Number.NaN }),
    summary({ passedWithoutQuota: false }),
    summary({ schemaSha256: "A".repeat(64) }),
    summary({ lessonManifestSha256: "b".repeat(63) }),
    summary({ queryManifestSha256: `${"c".repeat(63)}!` }),
    summary({ sourceIdsPreserved: 31 }),
    summary({ lessonsWithGroundedInsight: 1.5 }),
    summary({ crossAttemptMerges: -1 }),
    summary({ forbiddenClaims: Number.MAX_SAFE_INTEGER + 1 }),
    summary({ queriesWithExpectedAnswer: 31 }),
    summary({ writeFailures: 31 }),
    summary({ recallFailures: -1 }),
    summary({ harnessFailures: 61 }),
    summary({ readP95Ms: -1 }),
  ]) {
    assert.throws(() => finalizeXmemoryPilot(invalidSummary, input), XmemoryMemoryError);
  }
});

test("finalizer rejects extra summary/input properties without leaking their values", () => {
  const extraSummary = {
    ...summary(),
    apiKey: "raw-secret-api-key",
    providerBody: "raw-secret-provider-body",
  } as XmemoryPilotSummary;
  const extraInput = {
    ...input,
    consoleUrl: "https://console.invalid/raw-secret",
  } as typeof input;
  const missingSummary = { ...summary() } as Partial<XmemoryPilotSummary>;
  delete missingSummary.runId;
  const missingInput = { ...input } as Partial<typeof input>;
  delete missingInput.isolatedAccount;

  for (const call of [
    () => finalizeXmemoryPilot(extraSummary, input),
    () => finalizeXmemoryPilot(summary(), extraInput),
    () => finalizeXmemoryPilot(missingSummary as XmemoryPilotSummary, input),
    () => finalizeXmemoryPilot(summary(), missingInput as typeof input),
  ]) {
    assert.throws(call, (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "invalid_input");
      assert.equal("cause" in error, false);
      for (const visible of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
        assert.equal(visible.includes("raw-secret"), false);
        assert.equal(visible.includes("console.invalid"), false);
      }
      return true;
    });
  }
});

test("finalizer snapshots Proxy data descriptors once and never invokes get traps", () => {
  const summaryReads = new Map<PropertyKey, number>();
  let summaryGets = 0;
  const summaryProxy = new Proxy(summary(), {
    get: () => {
      summaryGets += 1;
      throw new Error("raw-secret summary get");
    },
    getOwnPropertyDescriptor: (target, key) => {
      const reads = (summaryReads.get(key) ?? 0) + 1;
      summaryReads.set(key, reads);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor === undefined) return undefined;
      return {
        ...descriptor,
        value: reads === 1 ? descriptor.value : "raw-secret flipped summary value",
      };
    },
  });

  const inputReads = new Map<PropertyKey, number>();
  let inputGets = 0;
  const inputProxy = new Proxy(input, {
    get: () => {
      inputGets += 1;
      throw new Error("raw-secret input get");
    },
    getOwnPropertyDescriptor: (target, key) => {
      const reads = (inputReads.get(key) ?? 0) + 1;
      inputReads.set(key, reads);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor === undefined) return undefined;
      return {
        ...descriptor,
        value: reads === 1 ? descriptor.value : "raw-secret flipped input value",
      };
    },
  });

  const evidence = finalizeXmemoryPilot(summaryProxy, inputProxy);
  assert.equal(evidence.passed, true);
  assert.equal(summaryGets, 0);
  assert.equal(inputGets, 0);
  assert.ok([...summaryReads.values()].every((count) => count === 1));
  assert.ok([...inputReads.values()].every((count) => count === 1));
  assert.equal(JSON.stringify(evidence).includes("raw-secret"), false);
});

test("finalizer sanitizes throwing descriptor and revoked Proxies", () => {
  const descriptorError = new Error("raw-secret descriptor trap");
  const revoked = Proxy.revocable(summary(), {});
  revoked.revoke();
  const hostileDescriptor = new Proxy(summary(), {
    getOwnPropertyDescriptor: () => { throw descriptorError; },
  });
  for (const value of [revoked.proxy, hostileDescriptor]) {
    assert.throws(
      () => finalizeXmemoryPilot(value, input),
      (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.notEqual(error, descriptorError);
        assert.equal(error.code, "invalid_input");
        assert.equal("cause" in error, false);
        for (const visible of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
          assert.equal(visible.includes("raw-secret"), false);
          assert.equal(visible.includes("revoked"), false);
        }
        return true;
      },
    );
  }
});

test("finalizer executable emits exact success, quota-failure and sanitized invalid-input exits", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "xmemory-finalizer-cli-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "tmp"), { recursive: true });
  await writeFile(
    join(directory, "tmp", "xmemory-pilot-v1-summary.json"),
    `${JSON.stringify(summary())}\n`,
    "utf8",
  );
  const inputPath = join(directory, "counter.json");
  const script = resolve("src/memory/xmemory/pilot-finalize.ts");
  const execute = () => spawnSync(process.execPath, [script, inputPath], {
    cwd: directory,
    encoding: "utf8",
    env: {},
  });

  await writeFile(inputPath, `${JSON.stringify(input)}\n`, "utf8");
  const passing = execute();
  assert.equal(passing.status, 0);
  assert.equal(passing.stderr, "");
  assert.equal(passing.stdout.trimEnd().split("\n").length, 1);
  const passingEvidence = JSON.parse(passing.stdout) as Record<string, unknown>;
  assert.equal(passingEvidence.providerTokens, 10_000);
  assert.equal(passingEvidence.passed, true);

  await writeFile(
    inputPath,
    `${JSON.stringify({ ...input, providerCounterAfter: 11_001 })}\n`,
    "utf8",
  );
  const quotaFailure = execute();
  assert.equal(quotaFailure.status, 1);
  assert.equal(quotaFailure.stderr, "");
  assert.equal(quotaFailure.stdout.trimEnd().split("\n").length, 1);
  const quotaEvidence = JSON.parse(quotaFailure.stdout) as Record<string, unknown>;
  assert.equal(quotaEvidence.providerTokens, 10_001);
  assert.equal(quotaEvidence.passed, false);

  await writeFile(
    inputPath,
    '{"raw-secret":"https://console.invalid/provider-body"}\n',
    "utf8",
  );
  const invalid = execute();
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, "");
  assert.equal(invalid.stdout.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), { passed: false, errorCode: "invalid_input" });
  assert.equal(invalid.stdout.includes("raw-secret"), false);
  assert.equal(invalid.stdout.includes("console.invalid"), false);
  assert.equal(invalid.stdout.includes("provider-body"), false);
});
