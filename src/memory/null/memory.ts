import type { Hint, Memory } from "../memory.ts";

/** Baseline: the agent never sees a lesson. Every memory-off run uses this. */
export class NullMemory implements Memory {
  async recall(): Promise<Hint[]> {
    return [];
  }
  async remember(): Promise<void> {}
  async snapshot(): Promise<string> {
    return "null";
  }
  async restore(id: string): Promise<void> {
    if (id !== "null") throw new Error(`NullMemory cannot restore snapshot ${id}`);
  }
}
