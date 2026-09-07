/**
 * Chooses a memory backend for a run.
 *
 * Kept in one place because the choice has a protocol consequence, not just a
 * wiring one: the file backend can freeze a snapshot and prove two runs read the
 * same state, while the hosted backends cannot. Anything measured on a hosted
 * backend is reproducible only by convention - nobody wrote to the namespace in
 * between - and that has to be visible at the call site.
 */
import { FileMemory, parseRecallMode, type RecallMode } from "./file/memory.ts";
import { createMem0Memory, loadMem0MemoryConfig } from "./mem0/memory.ts";
import { createHindsightMemory, loadHindsightMemoryConfig, type HindsightMemoryConfig } from "./hindsight/memory.ts";
import { resolveHindsightMemorySource } from "./hindsight/platform-contract.ts";
import { createXmemoryMemory, loadXmemoryMemoryConfig } from "./xmemory/memory.ts";
import { NullMemory } from "./null/memory.ts";
import {
  createMemorySourceBinding,
  createMemorySourceResolver,
  createFrozenMemorySnapshotBinding,
  RECALL_LIMIT,
  createNoopMemoryBinding,
  resolveMemoryBinding,
  type LegacyMemory,
  type MemoryBinding,
  type MemoryReader,
  type MemorySnapshotMode,
  type MemorySourceResolver,
} from "./memory.ts";
import type { BenchmarkMemoryMode } from "../benchmark-metrics.ts";
import type { MemoryRunConfig } from "../tools/memory.ts";

export type Backend = "file" | "mem0" | "hindsight" | "xmemory";

export const BACKENDS: readonly Backend[] = ["file", "mem0", "hindsight", "xmemory"];

export function parseBackend(value: string): Backend {
  if ((BACKENDS as readonly string[]).includes(value)) return value as Backend;
  throw new Error(`unknown memory backend "${value}", expected one of ${BACKENDS.join("|")}`);
}

/**
 * Hindsight has no run-scoped env pair like Mem0; the bank is the namespace. Read it
 * from HINDSIGHT_BANK_ID so a run names its scope the same way infra names pilots.
 */
export function loadHindsightConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HindsightMemoryConfig {
  const bankId = env.HINDSIGHT_BANK_ID?.trim();
  if (bankId === undefined || bankId === "") {
    throw new Error("HINDSIGHT_BANK_ID is required for the hindsight backend");
  }
  return loadHindsightMemoryConfig(
    resolveHindsightMemorySource({ memoryRef: "hindsight", bankId, purpose: "pilot" }),
    env,
  );
}

export type MemorySelection = {
  memory: LegacyMemory;
  /** One line for the run header, so the log says what was actually read. */
  describe: string;
  /** False when the backend cannot freeze state; the run is then reproducible only by convention. */
  frozen: boolean;
  recallMode: RecallMode;
  recallLimit: MemoryRunConfig["recallLimit"];
};

export type FeatureScopedMemorySelection = {
  memoryBinding: MemoryBinding;
  run: MemoryRunConfig;
  describe: string;
  frozen: boolean;
  memoryMode: BenchmarkMemoryMode;
  recallMode: RecallMode;
  recallLimit: MemoryRunConfig["recallLimit"];
};

export async function selectMemory(options: {
  backend: Backend;
  snapshotId: string;
  recall: string;
  /** Legacy callers must opt into legacy snapshots explicitly. */
  snapshotMode?: MemorySnapshotMode;
}): Promise<MemorySelection> {
  const recallMode = parseRecallMode(options.recall);
  const snapshotId = options.snapshotId.trim();
  if (snapshotId === "" && options.backend === "file") {
    return {
      memory: new NullMemory(),
      describe: "off (baseline)",
      frozen: true,
      recallMode: "off",
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "mem0") {
    const config = loadMem0MemoryConfig();
    return {
      memory: createMem0Memory({ snapshots: false }, config),
      describe: `mem0 agent ${config.agentId}, ranking by the service`,
      frozen: false,
      recallMode,
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "hindsight") {
    const config = loadHindsightConfigFromEnv();
    return {
      memory: createHindsightMemory({ snapshots: false }, config),
      describe: `hindsight bank ${config.source.bankId}, ranking by the service`,
      frozen: false,
      recallMode,
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "xmemory") {
    const config = loadXmemoryMemoryConfig();
    return {
      memory: await createXmemoryMemory({ snapshots: false }, config),
      describe: `xmemory instance ${config.instanceId}, synthesized single answer`,
      frozen: false,
      recallMode,
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "file") {
    // Legacy evaluation uses this selector directly. Validate the complete
    // snapshot before returning a FrozenMemory so no task/evaluation can start
    // with a missing, malformed or edited file and discover it only at recall.
    const memory = await new FileMemory(undefined, recallMode, true).loadSnapshot(
      snapshotId,
      options.snapshotMode ?? "dynamic",
    );
    return {
      memory,
      describe: `file snapshot ${snapshotId}, recall ${recallMode}`,
      frozen: true,
      recallMode,
      recallLimit: RECALL_LIMIT,
    };
  }

  throw new Error(`unsupported memory backend ${options.backend}`);
}

export async function selectFeatureScopedEvaluationMemory(options: {
  backend: Backend;
  snapshotId: string;
  recall: string;
  memoryMode: BenchmarkMemoryMode;
}): Promise<FeatureScopedMemorySelection> {
  const recallMode = parseRecallMode(options.recall);
  if (options.memoryMode === "cold") {
    if (recallMode !== "off") {
      throw new Error("feature-scoped cold evaluation requires --recall off");
    }
    return {
      memoryBinding: createNoopMemoryBinding({ mode: "production", snapshotId: null }),
      run: { memoryRef: null, mode: "production", snapshotId: null, readOnly: true, recallLimit: RECALL_LIMIT },
      describe: "feature-scoped cold control (memory off)",
      frozen: true,
      memoryMode: options.memoryMode,
      recallMode: "off",
      recallLimit: RECALL_LIMIT,
    };
  }
  if (recallMode !== "top") {
    throw new Error("feature-scoped warm evaluation requires --recall top");
  }
  if (options.snapshotId.trim() === "") {
    throw new Error("feature-scoped warm evaluation requires --snapshot");
  }

  if (options.backend === "mem0") {
    const config = loadMem0MemoryConfig();
    const memory = createMem0Memory({ snapshots: false }, config);
    const run = {
      memoryRef: "mem0",
      mode: "production" as const,
      snapshotId: null,
      readOnly: true as const,
      recallLimit: RECALL_LIMIT,
    };
    return {
      memoryBinding: await resolveMemoryBinding(
        run,
        createMemorySourceResolver(createMemorySourceBinding({
          memoryRef: "mem0",
          memory,
          provider: "mem0",
        })),
      ),
      run,
      describe: `feature-scoped mem0 agent ${config.agentId}, recall top`,
      frozen: false,
      memoryMode: options.memoryMode,
      recallMode: "top",
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "hindsight") {
    const config = loadHindsightConfigFromEnv();
    const memory = createHindsightMemory({ snapshots: false }, config);
    const run = {
      memoryRef: "hindsight",
      mode: "production" as const,
      snapshotId: null,
      readOnly: true as const,
      recallLimit: RECALL_LIMIT,
    };
    return {
      memoryBinding: await resolveMemoryBinding(
        run,
        createMemorySourceResolver(createMemorySourceBinding({
          memoryRef: "hindsight",
          memory,
          provider: "hindsight",
        })),
      ),
      run,
      describe: `feature-scoped hindsight bank ${config.source.bankId}, recall top`,
      frozen: false,
      memoryMode: options.memoryMode,
      recallMode: "top",
      recallLimit: RECALL_LIMIT,
    };
  }

  if (options.backend === "xmemory") {
    const config = loadXmemoryMemoryConfig();
    const memory = await createXmemoryMemory({ snapshots: false }, config);
    const run = {
      memoryRef: "xmemory",
      mode: "production" as const,
      snapshotId: null,
      readOnly: true as const,
      recallLimit: RECALL_LIMIT,
    };
    return {
      memoryBinding: await resolveMemoryBinding(
        run,
        createMemorySourceResolver(createMemorySourceBinding({
          memoryRef: "xmemory",
          memory,
          provider: "xmemory",
        })),
      ),
      run,
      describe: `feature-scoped xmemory instance ${config.instanceId}, synthesized single answer`,
      frozen: false,
      memoryMode: options.memoryMode,
      recallMode: "top",
      recallLimit: RECALL_LIMIT,
    };
  }
  const snapshotId = options.snapshotId.trim();
  // Validate and materialize the snapshot at selection time, before evaluation
  // can make any model/provider call.
  const snapshotStore = new FileMemory(undefined, recallMode, true);
  const snapshotReader = await snapshotStore.loadSnapshot(snapshotId);
  const memory = snapshotReader;
  const run = { memoryRef: "file", mode: "evaluation" as const, snapshotId, readOnly: true as const, recallLimit: RECALL_LIMIT };
  const sourceResolver = createMemorySourceResolver(createMemorySourceBinding({
    memoryRef: "file",
    memory,
    provider: "file",
    loadSnapshot: async (id) => createFrozenMemorySnapshotBinding({
      memoryRef: "file",
      snapshotId: id,
      reader: id === snapshotId ? snapshotReader : await snapshotStore.loadSnapshot(id),
    }),
  }));
  return {
    memoryBinding: await resolveMemoryBinding(run, sourceResolver),
    run,
    describe: `feature-scoped file snapshot ${snapshotId}, recall top`,
    frozen: true,
    memoryMode: options.memoryMode,
    recallMode,
    recallLimit: RECALL_LIMIT,
  };
}
