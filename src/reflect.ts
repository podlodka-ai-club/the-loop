import { reflectEpisodeWithRuntime } from "./reflect-runtime.internal.ts";
import type { MemoryBinding } from "./memory/memory.ts";
import type {
  MemoryHit,
  MemoryRunConfig,
  ReflectionEffect,
  WorkflowMemoryFailure,
} from "./tools/memory.ts";
import type { FeatureObservation } from "./observe.ts";

export type ReflectionEpisodeInput = {
  attemptId: string;
  imagePath: string;
  feature: FeatureObservation;
  memoryHit: MemoryHit | null;
  guess: { latitude: number; longitude: number; place: string; reasoning: string };
  truth: { latitude: number; longitude: number; country: string };
  distanceKm: number;
};

export type ReflectionEpisodeResult =
  | { status: "stored" | "already_stored"; effect: ReflectionEffect; lessonId: string; failure: null }
  | {
      status: "reflection_failed";
      effect: null;
      lessonId: null;
      failure:
        | "missing_tool_call"
        | "multiple_tool_calls"
        | "malformed_tool_json"
        | "invalid_tool_arguments"
        | "foreign_hit";
    }
  | {
      status: "write_failed" | "write_outcome_unknown" | "unsupported";
      effect: ReflectionEffect;
      lessonId: null;
      failure: "write_failed" | "write_outcome_unknown" | "unsupported" | WorkflowMemoryFailure;
    }
  | {
      status: "memory_not_found" | "memory_mismatch" | "unavailable" | "timeout";
      effect: ReflectionEffect | null;
      lessonId: null;
      failure: "memory_not_found" | "memory_mismatch" | "unavailable" | "timeout";
    };

export function reflectEpisode(
  input: ReflectionEpisodeInput,
  deps: { memoryBinding: MemoryBinding; run: MemoryRunConfig },
): Promise<ReflectionEpisodeResult> {
  return reflectEpisodeWithRuntime(input, deps);
}
