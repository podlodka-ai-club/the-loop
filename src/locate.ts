import OpenAI from "openai";
import { UnparseableOutputError, type Guess } from "./agent.ts";
import { toDataUri } from "./image.ts";
import {
  eligibleFeatureObservations,
  observe,
  type FeatureObservation,
  type ObserveResult,
} from "./observe.ts";
import { FileMemory, featureScopedFileMemoryReader } from "./memory/file/memory.ts";
import type { MemoryReader } from "./memory/memory.ts";
import {
  MEMORY_RETRIEVE_TOOL,
  MemoryToolValidationError,
  executeMemoryRetrieve,
  validateMemoryRunConfig,
  type AttemptTrace,
  type FeatureMemoryGroup,
  type LocateResult,
  type MemoryRunConfig,
  type MemoryToolContext,
  type RetrievalFailure,
  type ToolEvent,
} from "./tools/memory.ts";

export type LocateDeps = {
  memory: MemoryReader;
  run: MemoryRunConfig;
  maxToolAttemptsPerFeature?: 1 | 2;
  observe?: (imagePath: string) => Promise<ObserveResult>;
  imageDataUri?: (imagePath: string) => Promise<string>;
  client?: LocateChatClient;
};

export type LocateChatClient = {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<LocateChatCompletion>;
    };
  };
};

export type LocateChatCompletion = {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: unknown[];
    };
  }>;
  provider?: string;
};

const MODEL = process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const TEMPERATURE = Number(process.env.GEOLOCATE_TEMPERATURE ?? 0);
const SEED = Number(process.env.GEOLOCATE_SEED ?? 1);

const PROVIDER = {
  order: (process.env.OPENROUTER_PROVIDER ?? "Novita,Venice")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
  allow_fallbacks: false,
  quantizations: [process.env.OPENROUTER_QUANTIZATION ?? "bf16"],
} as const;

const GUESS_SCHEMA = {
  type: "object",
  properties: {
    latitude: { type: "number" },
    longitude: { type: "number" },
    place: { type: "string" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["latitude", "longitude", "place", "confidence", "reasoning"],
  additionalProperties: false,
} as const;

const RETRYABLE_TOOL_FAILURES: readonly RetrievalFailure[] = [
  "missing_tool_call",
  "multiple_tool_calls",
  "malformed_tool_json",
  "invalid_tool_arguments",
  "wrong_feature",
];
const RETRIEVAL_MODEL_ATTEMPT_BUDGET = 24;

let cachedClient: OpenAI | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Export it before running locate.`);
  return value;
}

function defaultClient(): LocateChatClient {
  cachedClient ??= new OpenAI({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    baseURL: BASE_URL,
  });
  return cachedClient as LocateChatClient;
}

function parseGuess(raw: string | null | undefined, provider: string | undefined): Guess {
  if (!raw) throw new UnparseableOutputError("model returned no content", "");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnparseableOutputError("response is not valid JSON", raw);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnparseableOutputError("response is not a JSON object", raw);
  }
  const { latitude, longitude, place, confidence, reasoning } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new UnparseableOutputError(`latitude out of range: ${String(latitude)}`, raw);
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new UnparseableOutputError(`longitude out of range: ${String(longitude)}`, raw);
  }
  return {
    latitude,
    longitude,
    place: typeof place === "string" ? place : "",
    confidence: typeof confidence === "number" ? confidence : Number.NaN,
    reasoning: typeof reasoning === "string" ? reasoning : "",
    provider: provider ?? "unknown",
  };
}

function isTimeoutFailure(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "timeout" || code === "ETIMEDOUT") return true;
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

function failedGroup(
  attemptId: string,
  feature: FeatureObservation,
  failure: RetrievalFailure,
): FeatureMemoryGroup {
  return {
    attemptId,
    feature,
    query: null,
    status: "failed",
    hits: [],
    failure,
  };
}

function isRetryableFailure(group: FeatureMemoryGroup): boolean {
  return group.status === "failed" && RETRYABLE_TOOL_FAILURES.includes(group.failure as RetrievalFailure);
}

function featureScopedReader(reader: MemoryReader): MemoryReader {
  return reader instanceof FileMemory ? featureScopedFileMemoryReader(reader) : reader;
}

function maxRetrievalToolAttempts(value: unknown): 1 | 2 {
  return value === 1 ? 1 : 2;
}

function retrieveToolForFeature(featureKey: FeatureObservation["key"]): OpenAI.ChatCompletionTool {
  return {
    ...MEMORY_RETRIEVE_TOOL,
    function: {
      ...MEMORY_RETRIEVE_TOOL.function,
      parameters: {
        ...MEMORY_RETRIEVE_TOOL.function.parameters,
        properties: {
          ...MEMORY_RETRIEVE_TOOL.function.parameters.properties,
          feature_key: { type: "string", enum: [featureKey] },
        },
      },
    },
  } as OpenAI.ChatCompletionTool;
}

function retrievePrompt(feature: FeatureObservation): string {
  return (
    `Call memory_retrieve exactly once for feature_key "${feature.key}". ` +
    "The query must describe only this visible feature, without country, region, city or continent guesses.\n" +
    `Observation: ${feature.text}`
  );
}

function analyzePrompt(observations: readonly FeatureObservation[], groups: readonly FeatureMemoryGroup[]): string {
  return (
    "Make one strict geolocation guess from the original image. " +
    "Memory groups are prior lessons only: treat them as hypotheses and use them only where they match the image. " +
    "Do not use any revealed location data and do not call memory tools.\n\n" +
    `Observations:\n${JSON.stringify(observations)}\n\n` +
    `Memory groups:\n${JSON.stringify(groups)}`
  );
}

function serializeRetrieveResult(group: FeatureMemoryGroup): string {
  return JSON.stringify({
    attempt_id: group.attemptId,
    feature_key: group.feature.key,
    status: group.status,
    hits: group.hits.map((hit) => ({
      memory_hit_id: hit.memoryHitId,
      provider_id: hit.providerId,
      text: hit.text,
      score: hit.score,
      effect: hit.effect,
    })),
    failure: group.failure,
  });
}

function toolCallId(toolCalls: readonly unknown[]): string | null {
  if (toolCalls.length !== 1) return null;
  const call = toolCalls[0];
  if (typeof call !== "object" || call === null) return null;
  const id = (call as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

function toolEvent(
  attemptId: string,
  group: FeatureMemoryGroup,
  sequence: number,
): ToolEvent {
  return {
    attemptId,
    phase: "retrieve",
    operation: "memory_retrieve",
    featureKey: group.feature.key,
    memoryHitId: null,
    status: group.status === "failed" ? group.failure ?? "failed" : group.status,
    sequence,
  };
}

export async function locate(
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
): Promise<LocateResult> {
  validateMemoryRunConfig(deps.run);
  const observeImage = deps.observe ?? observe;
  const reader = featureScopedReader(deps.memory);
  const client = deps.client ?? defaultClient();
  const maxAttempts = maxRetrievalToolAttempts(deps.maxToolAttemptsPerFeature);
  const observed = await observeImage(input.imagePath);
  const observations = observed.features;
  const imageUrl = await (deps.imageDataUri ?? toDataUri)(input.imagePath);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "This conversation solves one image. The original image remains authoritative. " +
            `Observation output:\n${JSON.stringify(observed)}`,
        },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const groups: FeatureMemoryGroup[] = [];
  const events: ToolEvent[] = [];
  let sequence = 0;
  let memoryHitsRemaining = 60;

  for (const feature of eligibleFeatureObservations(observations)) {
    let finalGroup: FeatureMemoryGroup | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (events.length >= RETRIEVAL_MODEL_ATTEMPT_BUDGET) {
        const group = failedGroup(input.attemptId, feature, "budget_exhausted");
        sequence += 1;
        events.push(toolEvent(input.attemptId, group, sequence));
        finalGroup = group;
        break;
      }
      const turn: OpenAI.ChatCompletionMessageParam = {
        role: "user",
        content: retrievePrompt(feature),
      };
      const requestMessages = [...messages, turn];
      let group: FeatureMemoryGroup;
      let toolCalls: unknown[] = [];
      try {
        const response = await client.chat.completions.create({
          model: MODEL,
          temperature: TEMPERATURE,
          seed: SEED,
          provider: PROVIDER,
          messages: requestMessages,
          tools: [retrieveToolForFeature(feature.key)],
          tool_choice: { type: "function", function: { name: "memory_retrieve" } },
          parallel_tool_calls: false,
        } as OpenAI.ChatCompletionCreateParamsNonStreaming);
        toolCalls = response.choices[0]?.message.tool_calls ?? [];
        const context: MemoryToolContext = {
          attemptId: input.attemptId,
          reader,
          phase: "retrieve",
          run: deps.run,
          activeFeature: feature,
          budget: {
            retrievalCallsRemaining: RETRIEVAL_MODEL_ATTEMPT_BUDGET - events.length,
            memoryHitsRemaining,
          },
        };
        group = await executeMemoryRetrieve(context, toolCalls);

        const id = toolCallId(toolCalls);
        if (id !== null) {
          messages.push(turn);
          messages.push({ role: "assistant", content: null, tool_calls: toolCalls } as OpenAI.ChatCompletionAssistantMessageParam);
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: serializeRetrieveResult(group),
          } as OpenAI.ChatCompletionToolMessageParam);
        } else if (isRetryableFailure(group) && attempt < maxAttempts) {
          messages.push({
            role: "user",
            content: `memory_retrieve failed with ${group.failure}; retry the same active feature once.`,
          });
        }
      } catch (error) {
        if (error instanceof MemoryToolValidationError) throw error;
        group = failedGroup(input.attemptId, feature, isTimeoutFailure(error) ? "timeout" : "memory_error");
      }

      sequence += 1;
      events.push(toolEvent(input.attemptId, group, sequence));
      memoryHitsRemaining -= group.hits.length;
      finalGroup = group;

      if (!isRetryableFailure(group) || attempt === maxAttempts) break;
    }
    if (finalGroup !== null) groups.push(finalGroup);
  }

  const analyzeTurn: OpenAI.ChatCompletionMessageParam = {
    role: "user",
    content: [
      { type: "text", text: analyzePrompt(observations, groups) },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
  const analyzeResponse = await client.chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    seed: SEED,
    provider: PROVIDER,
    messages: [...messages, analyzeTurn],
    tool_choice: "none",
    parallel_tool_calls: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: "location", strict: true, schema: GUESS_SCHEMA },
    },
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);
  const guess = parseGuess(analyzeResponse.choices[0]?.message.content, analyzeResponse.provider);
  const trace: AttemptTrace = { attemptId: input.attemptId, groups, episodes: [], events };
  return {
    attemptId: input.attemptId,
    guess,
    observations,
    memoryGroups: groups,
    episodes: [],
    trace,
  };
}
