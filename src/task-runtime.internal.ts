/**
 * Internal training composition point used by train.ts. It can receive a writer and
 * run post-reveal episode reflection, while public runTask stays reader-only for
 * feature-scoped callers.
 */
export {
  runFeatureScopedTrainingTask as runTrainingTaskWithRuntime,
  runFeatureScopedTask as runTaskWithRuntime,
  type FeatureScopedTaskRuntimeDeps,
  type FeatureScopedTaskRuntimeInput,
  type FeatureScopedTrainingTaskRuntimeDeps,
  type FeatureScopedTrainingTaskRuntimeInput,
  type LocateFunction,
  type ReflectEpisodeFunction,
} from "./task-feature-scoped.internal.ts";
