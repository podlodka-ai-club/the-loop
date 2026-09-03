import { access } from "node:fs/promises";
import { locateWithRuntime } from "./locate-runtime.internal.ts";
import {
  createMemorySourceBinding,
  createMemorySourceResolver,
  createFrozenMemorySnapshotBinding,
  createNoopMemoryBinding,
  MemoryBindingError,
  memorySourceMatchesReader,
  resolveMemoryBinding,
  type MemoryBinding,
  type MemoryReader,
  type MemorySourceResolver,
} from "./memory/memory.ts";
import type { LocateResult, MemoryRunConfig } from "./tools/memory.ts";

export type LocateDeps = {
  /** Resolved binding is the canonical dynamic composition. */
  memoryBinding?: MemoryBinding;
  /** Compatibility composition inputs; locate converts them once at this boundary. */
  memory?: MemoryReader;
  run: MemoryRunConfig;
  memorySourceResolver?: MemorySourceResolver;
  maxToolAttemptsPerFeature?: 1 | 2;
};

export async function locate(
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
): Promise<LocateResult> {
  if (deps.memoryBinding !== undefined && (deps.memory !== undefined || deps.memorySourceResolver !== undefined)) {
    throw new MemoryBindingError(
      "memory_mismatch",
      "locate accepts memoryBinding as the only dynamic memory source",
    );
  }

  if (deps.memoryBinding !== undefined) {
    await access(input.imagePath);
    return locateWithRuntime(input, {
      run: deps.run,
      memoryBinding: deps.memoryBinding,
      maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
    });
  }

  if (deps.run.memoryRef === null && deps.memory !== undefined) {
    throw new MemoryBindingError("memory_mismatch", "memoryRef=null cannot be combined with direct memory");
  }

  if (deps.memory !== undefined) {
    if (deps.run.memoryRef === null) {
      throw new MemoryBindingError("memory_mismatch", "memoryRef=null cannot be combined with direct memory");
    }

    const directSource = createMemorySourceBinding({
      memoryRef: deps.run.memoryRef,
      memory: deps.memory,
      provider: null,
      ...(deps.memory.loadSnapshot === undefined
        ? {}
        : {
            loadSnapshot: async (snapshotId: string) => createFrozenMemorySnapshotBinding({
              memoryRef: deps.run.memoryRef!,
              snapshotId,
              reader: await deps.memory!.loadSnapshot!(snapshotId),
            }),
          }),
    });

    let source = directSource;
    if (deps.memorySourceResolver !== undefined) {
      let resolved: unknown;
      try {
        resolved = await deps.memorySourceResolver.resolve(deps.run.memoryRef);
      } catch (error) {
        throw new MemoryBindingError("memory_mismatch", "direct memory and resolver did not resolve one binding", { cause: error });
      }
      if (!memorySourceMatchesReader(resolved, deps.memory)) {
        throw new MemoryBindingError("memory_mismatch", "direct memory and resolver did not resolve one binding");
      }
      source = resolved;
    }

    const memoryBinding = await resolveMemoryBinding(
      deps.run,
      createMemorySourceResolver(source),
    );
    await access(input.imagePath);
    return locateWithRuntime(input, {
      run: deps.run,
      memoryBinding,
      maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
    });
  }

  if (deps.memorySourceResolver !== undefined) {
    await access(input.imagePath);
    return locateWithRuntime(input, {
      run: deps.run,
      memorySourceResolver: deps.memorySourceResolver,
      maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
    });
  }

  if (deps.run.memoryRef === null) {
    await access(input.imagePath);
    return locateWithRuntime(input, {
      run: deps.run,
      memoryBinding: createNoopMemoryBinding({ mode: deps.run.mode, snapshotId: deps.run.snapshotId }),
      maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
    });
  }

  await access(input.imagePath);
  return locateWithRuntime(input, {
    run: deps.run,
    maxToolAttemptsPerFeature: deps.maxToolAttemptsPerFeature,
  });
}
