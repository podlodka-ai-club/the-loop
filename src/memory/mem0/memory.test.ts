import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { MemoryWriteError } from "../memory.ts";
import type { LegacyMemory, LessonInput, MemoryWriteErrorCode } from "../memory.ts";
import { MEM0_EXTRACTION_INSTRUCTION } from "./constants.ts";
import {
  MEM0_CAPABILITIES,
  Mem0MemoryError,
  type Mem0MemoryErrorCode,
  createMem0Memory,
  loadMem0MemoryConfig,
} from "./memory.ts";
import { mem0IntegrationEnabled } from "./integration.ts";
import type { Mem0PlatformPort } from "./platform.ts";

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

const lesson: LessonInput = {
  content: "Yellow roadside posts can support an Iceland hypothesis.",
  sourceAttemptId: "attempt-1",
  featureKey: "bollards_and_barriers",
  memoryHitId: "attempt-1/bollards_and_barriers/hit",
  effect: "helped",
  triggers: ["yellow roadside posts"],
  region: "Iceland",
  idempotencyKey: "attempt-1:bollards_and_barriers:hit",
};

function unexpected(name: string): never {
  throw new Error(`unexpected ${name} call`);
}

function memoryPort(overrides: Partial<Mem0PlatformPort> = {}): Mem0PlatformPort {
  return {
    add: async () => unexpected("add"),
    getEvent: async () => unexpected("getEvent"),
    get: async () => unexpected("get"),
    list: async () => [],
    search: async () => unexpected("search"),
    ...overrides,
  };
}

function adapter(
  platform: Mem0PlatformPort,
  options: {
    timeout?: number;
    interval?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    observer?: (result: { sourceAttemptId: string; memoryIds: string[] }) => void;
  } = {},
) {
  return createMem0Memory(
    { snapshots: false },
    {
      apiKey: "test-api-key",
      agentId: "agent-1",
      ingestionTimeoutMs: options.timeout ?? 100,
      pollIntervalMs: options.interval ?? 10,
    },
    {
      platform,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.observer === undefined ? {} : { onRememberCompleted: options.observer }),
    },
  );
}

async function rejectsCode(
  promise: Promise<unknown>,
  code: Mem0MemoryErrorCode,
  options: { retryable?: boolean; eventId?: string; forbidden?: string[] } = {},
): Promise<void> {
  await assert.rejects(promise, (error) => {
    if (error instanceof MemoryWriteError) {
      const expected: MemoryWriteErrorCode =
        code === "ingestion_outcome_unknown" ? "write_outcome_unknown" : "write_failed";
      assert.equal(error.code, expected);
      return true;
    }
    assert.ok(error instanceof Mem0MemoryError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, options.retryable ?? false);
    if (options.eventId !== undefined) assert.equal(error.eventId, options.eventId);
    for (const value of options.forbidden ?? []) {
      assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(value), false);
    }
    assert.equal("cause" in error, false);
    return true;
  });
}

test("remember validates before calls and sends the exact scoped add payload", async () => {
  const requests: unknown[] = [];
  const platform = memoryPort({
    add: async (request) => {
      requests.push(request);
      return { eventId: "event-1", status: "PENDING" };
    },
    getEvent: async () => ({ eventId: "event-1", status: "SUCCEEDED", memoryIds: [] }),
  });
  const memory = adapter(platform);

  await rejectsCode(memory.remember({ ...lesson, content: " " }), "invalid_input");
  await rejectsCode(memory.remember({ ...lesson, sourceAttemptId: "" }), "invalid_input");
  assert.equal(requests.length, 0);

  await memory.remember({ ...lesson, triggers: [], region: "" });
  assert.deepEqual(requests, [
    {
      messages: [{ role: "assistant", content: lesson.content }],
      agentId: "agent-1",
      infer: true,
      temporalReasoning: false,
      agentCustomInstructions: MEM0_EXTRACTION_INSTRUCTION,
      metadata: {
        loci_source_attempt_id: lesson.sourceAttemptId,
        loci_triggers: [],
        loci_region: "",
        loci_feature_key: lesson.featureKey,
        loci_memory_hit_id: lesson.memoryHitId,
        loci_effect: lesson.effect,
        loci_idempotency_key: lesson.idempotencyKey,
      },
    },
  ]);
});

test("remember prefixes non-helped content and duplicate idempotency returns existing id without another add", async () => {
  const requests: unknown[] = [];
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      add: async (request) => {
        invocations.push("add");
        requests.push(request);
        return { eventId: "event-negative", status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        return { eventId, status: "SUCCEEDED", memoryIds: ["memory-negative"] };
      },
      get: async (memoryId) => {
        invocations.push(`get:${memoryId}`);
        return { id: memoryId, memory: "stored", metadata: {} };
      },
    }),
  );
  const negative: LessonInput = {
    ...lesson,
    effect: "misleading",
    content: "Single yellow center lines were too broad for this road type.",
    idempotencyKey: "attempt-1:bollards_and_barriers:negative",
  };

  assert.deepEqual(await memory.remember(negative), {
    status: "stored",
    lessonId: "memory-negative",
  });
  assert.deepEqual(await memory.remember(negative), {
    status: "already_stored",
    lessonId: "memory-negative",
  });
  assert.deepEqual(invocations, ["add", "getEvent:event-negative", "get:memory-negative"]);
  assert.deepEqual(requests, [
    {
      messages: [
        {
          role: "assistant",
          content: "[effect=misleading] Single yellow center lines were too broad for this road type.",
        },
      ],
      agentId: "agent-1",
      infer: true,
      temporalReasoning: false,
      agentCustomInstructions: MEM0_EXTRACTION_INSTRUCTION,
      metadata: {
        loci_source_attempt_id: negative.sourceAttemptId,
        loci_triggers: negative.triggers,
        loci_region: negative.region,
        loci_feature_key: negative.featureKey,
        loci_memory_hit_id: negative.memoryHitId,
        loci_effect: "misleading",
        loci_idempotency_key: negative.idempotencyKey,
      },
    },
  ]);
});

test("remember duplicate idempotency survives a new adapter instance through provider metadata", async () => {
  const requests: unknown[] = [];
  const records: Array<{ id: string; memory: string; metadata: Record<string, unknown> }> = [];
  const platform = memoryPort({
    list: async () => records,
    add: async (request) => {
      requests.push(request);
      records.push({
        id: "memory-cross-instance",
        memory: request.messages[0]?.content ?? "",
        metadata: request.metadata,
      });
      return { eventId: "event-cross-instance", status: "PENDING" };
    },
    getEvent: async (eventId) => ({ eventId, status: "SUCCEEDED", memoryIds: ["memory-cross-instance"] }),
    get: async (memoryId) => records.find((record) => record.id === memoryId) ?? null,
  });

  assert.deepEqual(await adapter(platform).remember(lesson), {
    status: "stored",
    lessonId: "memory-cross-instance",
  });
  assert.deepEqual(await adapter(platform).remember(lesson), {
    status: "already_stored",
    lessonId: "memory-cross-instance",
  });
  assert.equal(requests.length, 1);
  assert.equal(records[0]?.metadata.loci_idempotency_key, lesson.idempotencyKey);
});

test("remember rejects every malformed lesson before any platform call", async () => {
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        return { eventId: "event", status: "PENDING" };
      },
      getEvent: async () => {
        invocations.push("getEvent");
        return { eventId: "event", status: "SUCCEEDED", memoryIds: [] };
      },
    }),
  );
  const malformed: unknown[] = [
    null,
    [],
    {},
    { ...lesson, content: 1 },
    { ...lesson, content: "\t" },
    { ...lesson, sourceAttemptId: 1 },
    { ...lesson, sourceAttemptId: "  " },
    { ...lesson, triggers: null },
    { ...lesson, triggers: ["valid", 1] },
    { ...lesson, region: null },
    { ...lesson, memory_ref: "foreign" },
  ];

  for (const value of malformed) {
    await rejectsCode(memory.remember(value as LessonInput), "invalid_input");
  }
  assert.deepEqual(invocations, []);
});

test("remember starts its absolute deadline immediately before add", async () => {
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        return { eventId: "event", status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        return { eventId, status: "SUCCEEDED", memoryIds: [] };
      },
    }),
    {
      now: () => {
        invocations.push("now");
        return 0;
      },
      sleep: async (ms) => {
        invocations.push(`sleep:${ms}`);
      },
    },
  );

  await memory.remember(lesson);

  assert.deepEqual(invocations.slice(0, 3), ["now", "now", "add"]);
  assert.equal(invocations.filter((value) => value === "add").length, 1);
  assert.ok(invocations.indexOf("getEvent:event") > invocations.indexOf("add"));
  assert.equal(invocations.some((value) => value.startsWith("sleep:")), false);
});

test("remember polls PENDING/RUNNING and retries visibility with capped sleeps", async () => {
  let time = 0;
  const sleeps: number[] = [];
  const events = ["PENDING", "RUNNING", "SUCCEEDED"] as const;
  let eventIndex = 0;
  let getCalls = 0;
  const completed: unknown[] = [];
  const memory = adapter(
    memoryPort({
      add: async () => ({ eventId: "event-1", status: "PENDING" }),
      getEvent: async () => {
        const status = events[eventIndex];
        eventIndex += 1;
        return status === "SUCCEEDED"
          ? { eventId: "event-1", status, memoryIds: ["memory-1"] }
          : { eventId: "event-1", status: status ?? "PENDING" };
      },
      get: async () => {
        getCalls += 1;
        return getCalls === 1
          ? null
          : { id: "memory-1", memory: "fact", metadata: {} };
      },
    }),
    {
      timeout: 35,
      interval: 10,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      observer: (result) => completed.push(result),
    },
  );

  await memory.remember(lesson);
  assert.deepEqual(sleeps, [10, 10, 10]);
  assert.equal(getCalls, 2);
  assert.deepEqual(completed, [{ sourceAttemptId: "attempt-1", memoryIds: ["memory-1"] }]);
});

test("malformed add/event/IDs quarantine and block queued reads and writes before validation", async () => {
  let addCalls = 0;
  let eventCalls = 0;
  const memory = adapter(
    memoryPort({
      add: async () => {
        addCalls += 1;
        return { eventId: "event-1", status: "PENDING" };
      },
      getEvent: async () => {
        eventCalls += 1;
        return { eventId: "different-event", status: "SUCCEEDED", memoryIds: [] };
      },
    }),
  );

  await rejectsCode(memory.remember(lesson), "protocol_error");
  await rejectsCode(memory.remember({ ...lesson, content: "" }), "instance_quarantined");
  await rejectsCode(memory.recall([], 0), "instance_quarantined");
  assert.equal(addCalls, 1);
  assert.equal(eventCalls, 1);

  const badIds = adapter(
    memoryPort({
      add: async () => ({ eventId: "event-2", status: "PENDING" }),
      getEvent: async () => ({
        eventId: "event-2",
        status: "SUCCEEDED",
        memoryIds: ["duplicate", "duplicate"],
      }),
    }),
  );
  await rejectsCode(badIds.remember(lesson), "protocol_error");
});

test("quarantine is isolated to one adapter instance sharing the same platform scope", async () => {
  const invocations: string[] = [];
  const platform = memoryPort({
    add: async (request) => {
      const sourceAttemptId = request.metadata.loci_source_attempt_id;
      invocations.push(`add:${sourceAttemptId}`);
      if (sourceAttemptId === "bad") return { eventId: "", status: "PENDING" };
      return { eventId: `event-${sourceAttemptId}`, status: "PENDING" };
    },
    getEvent: async (eventId) => {
      invocations.push(`getEvent:${eventId}`);
      return { eventId, status: "SUCCEEDED", memoryIds: [] };
    },
    search: async () => {
      invocations.push("search");
      return [];
    },
  });
  const quarantined = adapter(platform);
  const healthy = adapter(platform);

  await rejectsCode(
    quarantined.remember({ ...lesson, sourceAttemptId: "bad" }),
    "protocol_error",
  );
  await rejectsCode(quarantined.recall([], 0), "instance_quarantined");
  await healthy.remember({ ...lesson, sourceAttemptId: "good" });

  assert.deepEqual(invocations, ["add:bad", "add:good", "getEvent:event-good"]);
});

test("FAILED and post-accept permanent errors quarantine; transient get errors retry", async () => {
  const failed = adapter(
    memoryPort({
      add: async () => ({ eventId: "event-failed", status: "PENDING" }),
      getEvent: async () => ({ eventId: "event-failed", status: "FAILED" }),
    }),
  );
  await rejectsCode(failed.remember(lesson), "ingestion_failed");
  await rejectsCode(failed.remember(lesson), "instance_quarantined");

  let time = 0;
  let getCalls = 0;
  const transient = adapter(
    memoryPort({
      add: async () => ({ eventId: "event-ok", status: "PENDING" }),
      getEvent: async () => ({ eventId: "event-ok", status: "SUCCEEDED", memoryIds: ["id"] }),
      get: async () => {
        getCalls += 1;
        if (getCalls === 1) {
          throw new Mem0MemoryError("unavailable", "raw provider body", {
            context: "transient_operation",
          });
        }
        return { id: "id", memory: "fact", metadata: {} };
      },
    }),
    { now: () => time, sleep: async (ms) => void (time += ms) },
  );
  await transient.remember(lesson);
  assert.equal(getCalls, 2);

  const denied = adapter(
    memoryPort({
      add: async () => ({ eventId: "event-denied", status: "PENDING" }),
      getEvent: async () => {
        throw new Mem0MemoryError("authentication", "raw provider body");
      },
    }),
  );
  await rejectsCode(denied.remember(lesson), "authentication");
  await rejectsCode(denied.remember(lesson), "instance_quarantined");
});

test("event and visibility retry every transient outcome inside the deadline", async () => {
  let time = 0;
  const invocations: string[] = [];
  const eventOutcomes: unknown[] = [
    new Mem0MemoryError("rate_limited", "raw event rate-limit"),
    new Mem0MemoryError("unavailable", "raw event unavailable"),
    { eventId: "event", status: "SUCCEEDED", memoryIds: ["memory"] },
  ];
  const getOutcomes: unknown[] = [
    null,
    new Mem0MemoryError("rate_limited", "raw get rate-limit"),
    new Mem0MemoryError("unavailable", "raw get unavailable"),
    { id: "memory", memory: "fact", metadata: {} },
  ];
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        return { eventId: "event", status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        const outcome = eventOutcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome as Awaited<ReturnType<Mem0PlatformPort["getEvent"]>>;
      },
      get: async (memoryId) => {
        invocations.push(`get:${memoryId}`);
        const outcome = getOutcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome as Awaited<ReturnType<Mem0PlatformPort["get"]>>;
      },
    }),
    {
      now: () => time,
      sleep: async (ms) => {
        invocations.push(`sleep:${ms}`);
        time += ms;
      },
    },
  );

  await memory.remember(lesson);

  assert.deepEqual(invocations, [
    "add",
    "getEvent:event",
    "sleep:10",
    "getEvent:event",
    "sleep:10",
    "getEvent:event",
    "get:memory",
    "sleep:10",
    "get:memory",
    "sleep:10",
    "get:memory",
    "sleep:10",
    "get:memory",
  ]);
});

test("post-accept permanent event and visibility failures quarantine immediately", async () => {
  const codes = ["authentication", "authorization", "quota_exceeded", "protocol_error"] as const;
  for (const stage of ["event", "get"] as const) {
    for (const code of codes) {
      const invocations: string[] = [];
      const raw = `raw ${stage} ${code} lesson payload`;
      const memory = adapter(
        memoryPort({
          add: async () => {
            invocations.push("add");
            return { eventId: "event", status: "PENDING" };
          },
          getEvent: async (eventId) => {
            invocations.push(`getEvent:${eventId}`);
            if (stage === "event") throw new Mem0MemoryError(code, raw);
            return { eventId, status: "SUCCEEDED", memoryIds: ["memory"] };
          },
          get: async (memoryId) => {
            invocations.push(`get:${memoryId}`);
            throw new Mem0MemoryError(code, raw);
          },
        }),
        {
          sleep: async (ms) => {
            invocations.push(`sleep:${ms}`);
          },
        },
      );

      await rejectsCode(memory.remember(lesson), code, {
        eventId: "event",
        forbidden: [raw, lesson.content],
      });
      await rejectsCode(memory.remember({ ...lesson, content: "" }), "instance_quarantined");
      assert.deepEqual(
        invocations,
        stage === "event" ? ["add", "getEvent:event"] : ["add", "getEvent:event", "get:memory"],
      );
    }
  }
});

test("pre-accept rate limit is retryable without automatic retry or quarantine", async () => {
  const invocations: string[] = [];
  const raw = "raw rate-limit response containing private lesson";
  const memory = adapter(
    memoryPort({
      add: async (request) => {
        invocations.push(`add:${request.metadata.loci_source_attempt_id}`);
        if (invocations.length === 1) throw new Mem0MemoryError("rate_limited", raw);
        return { eventId: "event", status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        return { eventId, status: "SUCCEEDED", memoryIds: [] };
      },
    }),
  );

  await rejectsCode(memory.remember({ ...lesson, sourceAttemptId: "first" }), "rate_limited", {
    retryable: true,
    forbidden: [raw, lesson.content],
  });
  assert.deepEqual(invocations, ["add:first"]);

  await memory.remember({ ...lesson, sourceAttemptId: "second" });
  assert.deepEqual(invocations, ["add:first", "add:second", "getEvent:event"]);
});

test("unknown add/deadline outcomes never retry add and quarantine the instance", async () => {
  let addCalls = 0;
  const unknownAdd = adapter(
    memoryPort({
      add: async () => {
        addCalls += 1;
        throw new Mem0MemoryError("unavailable", "raw lesson content", {
          context: "transient_operation",
        });
      },
    }),
  );
  await rejectsCode(unknownAdd.remember(lesson), "ingestion_outcome_unknown");
  await rejectsCode(unknownAdd.remember(lesson), "instance_quarantined");
  assert.equal(addCalls, 1);

  let addTime = 0;
  let lateEventCalls = 0;
  const lateAdd = adapter(
    memoryPort({
      add: async () => {
        addTime = 11;
        return { eventId: "late-event", status: "PENDING" };
      },
      getEvent: async () => {
        lateEventCalls += 1;
        return { eventId: "late-event", status: "SUCCEEDED", memoryIds: [] };
      },
    }),
    { timeout: 10, interval: 5, now: () => addTime },
  );
  await rejectsCode(lateAdd.remember(lesson), "ingestion_outcome_unknown");
  assert.equal(lateEventCalls, 0);

  let malformedTime = 0;
  const lateMalformedAdd = adapter(
    memoryPort({
      add: async () => {
        malformedTime = 11;
        return { eventId: "", status: "PENDING" };
      },
    }),
    { timeout: 10, interval: 5, now: () => malformedTime },
  );
  await rejectsCode(lateMalformedAdd.remember(lesson), "ingestion_outcome_unknown");
  await rejectsCode(lateMalformedAdd.remember(lesson), "instance_quarantined");

  let time = 0;
  const sleeps: number[] = [];
  const deadline = adapter(
    memoryPort({
      add: async () => ({ eventId: "event", status: "PENDING" }),
      getEvent: async () => ({ eventId: "event", status: "PENDING" }),
    }),
    {
      timeout: 10,
      interval: 6,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    },
  );
  await rejectsCode(deadline.remember(lesson), "ingestion_outcome_unknown");
  assert.deepEqual(sleeps, [6, 4]);
});

test("concurrent remembers execute FIFO and a first failure quarantines queued work", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const starts: string[] = [];
  const platform = memoryPort({
    add: async (request) => {
      starts.push(request.metadata.loci_source_attempt_id);
      if (starts.length === 1) await firstGate;
      return { eventId: `event-${starts.length}`, status: "PENDING" };
    },
    getEvent: async (eventId) => ({ eventId, status: "SUCCEEDED", memoryIds: [] }),
  });
  const memory = adapter(platform);
  const first = memory.remember({ ...lesson, sourceAttemptId: "first" });
  const second = memory.remember({
    ...lesson,
    sourceAttemptId: "second",
    idempotencyKey: "attempt-1:bollards_and_barriers:second",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["first"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["first", "second"]);

  let quarantiningCalls = 0;
  const quarantining = adapter(
    memoryPort({
      add: async () => {
        quarantiningCalls += 1;
        throw new TypeError("socket reset with raw lesson");
      },
    }),
  );
  const ambiguous = quarantining.remember(lesson);
  const queued = quarantining.remember(lesson);
  await rejectsCode(ambiguous, "ingestion_outcome_unknown");
  await rejectsCode(queued, "instance_quarantined");
  assert.equal(quarantiningCalls, 1);
});

test("observer fires after no-op/visibility and observer failure does not quarantine", async () => {
  const invocations: string[] = [];
  const observed: Array<{ sourceAttemptId: string; memoryIds: string[] }> = [];
  const raw = "raw observer lesson";
  let nextEvent = 1;
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        const eventId = `event-${nextEvent}`;
        nextEvent += 1;
        return { eventId, status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        return { eventId, status: "SUCCEEDED", memoryIds: [] };
      },
    }),
    {
      observer: (result) => {
        invocations.push(`observer:${result.sourceAttemptId}`);
        observed.push(result);
        if (observed.length === 1) throw new Error(raw);
      },
    },
  );

  await rejectsCode(memory.remember(lesson), "observer_failed", {
    forbidden: [raw, lesson.content],
  });
  await memory.remember(lesson);
  assert.deepEqual(invocations, [
    "add",
    "getEvent:event-1",
    "observer:attempt-1",
    "add",
    "getEvent:event-2",
    "observer:attempt-1",
  ]);
  assert.deepEqual(observed, [
    { sourceAttemptId: "attempt-1", memoryIds: [] },
    { sourceAttemptId: "attempt-1", memoryIds: [] },
  ]);
});

test("direct construction rejects invalid config before reading dependencies", () => {
  const invalidConfigs = [
    { apiKey: "", agentId: "agent", ingestionTimeoutMs: 10, pollIntervalMs: 1 },
    { apiKey: "key", agentId: " ", ingestionTimeoutMs: 10, pollIntervalMs: 1 },
    { apiKey: "key", agentId: "agent", ingestionTimeoutMs: 0, pollIntervalMs: 1 },
    { apiKey: "key", agentId: "agent", ingestionTimeoutMs: 1.5, pollIntervalMs: 1 },
    { apiKey: "key", agentId: "agent", ingestionTimeoutMs: 10, pollIntervalMs: 0 },
    { apiKey: "key", agentId: "agent", ingestionTimeoutMs: 10, pollIntervalMs: 10 },
  ];

  for (const config of invalidConfigs) {
    let platformReads = 0;
    const dependencies = Object.defineProperty({}, "platform", {
      get() {
        platformReads += 1;
        return memoryPort();
      },
    });
    assert.throws(
      () => createMem0Memory({ snapshots: false }, config, dependencies),
      (error) => {
        assert.ok(error instanceof Mem0MemoryError);
        assert.equal(error.code, "unsupported_configuration");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(platformReads, 0);
  }
});

test("never-settling add, event and get calls expire the absolute deadline", async () => {
  const stages = ["add", "event", "get"] as const;
  for (const stage of stages) {
    let addCalls = 0;
    let eventCalls = 0;
    let getCalls = 0;
    const pending = new Promise<never>(() => {});
    const memory = adapter(
      memoryPort({
        add: async () => {
          addCalls += 1;
          if (stage === "add") return pending;
          return { eventId: "event", status: "PENDING" };
        },
        getEvent: async () => {
          eventCalls += 1;
          if (stage === "event") return pending;
          return { eventId: "event", status: "SUCCEEDED", memoryIds: ["memory"] };
        },
        get: async () => {
          getCalls += 1;
          if (stage === "get") return pending;
          return { id: "memory", memory: "fact", metadata: {} };
        },
      }),
      { timeout: 25, interval: 1 },
    );

    await rejectsCode(memory.remember(lesson), "ingestion_outcome_unknown");
    await rejectsCode(memory.remember(lesson), "instance_quarantined");
    assert.equal(addCalls, 1);
    assert.equal(eventCalls, stage === "add" ? 0 : 1);
    assert.equal(getCalls, stage === "get" ? 1 : 0);
  }
});

test("synchronous provider prelude cannot extend the absolute deadline", async () => {
  let time = 0;
  let addCalls = 0;
  let eventCalls = 0;
  const pending = new Promise<never>(() => {});
  const memory = adapter(
    memoryPort({
      add: () => {
        addCalls += 1;
        time = 30;
        return pending;
      },
      getEvent: async () => {
        eventCalls += 1;
        return { eventId: "event", status: "SUCCEEDED", memoryIds: [] };
      },
    }),
    { timeout: 25, interval: 1, now: () => time },
  );

  await rejectsCode(memory.remember(lesson), "ingestion_outcome_unknown");
  await rejectsCode(memory.remember(lesson), "instance_quarantined");
  assert.equal(addCalls, 1);
  assert.equal(eventCalls, 0);
});

test("late add rejection and resolution are absorbed after timeout without retry or output", async () => {
  for (const outcome of ["reject", "resolve"] as const) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let addCalls = 0;
    let eventCalls = 0;
    try {
      const memory = adapter(
        memoryPort({
          add: () => {
            addCalls += 1;
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                if (outcome === "reject") reject(new Error("raw late provider payload"));
                else resolve({ eventId: "late-event", status: "PENDING" });
              }, 20);
            });
          },
          getEvent: async () => {
            eventCalls += 1;
            return { eventId: "late-event", status: "SUCCEEDED", memoryIds: [] };
          },
        }),
        { timeout: 5, interval: 1 },
      );

      await rejectsCode(memory.remember(lesson), "ingestion_outcome_unknown");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(addCalls, 1);
      assert.equal(eventCalls, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("malformed add, terminal IDs and visible record IDs fail closed", async () => {
  const malformedAdds: unknown[] = [
    null,
    [],
    {},
    { eventId: "", status: "PENDING" },
    { eventId: "   ", status: "PENDING" },
    { eventId: 1, status: "PENDING" },
    { eventId: "event", status: "pending" },
    { eventId: "event", status: "RUNNING" },
    { eventId: "event", status: "SUCCEEDED" },
    { eventId: "event", status: "FAILED" },
  ];
  for (const value of malformedAdds) {
    const invocations: string[] = [];
    const memory = adapter(
      memoryPort({
        add: async () => {
          invocations.push("add");
          return value as never;
        },
        getEvent: async () => {
          invocations.push("getEvent");
          return { eventId: "event", status: "SUCCEEDED", memoryIds: [] };
        },
      }),
    );
    await rejectsCode(memory.remember(lesson), "protocol_error");
    await rejectsCode(memory.remember(lesson), "instance_quarantined");
    assert.deepEqual(invocations, ["add"]);
  }

  const malformedIds: unknown[] = [
    { eventId: "event", status: "SUCCEEDED" },
    { eventId: "event", status: "SUCCEEDED", memoryIds: null },
    { eventId: "event", status: "SUCCEEDED", memoryIds: {} },
    { eventId: "event", status: "SUCCEEDED", memoryIds: [""] },
    { eventId: "event", status: "SUCCEEDED", memoryIds: ["   "] },
    { eventId: "event", status: "SUCCEEDED", memoryIds: [1] },
    { eventId: "event", status: "SUCCEEDED", memoryIds: [null] },
    { eventId: "event", status: "SUCCEEDED", memoryIds: ["same", "same"] },
    { eventId: "event", status: "UNKNOWN", memoryIds: [] },
  ];
  for (const terminal of malformedIds) {
    const invocations: string[] = [];
    const memory = adapter(
      memoryPort({
        add: async () => {
          invocations.push("add");
          return { eventId: "event", status: "PENDING" };
        },
        getEvent: async () => {
          invocations.push("getEvent:event");
          return terminal as never;
        },
      }),
    );
    await rejectsCode(memory.remember(lesson), "protocol_error", { eventId: "event" });
    await rejectsCode(memory.remember(lesson), "instance_quarantined");
    assert.deepEqual(invocations, ["add", "getEvent:event"]);
  }

  const mismatchedRecord = adapter(
    memoryPort({
      add: async () => ({ eventId: "event", status: "PENDING" }),
      getEvent: async () => ({ eventId: "event", status: "SUCCEEDED", memoryIds: ["expected"] }),
      get: async () => ({ id: "different", memory: "fact", metadata: {} }),
    }),
  );
  await rejectsCode(mismatchedRecord.remember(lesson), "protocol_error");
  await rejectsCode(mismatchedRecord.remember(lesson), "instance_quarantined");
});

test("snapshot requirement fails before config validation or dependency access", () => {
  let platformReads = 0;
  const dependencies = Object.defineProperty({}, "platform", {
    get() {
      platformReads += 1;
      return memoryPort();
    },
  });

  assert.throws(
    () =>
      createMem0Memory(
        { snapshots: true },
        { apiKey: "", agentId: "", ingestionTimeoutMs: 0, pollIntervalMs: 0 },
        dependencies,
      ),
    (error) => {
      assert.ok(error instanceof Mem0MemoryError);
      assert.equal(error.code, "unsupported_configuration");
      assert.equal(error.retryable, false);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.equal(platformReads, 0);
  assert.deepEqual(MEM0_CAPABILITIES, { snapshot: false, restore: false });
});

test("recall validates quarantine and limit before feature normalization", async () => {
  let searchCalls = 0;
  const platform = memoryPort({
    search: async () => {
      searchCalls += 1;
      return [];
    },
  });
  const memory = adapter(platform);
  const explodingFeatures = new Proxy(["feature"], {
    get() {
      throw new Error("feature normalization must not run");
    },
  });

  const invalidLimits: unknown[] = [
    undefined,
    null,
    "1",
    0,
    -1,
    1.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    1_001,
  ];
  for (const limit of invalidLimits) {
    await rejectsCode(memory.recall(explodingFeatures, limit as number), "invalid_input");
  }
  assert.equal(searchCalls, 0);

  const quarantined = adapter(
    memoryPort({
      add: async () => {
        throw new TypeError("ambiguous add");
      },
      search: async () => {
        searchCalls += 1;
        return [];
      },
    }),
  );
  await rejectsCode(quarantined.remember(lesson), "ingestion_outcome_unknown");
  await rejectsCode(quarantined.recall(explodingFeatures, 0), "instance_quarantined");
  assert.equal(searchCalls, 0);
});

test("recall rejects malformed feature containers after valid limit without search", async () => {
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      search: async () => {
        invocations.push("search");
        return [];
      },
    }),
  );
  const malformedFeatures: unknown[] = [
    null,
    {},
    [null],
    ["valid", 1],
    ["valid", {}],
  ];

  for (const features of malformedFeatures) {
    await rejectsCode(memory.recall(features as string[], 1), "invalid_input");
  }

  assert.deepEqual(invocations, []);
});

test("recall accepts inclusive limit boundaries and valid empty provider results", async () => {
  const requests: unknown[] = [];
  const memory = adapter(
    memoryPort({
      search: async (request) => {
        requests.push(request);
        return [];
      },
    }),
  );

  assert.deepEqual(await memory.recall(["feature"], 1), []);
  assert.deepEqual(await memory.recall(["feature"], 1_000), []);
  assert.deepEqual(requests, [
    {
      query: "feature",
      filters: { agent_id: "agent-1" },
      topK: 1,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    },
    {
      query: "feature",
      filters: { agent_id: "agent-1" },
      topK: 1_000,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    },
  ]);
});

test("recall normalizes query, sends exact search policy, preserves order and slices", async () => {
  const requests: unknown[] = [];
  const memory = adapter(
    memoryPort({
      search: async (request) => {
        requests.push(request);
        return [
          { id: "memory-2", memory: "second", metadata: {} },
          { id: "memory-1", memory: "first", metadata: {} },
          { id: "memory-extra", memory: "extra", metadata: {} },
        ];
      },
    }),
  );
  const asMemory: LegacyMemory = memory;

  assert.deepEqual(await asMemory.recall(["  yellow posts ", "", " lava terrain  "], 2), [
    { lessonId: "memory-2", text: "second" },
    { lessonId: "memory-1", text: "first" },
  ]);
  assert.deepEqual(requests, [
    {
      query: "yellow posts\nlava terrain",
      filters: { agent_id: "agent-1" },
      topK: 2,
      threshold: 0.1,
      rerank: false,
      keywordSearch: true,
    },
  ]);

  assert.deepEqual(await asMemory.recall(["", "   "], 5), []);
  assert.equal(requests.length, 1);
});

test("recall preserves episode metadata and renders non-helped effect prefix exactly once", async () => {
  const memory = adapter(
    memoryPort({
      search: async () => [
        {
          id: "memory-1",
          memory: "Single yellow center lines were too broad.",
          metadata: {
            loci_feature_key: "road_markings",
            loci_effect: "misleading",
            loci_source_attempt_id: "attempt-1",
            loci_memory_hit_id: "attempt-1/road_markings/hit",
            loci_idempotency_key: "attempt-1:road_markings:hit",
          },
        },
        {
          id: "memory-2",
          memory: "[effect=insufficient] Wooden poles alone were not enough.",
          metadata: {
            loci_feature_key: "poles",
            loci_effect: "insufficient",
          },
        },
      ],
    }),
  );

  assert.deepEqual(await memory.recall(["road cues"], 5), [
    {
      lessonId: "memory-1",
      text: "[effect=misleading] Single yellow center lines were too broad.",
      featureKey: "road_markings",
      effect: "misleading",
    },
    {
      lessonId: "memory-2",
      text: "[effect=insufficient] Wooden poles alone were not enough.",
      featureKey: "poles",
      effect: "insufficient",
    },
  ]);
});

test("recall rejects malformed results and sanitizes provider failures", async () => {
  const malformed: unknown[] = [
    null,
    {},
    [null],
    [[]],
    [{}],
    [{ memory: "fact", metadata: {} }],
    [{ id: "memory", metadata: {} }],
    [{ id: "", memory: "fact", metadata: {} }],
    [{ id: "   ", memory: "fact", metadata: {} }],
    [{ id: "memory", memory: "", metadata: {} }],
    [{ id: "memory", memory: 42, metadata: {} }],
    [{ id: 42, memory: "fact", metadata: {} }],
    [
      { id: "memory", memory: "fact", metadata: {} },
      { id: "bad", memory: " ", metadata: {} },
    ],
  ];
  for (const result of malformed) {
    const memory = adapter(memoryPort({ search: async () => result as never }));
    await rejectsCode(memory.recall(["feature"], 1), "protocol_error");
  }

  const failures: Array<[unknown, Mem0MemoryErrorCode, boolean]> = [
    [new Mem0MemoryError("rate_limited", "raw query"), "rate_limited", true],
    [new Mem0MemoryError("unavailable", "raw query"), "unavailable", true],
    [new Mem0MemoryError("invalid_input", "raw query"), "invalid_input", false],
    [new Mem0MemoryError("authentication", "raw query"), "authentication", false],
    [new Mem0MemoryError("authorization", "raw query"), "authorization", false],
    [new Mem0MemoryError("quota_exceeded", "raw query"), "quota_exceeded", false],
    [new Mem0MemoryError("protocol_error", "raw query"), "protocol_error", false],
    [new Error("raw query"), "protocol_error", false],
  ];
  for (const [failure, code, retryable] of failures) {
    const memory = adapter(
      memoryPort({
        search: async () => Promise.reject(failure),
      }),
    );
    await assert.rejects(memory.recall(["private query"], 1), (error) => {
      assert.ok(error instanceof Mem0MemoryError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.message.includes("raw query"), false);
      assert.equal(error.message.includes("private query"), false);
      assert.equal("cause" in error, false);
      return true;
    });
  }
});

test("recall runs during ingestion and returns only provider-visible records", async () => {
  let releaseAdd: ((value: { eventId: string; status: "PENDING" }) => void) | undefined;
  const accepted = new Promise<{ eventId: string; status: "PENDING" }>((resolve) => {
    releaseAdd = resolve;
  });
  const invocations: unknown[] = [];
  const memory = adapter(
    memoryPort({
      add: (request) => {
        invocations.push({ type: "add", sourceAttemptId: request.metadata.loci_source_attempt_id });
        return accepted;
      },
      getEvent: async (eventId) => {
        invocations.push({ type: "getEvent", eventId });
        return { eventId, status: "SUCCEEDED", memoryIds: [] };
      },
      search: async (request) => {
        invocations.push({ type: "search", request });
        return [{ id: "visible", memory: "visible fact", metadata: {} }];
      },
    }),
  );

  const remembering = memory.remember(lesson);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(invocations, [{ type: "add", sourceAttemptId: "attempt-1" }]);
  assert.deepEqual(await memory.recall(["visible cue"], 5), [
    { lessonId: "visible", text: "visible fact" },
  ]);
  assert.deepEqual(invocations, [
    { type: "add", sourceAttemptId: "attempt-1" },
    {
      type: "search",
      request: {
        query: "visible cue",
        filters: { agent_id: "agent-1" },
        topK: 5,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      },
    },
  ]);
  releaseAdd?.({ eventId: "event", status: "PENDING" });
  await remembering;
  assert.deepEqual(invocations, [
    { type: "add", sourceAttemptId: "attempt-1" },
    {
      type: "search",
      request: {
        query: "visible cue",
        filters: { agent_id: "agent-1" },
        topK: 5,
        threshold: 0.1,
        rerank: false,
        keywordSearch: true,
      },
    },
    { type: "getEvent", eventId: "event" },
  ]);
});

test("snapshot and restore reject exact promises without calls or state changes", async () => {
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        return { eventId: "event", status: "PENDING" };
      },
      getEvent: async (eventId) => {
        invocations.push(`getEvent:${eventId}`);
        return { eventId, status: "SUCCEEDED", memoryIds: [] };
      },
      search: async () => {
        invocations.push("search");
        return [];
      },
    }),
  );

  const snapshot = memory.snapshot();
  assert.ok(snapshot instanceof Promise);
  await assert.rejects(snapshot, (error) => {
    assert.ok(error instanceof Mem0MemoryError);
    assert.equal(error.code, "unsupported_operation");
    assert.equal(error.message, "Mem0Memory does not support snapshot");
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    return true;
  });
  const unreadId = new Proxy(
    {},
    {
      get() {
        throw new Error("restore id must not be read");
      },
    },
  ) as string;
  const restore = memory.restore(unreadId);
  assert.ok(restore instanceof Promise);
  await assert.rejects(restore, (error) => {
    assert.ok(error instanceof Mem0MemoryError);
    assert.equal(error.code, "unsupported_operation");
    assert.equal(error.message, "Mem0Memory does not support restore");
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    return true;
  });
  assert.deepEqual(invocations, []);

  assert.deepEqual(await memory.recall([""], 1), []);
  await memory.remember(lesson);
  assert.deepEqual(invocations, ["add", "getEvent:event"]);
});

test("snapshot and restore preserve quarantine state without platform calls", async () => {
  const invocations: string[] = [];
  const memory = adapter(
    memoryPort({
      add: async () => {
        invocations.push("add");
        return { eventId: "", status: "PENDING" };
      },
      search: async () => {
        invocations.push("search");
        return [];
      },
    }),
  );
  await rejectsCode(memory.remember(lesson), "protocol_error");

  await rejectsCode(memory.snapshot(), "unsupported_operation");
  await rejectsCode(memory.restore("ignored"), "unsupported_operation");
  await rejectsCode(memory.recall(["feature"], 1), "instance_quarantined");
  await rejectsCode(memory.remember({ ...lesson, content: "" }), "instance_quarantined");

  assert.deepEqual(invocations, ["add"]);
});
