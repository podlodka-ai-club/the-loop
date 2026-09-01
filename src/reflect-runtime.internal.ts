import { SpanStatusCode, trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import type { ReflectionEpisodeInput, ReflectionEpisodeResult } from "./reflect.ts";
import type { MemoryBinding, MemoryBindingFailureCode } from "./memory/memory.ts";
import { MemoryBindingError, validateMemoryBinding } from "./memory/memory.ts";
import {
  MEMORY_STORE_TOOL,
  MemoryToolValidationError,
  executeMemoryStore,
  validateMemoryRunConfig,
  type MemoryRunConfig,
  type ReflectionEffect,
} from "./tools/memory.ts";
import { loadPrompt, PROMPT_VERSIONS } from "./promts.ts";

export type ReflectRuntimeChatClient = {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<ReflectRuntimeChatCompletion>;
    };
  };
};

export type ReflectRuntimeChatCompletion = {
  choices: Array<{
    message: {
      tool_calls?: unknown[];
    };
  }>;
  provider?: string;
};

export type ReflectRuntimeHooks = {
  client?: ReflectRuntimeChatClient;
  imageDataUri?: (imagePath: string) => Promise<string>;
};

export type ReflectRuntimeDeps = {
  memoryBinding: MemoryBinding;
  run: MemoryRunConfig;
} & ReflectRuntimeHooks;

export type ReflectRuntimeErrorCode = "image_data_uri_failed" | "model_failed";

export class ReflectRuntimeError extends Error {
  readonly code: ReflectRuntimeErrorCode;

  constructor(code: ReflectRuntimeErrorCode, cause: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "ReflectRuntimeError";
    this.code = code;
  }
}

const MODEL = process.env.REFLECT_MODEL ?? process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const TEMPERATURE = Number(process.env.REFLECT_TEMPERATURE ?? 0);
const SEED = Number(process.env.GEOLOCATE_SEED ?? 1);

const PROVIDER = {
  order: (process.env.OPENROUTER_PROVIDER ?? "Novita,Venice")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
  allow_fallbacks: false,
  quantizations: [process.env.OPENROUTER_QUANTIZATION ?? "bf16"],
} as const;

const REFLECTION_EFFECTS: readonly ReflectionEffect[] = [
  "helped",
  "irrelevant",
  "misleading",
  "insufficient",
];

type ReflectionFailure = Extract<
  ReflectionEpisodeResult,
  { status: "reflection_failed" }
>["failure"];

const REFLECTION_FAILURES = new Set<ReflectionFailure>([
  "missing_tool_call",
  "multiple_tool_calls",
  "malformed_tool_json",
  "invalid_tool_arguments",
  "foreign_hit",
]);

let cachedClient: OpenAI | undefined;
const tracer = trace.getTracer("reflect");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Export it before running reflect.`);
  return value;
}

function defaultClient(): ReflectRuntimeChatClient {
  cachedClient ??= new OpenAI({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    baseURL: BASE_URL,
  });
  return cachedClient;
}

function storeToolForFeature(featureKey: string): OpenAI.ChatCompletionTool {
  return {
    ...MEMORY_STORE_TOOL,
    function: {
      ...MEMORY_STORE_TOOL.function,
      parameters: {
        ...MEMORY_STORE_TOOL.function.parameters,
        properties: {
          ...MEMORY_STORE_TOOL.function.parameters.properties,
          feature_key: { type: "string", enum: [featureKey] },
        },
      },
    },
  } as OpenAI.ChatCompletionTool;
}

function reflectionPrompt(input: ReflectionEpisodeInput): string {
  return `${loadPrompt("reflect")}\n\n${JSON.stringify({
    attempt_id: input.attemptId,
    feature: input.feature,
    selected_memory_hit: input.memoryHit === null
      ? null
      : {
          memory_hit_id: input.memoryHit.memoryHitId,
          provider_id: input.memoryHit.providerId,
          text: input.memoryHit.text,
          score: input.memoryHit.score,
          previous_effect: input.memoryHit.effect,
        },
    blind_guess: input.guess,
    truth: input.truth,
    distance_km: input.distanceKm.toFixed(3),
  })}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReflectionEffect(value: unknown): value is ReflectionEffect {
  return typeof value === "string" && (REFLECTION_EFFECTS as readonly string[]).includes(value);
}

function failureResult(failure: unknown): ReflectionEpisodeResult {
  if (typeof failure !== "string" || !REFLECTION_FAILURES.has(failure as ReflectionFailure)) {
    return {
      status: "reflection_failed",
      effect: null,
      lessonId: null,
      failure: "invalid_tool_arguments",
    };
  }
  return { status: "reflection_failed", effect: null, lessonId: null, failure: failure as ReflectionFailure };
}

function bindingFailureResult(code: MemoryBindingFailureCode): ReflectionEpisodeResult {
  return { status: code, effect: null, lessonId: null, failure: code };
}

function storeFailureResult(
  status: "write_failed" | "write_outcome_unknown" | "unsupported" | MemoryBindingFailureCode,
  effect: ReflectionEffect,
  failure: "write_failed" | "write_outcome_unknown" | "unsupported" | MemoryBindingFailureCode,
): ReflectionEpisodeResult {
  if (
    status === "memory_not_found" ||
    status === "memory_mismatch" ||
    status === "unavailable" ||
    status === "timeout"
  ) {
    return { status, effect, lessonId: null, failure: status };
  }
  return { status, effect, lessonId: null, failure };
}

function parsedToolArguments(toolCalls: readonly unknown[]): unknown {
  if (toolCalls.length === 0) throw new MemoryToolValidationError("missing_tool_call");
  if (toolCalls.length > 1) throw new MemoryToolValidationError("multiple_tool_calls");
  const call = toolCalls[0];
  if (!isRecord(call) || !isRecord(call.function)) {
    throw new MemoryToolValidationError("malformed_tool_json");
  }
  if (call.function.name !== "memory_store") {
    throw new MemoryToolValidationError("missing_tool_call");
  }
  const rawArgs = call.function.arguments;
  if (typeof rawArgs !== "string") {
    throw new MemoryToolValidationError("malformed_tool_json");
  }
  try {
    return JSON.parse(rawArgs) as unknown;
  } catch {
    throw new MemoryToolValidationError("malformed_tool_json");
  }
}

function effectFromParsedToolArguments(parsed: unknown): ReflectionEffect | null {
  if (!isRecord(parsed) || !isReflectionEffect(parsed.effect)) return null;
  return parsed.effect;
}

function isActiveEpisode(input: ReflectionEpisodeInput): boolean {
  if (input.memoryHit === null) return true;
  return (
    input.memoryHit.attemptId === input.attemptId &&
    input.memoryHit.featureKey === input.feature.key
  );
}

function normalizedCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function regionFromParsedToolArguments(parsed: unknown): string | null {
  if (!isRecord(parsed) || typeof parsed.region !== "string") return null;
  return normalizedCountry(parsed.region);
}

function isWritableTrainingRuntime(deps: ReflectRuntimeDeps, binding: MemoryBinding): boolean {
  if (!isRecord(deps.run)) return false;
  try {
    validateMemoryRunConfig(deps.run);
  } catch {
    return false;
  }
  return (
    deps.run.mode === "training" &&
    deps.run.memoryRef !== null &&
    deps.run.readOnly === false &&
    deps.run.snapshotId === null &&
    typeof binding.writer?.remember === "function"
  );
}

export async function reflectEpisodeWithRuntime(
  input: ReflectionEpisodeInput,
  deps: ReflectRuntimeDeps,
): Promise<ReflectionEpisodeResult> {
  return tracer.startActiveSpan("reflect.episode", async (span): Promise<ReflectionEpisodeResult> => {
    try {
      validateMemoryBinding(deps.memoryBinding, deps.run);
      const binding = deps.memoryBinding;
      if (binding.mode !== "training" || binding.writer === undefined) return failureResult("invalid_tool_arguments");
      if (!isWritableTrainingRuntime(deps, binding)) return failureResult("invalid_tool_arguments");
      const truthCountry = normalizedCountry(input.truth.country);
      if (truthCountry === null) return failureResult("invalid_tool_arguments");
      if (!isActiveEpisode(input)) return failureResult("foreign_hit");

      let imageUrl: string;
      try {
        imageUrl = await (deps.imageDataUri ?? toDataUri)(input.imagePath);
      } catch (error) {
        throw new ReflectRuntimeError("image_data_uri_failed", error);
      }

      let response: ReflectRuntimeChatCompletion;
      try {
        response = await (deps.client ?? defaultClient()).chat.completions.create({
          model: MODEL,
          temperature: TEMPERATURE,
          seed: SEED,
          provider: PROVIDER,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: reflectionPrompt(input) },
                {
                  type: "image_url",
                  image_url: { url: imageUrl },
                },
              ],
            },
          ],
          tools: [storeToolForFeature(input.feature.key)],
          tool_choice: { type: "function", function: { name: "memory_store" } },
          parallel_tool_calls: false,
        } as OpenAI.ChatCompletionCreateParamsNonStreaming);
      } catch (error) {
        throw new ReflectRuntimeError("model_failed", error);
      }

      const toolCalls = response.choices[0]?.message.tool_calls ?? [];
      const parsedArgs = parsedToolArguments(toolCalls);
      const effect = effectFromParsedToolArguments(parsedArgs);
      const region = regionFromParsedToolArguments(parsedArgs);
      if (region === null || region !== truthCountry) return failureResult("invalid_tool_arguments");
      const store = await executeMemoryStore(
        {
          attemptId: input.attemptId,
          reader: binding.reader,
          writer: binding.writer,
          promptPort: binding.promptPort,
          phase: "reflect",
          run: deps.run,
          activeFeature: input.feature,
          activeMemoryHit: input.memoryHit,
        },
        parsedArgs,
      );

      if (effect === null) return failureResult("invalid_tool_arguments");
      span.setAttributes({
        "reflect.attempt_id": input.attemptId,
        "reflect.feature_key": input.feature.key,
        "reflect.prompt_version": PROMPT_VERSIONS.reflect,
        "reflect.effect": effect,
        "reflect.status": store.status,
        ...(input.memoryHit === null ? {} : { "reflect.memory_hit_id": input.memoryHit.memoryHitId }),
      });

      if (store.status === "stored" || store.status === "already_stored") {
        span.setStatus({ code: SpanStatusCode.OK });
        return { status: store.status, effect, lessonId: store.lessonId, failure: null };
      }
      if (store.status === "unsupported") {
        return {
          status: "unsupported",
          effect,
          lessonId: null,
          failure: "unsupported",
        };
      }
      if (
        store.status === "memory_not_found" ||
        store.status === "memory_mismatch" ||
        store.status === "unavailable" ||
        store.status === "timeout"
      ) {
        return storeFailureResult(store.status, effect, store.failure);
      }
      if (
        store.status === "write_failed" ||
        store.status === "write_outcome_unknown" ||
        store.status === "unsupported"
      ) {
        return storeFailureResult(store.status, effect, store.failure);
      }
      return failureResult("invalid_tool_arguments");
    } catch (error) {
      span.recordException(error as Error);
      if (error instanceof MemoryToolValidationError) {
        return failureResult(error.failure);
      }
      if (error instanceof MemoryBindingError) {
        return bindingFailureResult(error.code);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
