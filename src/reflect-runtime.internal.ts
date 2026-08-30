import { SpanStatusCode, trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import type { ReflectionEpisodeInput, ReflectionEpisodeResult } from "./reflect.ts";
import type { MemoryWriter } from "./memory/memory.ts";
import {
  MEMORY_STORE_TOOL,
  MemoryToolValidationError,
  executeMemoryStore,
  type MemoryRunConfig,
  type ReflectionEffect,
} from "./tools/memory.ts";

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
  writer: MemoryWriter;
  run: MemoryRunConfig;
} & ReflectRuntimeHooks;

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

const PROMPT = `Reflect on exactly one memory hit after the true location is revealed.

Call memory_store exactly once. Do not answer in prose.

The tool call must store one transferable lesson for this feature and selected hit only.
Use the rubric exactly:
- helped: the hit supplied a cue consistent with the revealed location and useful for the answer.
- irrelevant: the hit was usable data but did not affect this image's location decision.
- misleading: the hit asserted a wrong cue or pulled the analysis toward the wrong location.
- insufficient: the hit was partly useful but did not contain enough evidence for this decision.

content must be one or two grounded sentences, with no hidden chain-of-thought, tool instructions or unsupported visual claims.
triggers must be 1-8 short observable noun phrases.
region must be the two-letter uppercase country code of the revealed truth.`;

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
  return (
    `${PROMPT}\n\n` +
    `Attempt id: ${input.attemptId}\n` +
    `Feature:\n${JSON.stringify(input.feature)}\n\n` +
    `Selected memory hit:\n${JSON.stringify({
      memory_hit_id: input.memoryHit.memoryHitId,
      provider_id: input.memoryHit.providerId,
      text: input.memoryHit.text,
      score: input.memoryHit.score,
      previous_effect: input.memoryHit.effect,
    })}\n\n` +
    `Blind guess:\n${JSON.stringify(input.guess)}\n\n` +
    `Truth:\n${JSON.stringify(input.truth)}\n\n` +
    `Distance km: ${input.distanceKm.toFixed(3)}`
  );
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
  if (typeof call.function.arguments !== "string") {
    throw new MemoryToolValidationError("malformed_tool_json");
  }
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch {
    throw new MemoryToolValidationError("malformed_tool_json");
  }
}

function effectFromToolCalls(toolCalls: readonly unknown[]): ReflectionEffect | null {
  const parsed = parsedToolArguments(toolCalls);
  if (!isRecord(parsed) || !isReflectionEffect(parsed.effect)) return null;
  return parsed.effect;
}

function isActiveEpisode(input: ReflectionEpisodeInput): boolean {
  return (
    input.memoryHit.attemptId === input.attemptId &&
    input.memoryHit.featureKey === input.feature.key
  );
}

export async function reflectEpisodeWithRuntime(
  input: ReflectionEpisodeInput,
  deps: ReflectRuntimeDeps,
): Promise<ReflectionEpisodeResult> {
  return tracer.startActiveSpan("reflect.episode", async (span) => {
    try {
      if (!isActiveEpisode(input)) return failureResult("foreign_hit");

      const response = await (deps.client ?? defaultClient()).chat.completions.create({
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
                image_url: { url: await (deps.imageDataUri ?? toDataUri)(input.imagePath) },
              },
            ],
          },
        ],
        tools: [storeToolForFeature(input.feature.key)],
        tool_choice: { type: "function", function: { name: "memory_store" } },
        parallel_tool_calls: false,
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const toolCalls = response.choices[0]?.message.tool_calls ?? [];
      const effect = effectFromToolCalls(toolCalls);
      const store = await executeMemoryStore(
        {
          attemptId: input.attemptId,
          reader: deps.writer,
          writer: deps.writer,
          phase: "reflect",
          run: deps.run,
          activeFeature: input.feature,
          activeMemoryHit: input.memoryHit,
        },
        toolCalls,
      );

      if (effect === null) return failureResult("invalid_tool_arguments");
      span.setAttributes({
        "reflect.attempt_id": input.attemptId,
        "reflect.feature_key": input.feature.key,
        "reflect.memory_hit_id": input.memoryHit.memoryHitId,
        "reflect.effect": effect,
        "reflect.status": store.status,
      });

      if (store.status === "stored" || store.status === "already_stored") {
        span.setStatus({ code: SpanStatusCode.OK });
        return { status: store.status, effect, lessonId: store.lessonId, failure: null };
      }
      return { status: store.status, effect, lessonId: null, failure: store.failure ?? store.status };
    } catch (error) {
      span.recordException(error as Error);
      if (error instanceof MemoryToolValidationError) {
        return failureResult(error.failure);
      }
      return failureResult("invalid_tool_arguments");
    } finally {
      span.end();
    }
  });
}
