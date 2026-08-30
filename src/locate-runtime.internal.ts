import OpenAI from "openai";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { UnparseableOutputError, type Guess } from "./agent.ts";
import { toDataUri } from "./image.ts";
import {
  eligibleFeatureObservations,
  observe,
  type FeatureObservation,
  type ObserveResult,
} from "./observe.ts";
import { bindFeatureScopedReader, type MemoryReader } from "./memory/memory.ts";
import {
  attachLocatePartialResult,
  type LocatePartialResult,
  type LocatePartialState,
} from "./locate-partial.internal.ts";
import type { LocateDeps } from "./locate.ts";
import {
  episodeCandidatesFromGroups,
  type EpisodeCandidate,
} from "./tools/episode-ledger.internal.ts";
import { executeMemoryRetrieveWithRuntimeBudget } from "./tools/memory-runtime.internal.ts";
import {
  MEMORY_RETRIEVE_TOOL,
  MemoryToolValidationError,
  validateMemoryRunConfig,
  type AttemptTrace,
  type EpisodeTrace,
  type FeatureMemoryGroup,
  type LocateResult,
  type RetrievalFailure,
  type ToolEvent,
} from "./tools/memory.ts";

export type LocateRuntimeChatClient = {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<LocateRuntimeChatCompletion>;
    };
  };
};

export type LocateRuntimeChatCompletion = {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: unknown[];
    };
  }>;
  provider?: string;
};

export type LocateRuntimeHooks = {
  observe?: (imagePath: string) => Promise<ObserveResult>;
  imageDataUri?: (imagePath: string) => Promise<string>;
  client?: LocateRuntimeChatClient;
  sleep?: (ms: number) => Promise<void>;
};

export type LocateRuntimeDeps = LocateDeps & LocateRuntimeHooks;

type LocateChatClient = LocateRuntimeChatClient;

type LocateChatCompletion = LocateRuntimeChatCompletion;

type LocateChatClientShape = {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<LocateChatCompletion>;
    };
  };
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
const ANALYZE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

let cachedClient: OpenAI | undefined;
const tracer = trace.getTracer("locate");

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
  return cachedClient as LocateChatClientShape;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorProperty(error: unknown, property: string): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[property] : undefined;
}

function isRateLimit(error: unknown): boolean {
  const status = errorProperty(error, "status");
  const statusCode = errorProperty(error, "statusCode");
  const code = errorProperty(error, "code");
  const name = errorProperty(error, "name");
  if (status === 429 || statusCode === 429 || code === 429 || code === "429") return true;
  if (code === "rate_limit_exceeded" || name === "RateLimitError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit");
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
  return bindFeatureScopedReader(reader);
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

function setTraceAttributes(
  span: Span,
  result: LocatePartialResult,
  episodeCandidateCount = episodeCandidatesFromGroups(result.attemptId, result.memoryGroups).length,
): void {
  const hitIds = result.memoryGroups.flatMap((group) => group.hits.map((hit) => hit.memoryHitId));
  span.setAttributes({
    "locate.attempt_id": result.attemptId,
    "locate.observation_count": result.observations.length,
    "locate.memory_group_count": result.memoryGroups.length,
    "locate.memory_hit_count": hitIds.length,
    "locate.episode_candidate_count": episodeCandidateCount,
    "locate.episode_count": result.episodes.length,
    "locate.memory_hit_ids": hitIds.join(","),
    "locate.memory_groups": JSON.stringify(
      result.memoryGroups.map((group) => ({
        featureKey: group.feature.key,
        query: group.query,
        status: group.status,
        failure: group.failure,
        hitIds: group.hits.map((hit) => hit.memoryHitId),
        providerIds: group.hits.map((hit) => hit.providerId),
      })),
    ),
  });
}

async function createAnalyzeCompletionWithBackoff(
  client: LocateChatClient,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  wait: (ms: number) => Promise<void>,
): Promise<LocateChatCompletion> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ANALYZE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await client.chat.completions.create(params);
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === ANALYZE_RETRY_DELAYS_MS.length) throw error;
      await wait(ANALYZE_RETRY_DELAYS_MS[attempt] ?? 60_000);
    }
  }
  throw lastError;
}

export async function locateWithRuntime(
  input: { attemptId: string; imagePath: string },
  deps: LocateRuntimeDeps,
): Promise<LocateResult> {
  return tracer.startActiveSpan("locate", async (span) => {
    let partialResult: LocatePartialState | null = null;
    try {
      const result = await locateAttempt(input, deps, (partial, episodeCandidates) => {
        partialResult = { ...partial, episodeCandidates };
        setTraceAttributes(span, partial, episodeCandidates.length);
      });
      setTraceAttributes(span, result);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (partialResult !== null) attachLocatePartialResult(error, partialResult);
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function locateAttempt(
  input: { attemptId: string; imagePath: string },
  deps: LocateRuntimeDeps,
  onPartialResult?: (result: LocatePartialResult, episodeCandidates: EpisodeCandidate[]) => void,
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
        const context = {
          attemptId: input.attemptId,
          reader,
          phase: "retrieve" as const,
          run: deps.run,
          activeFeature: feature,
          budget: {
            retrievalCallsRemaining: RETRIEVAL_MODEL_ATTEMPT_BUDGET - events.length,
            memoryHitsRemaining,
          },
        };
        group = await executeMemoryRetrieveWithRuntimeBudget(context, toolCalls);

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

  const episodeCandidates: EpisodeCandidate[] = episodeCandidatesFromGroups(input.attemptId, groups);
  const episodes: EpisodeTrace[] = [];
  const trace: AttemptTrace = { attemptId: input.attemptId, groups, episodes, events };
  onPartialResult?.({
    attemptId: input.attemptId,
    observations,
    memoryGroups: groups,
    episodes,
    trace,
  }, episodeCandidates);

  const analyzeTurn: OpenAI.ChatCompletionMessageParam = {
    role: "user",
    content: [
      { type: "text", text: analyzePrompt(observations, groups) },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
  const analyzeResponse = await createAnalyzeCompletionWithBackoff(client, {
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
  } as OpenAI.ChatCompletionCreateParamsNonStreaming, deps.sleep ?? sleep);
  const guess = parseGuess(analyzeResponse.choices[0]?.message.content, analyzeResponse.provider);
  return {
    attemptId: input.attemptId,
    guess,
    observations,
    memoryGroups: groups,
    episodes,
    trace,
  };
}
