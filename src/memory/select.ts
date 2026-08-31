/**
 * Chooses a memory backend for a run.
 *
 * Kept in one place because the choice has a protocol consequence, not just a
 * wiring one: the file backend can freeze a snapshot and prove two runs read the
 * same state, while the hosted backends cannot. Anything measured on a hosted
 * backend is reproducible only by convention - nobody wrote to the namespace in
 * between - and that has to be visible at the call site.
 */
import { FrozenMemory, parseRecallMode } from "./file/memory.ts";
import { createMem0Memory, loadMem0MemoryConfig } from "./mem0/memory.ts";
import { NullMemory } from "./null/memory.ts";
import type { Memory } from "./memory.ts";

export type Backend = "file" | "mem0";

export const BACKENDS: readonly Backend[] = ["file", "mem0"];

export function parseBackend(value: string): Backend {
  if ((BACKENDS as readonly string[]).includes(value)) return value as Backend;
  throw new Error(`unknown memory backend "${value}", expected one of ${BACKENDS.join("|")}`);
}

export type MemorySelection = {
  memory: Memory;
  /** One line for the run header, so the log says what was actually read. */
  describe: string;
  /** False when the backend cannot freeze state; the run is then reproducible only by convention. */
  frozen: boolean;
};

export function selectMemory(options: {
  backend: Backend;
  snapshotId: string;
  recall: string;
}): MemorySelection {
  if (options.snapshotId === "" && options.backend === "file") {
    return { memory: new NullMemory(), describe: "off (baseline)", frozen: true };
  }

  if (options.backend === "mem0") {
    const config = loadMem0MemoryConfig();
    return {
      memory: createMem0Memory({ snapshots: false }, config),
      describe: `mem0 agent ${config.agentId}, ranking by the service`,
      frozen: false,
    };
  }

  return {
    memory: new FrozenMemory(options.snapshotId, parseRecallMode(options.recall)),
    describe: `file snapshot ${options.snapshotId}, recall ${options.recall}`,
    frozen: true,
  };
}
