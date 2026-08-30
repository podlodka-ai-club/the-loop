import { locateWithRuntime } from "./locate-runtime.internal.ts";
import type { MemoryReader } from "./memory/memory.ts";
import type { LocateResult, MemoryRunConfig } from "./tools/memory.ts";

export type LocateDeps = {
  memory: MemoryReader;
  run: MemoryRunConfig;
  maxToolAttemptsPerFeature?: 1 | 2;
};

export function locate(
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
): Promise<LocateResult> {
  return locateWithRuntime(input, {
    memory: deps.memory,
    run: deps.run,
    maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
  });
}
