/**
 * Chooses a memory backend for a run.
 *
 * Kept in one place because the choice has a protocol consequence, not just a
 * wiring one: the file backend can freeze a snapshot and prove two runs read the
 * same state, while the hosted backends cannot. Anything measured on a hosted
 * backend is reproducible only by convention - nobody wrote to the namespace in
 * between - and that has to be visible at the call site.
 */
import { FrozenMemory, parseRecallMode, type RecallMode } from "./file/memory.ts";
import { createMem0Memory, loadMem0MemoryConfig } from "./mem0/memory.ts";
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
  type MemorySourceResolver,
} from "./memory.ts";
import type { BenchmarkMemoryMode } from "../benchmark-metrics.ts";
import type { MemoryRunConfig } from "../tools/memory.ts";

export type Backend = "file" | "mem0";

export const BACKENDS: readonly Backend[] = ["file", "mem0"];

export function parseBackend(value: string): Backend {
  if ((BACKENDS as readonly string[]).includes(value)) return value as Backend;
  throw new Error(`unknown memory backend "${value}", expected one of ${BACKENDS.join("|")}`);
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

export function selectMemory(options: {
  backend: Backend;
  snapshotId: string;
  recall: string;
}): MemorySelection {
  const recallMode = parseRecallMode(options.recall);
  if (options.snapshotId === "" && options.backend === "file") {
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

  return {
    memory: new FrozenMemory(options.snapshotId, recallMode),
    describe: `file snapshot ${options.snapshotId}, recall ${recallMode}`,
    frozen: true,
    recallMode,
    recallLimit: RECALL_LIMIT,
  };
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
    throw new Error("feature-scoped warm evaluation requires a backend with frozen snapshots");
  }
  const snapshotId = options.snapshotId.trim();
  const memory = new FrozenMemory(snapshotId, recallMode).asFeatureScopedReader();
  const run = { memoryRef: "file", mode: "evaluation" as const, snapshotId, readOnly: true as const, recallLimit: RECALL_LIMIT };
  const sourceResolver = createMemorySourceResolver(createMemorySourceBinding({
    memoryRef: "file",
    memory,
    provider: "file",
    loadSnapshot: async (id) => createFrozenMemorySnapshotBinding({
      memoryRef: "file",
      snapshotId: id,
      reader: new FrozenMemory(id, recallMode),
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
