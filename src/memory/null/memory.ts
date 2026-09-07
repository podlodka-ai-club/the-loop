import { MemoryWriteError } from "../memory.ts";
import type { Hint, LegacyMemory, MemoryWriteResult } from "../memory.ts";

/** Baseline: the agent never sees a lesson. Every memory-off run uses this. */
export class NullMemory implements LegacyMemory {
  async recall(): Promise<Hint[]> {
    return [];
  }
  async remember(): Promise<MemoryWriteResult> {
    throw new MemoryWriteError("write_failed");
  }
  async snapshot(): Promise<string> {
    return "null";
  }
  async restore(id: string): Promise<void> {
    if (id !== "null") throw new Error(`NullMemory cannot restore snapshot ${id}`);
  }
}
