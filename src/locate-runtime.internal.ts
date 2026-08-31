import OpenAI from "openai";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { UnparseableOutputError, type Guess } from "./agent.ts";
import { toDataUri } from "./image.ts";
import {
  normalizeObserveResult,
  observe,
  type FeatureObservation,
  type ObserveResult,
} from "./observe.ts";
import {
  bindFeatureScopedReader,
  createMemorySourceBinding,
  createMemorySourceResolver,
  createFrozenMemorySnapshotBinding,
  MemoryBindingError,
  resolveMemoryBinding,
  validateMemoryBinding,
  type MemoryBinding,
  type MemoryReader,
  type MemorySourceResolver,
} from "./memory/memory.ts";
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
  serializeMemoryRetrieveResult,
  validateMemoryRunConfig,
  type AttemptTrace,
  type EpisodeTrace,
  type FeatureMemoryGroup,
  type LocateResult,
  type RetrievalFailure,
  type ToolEvent,
} from "./tools/memory.ts";
import { loadPrompt, PROMPT_VERSIONS } from "./promts.ts";
import { sharedMemoryPrompt } from "./memory/memory.ts";

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

export type LocateRuntimeDeps = LocateDeps & LocateRuntimeHooks & {
  /** Internal hand-off from the task composition root; not part of public LocateDeps. */
  memoryBinding?: MemoryBinding;
};

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
  "memory_error",
  "unavailable",
  "timeout",
];
const RETRIEVAL_MODEL_ATTEMPT_BUDGET = 24;
const MEMORY_BINDING_ATTEMPT_DELAYS_MS = [1_000] as const;
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
  retryCount = 0,
): FeatureMemoryGroup {
  return {
    attemptId,
    feature,
    query: null,
    status: "failed",
    hits: [],
    failure,
    retryCount,
  };
}

function isRetryableFailure(group: FeatureMemoryGroup): boolean {
  return group.status === "failed" && RETRYABLE_TOOL_FAILURES.includes(group.failure as RetrievalFailure);
}

function featureScopedReader(reader: MemoryReader): MemoryReader {
  return bindFeatureScopedReader(reader);
}

function nullMemoryResolver(): MemorySourceResolver {
  return {
    async resolve(): Promise<never> {
      throw new MemoryBindingError("memory_not_found", "null memory does not resolve a provider binding");
    },
  };
}

function resolverForDeps(deps: LocateRuntimeDeps): MemorySourceResolver {
  if (deps.memorySourceResolver !== undefined) return deps.memorySourceResolver;
  if (deps.run.memoryRef === null) return nullMemoryResolver();
  const memory = deps.memory;
  if (memory === undefined) {
    throw new MemoryBindingError("memory_not_found", `no memory binding for ${deps.run.memoryRef}`);
  }
  const loadSnapshot = memory.loadSnapshot;
  return createMemorySourceResolver(createMemorySourceBinding({
    memoryRef: deps.run.memoryRef,
    memory,
    provider: null,
    ...(loadSnapshot === undefined
      ? {}
      : {
          loadSnapshot: async (snapshotId: string) => createFrozenMemorySnapshotBinding({
            memoryRef: deps.run.memoryRef!,
            snapshotId,
            reader: await loadSnapshot(snapshotId),
          }),
        }),
  }));
}

export async function resolveBindingWithPolicy(
  run: LocateRuntimeDeps["run"],
  resolver: MemorySourceResolver,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Awaited<ReturnType<typeof resolveMemoryBinding>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MEMORY_BINDING_ATTEMPT_DELAYS_MS.length; attempt += 1) {
    try {
      return await resolveMemoryBinding(run, resolver);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof MemoryBindingError) ||
        (error.code !== "unavailable" && error.code !== "timeout") ||
        attempt === MEMORY_BINDING_ATTEMPT_DELAYS_MS.length
      ) {
        throw error;
      }
      await wait(MEMORY_BINDING_ATTEMPT_DELAYS_MS[attempt] ?? 1_000);
    }
  }
  throw lastError;
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
  return `${loadPrompt("retrieve")}\n\n${JSON.stringify({
    active_feature: feature.key,
    observation: feature.text,
  })}`;
}

function analyzePrompt(observations: readonly FeatureObservation[], groups: readonly FeatureMemoryGroup[]): string {
  return `${loadPrompt("analyze")}\n\n${JSON.stringify({
    observations,
    memory_groups: groups,
  })}`;
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
  memoryRef: string | null,
): ToolEvent {
  const prompt = memoryRef === null ? null : sharedMemoryPrompt("retrieve");
  return {
    attemptId,
    phase: "retrieve",
    operation: "memory_retrieve",
    featureKey: group.feature.key,
    memoryHitId: null,
    status: group.status === "failed" ? group.failure ?? "failed" : group.status,
    sequence,
    memoryRef,
    ...(prompt === null ? {} : { promptVersion: prompt.version, promptDigest: prompt.digest }),
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
    "locate.retrieve_prompt_version": PROMPT_VERSIONS.retrieve,
    "locate.analyze_prompt_version": PROMPT_VERSIONS.analyze,
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
  const maxAttempts = maxRetrievalToolAttempts(deps.maxToolAttemptsPerFeature);
  let binding: MemoryBinding;
  if (deps.memoryBinding !== undefined) {
    validateMemoryBinding(deps.memoryBinding, deps.run);
    if (deps.memory !== undefined || deps.memorySourceResolver !== undefined) {
      throw new MemoryBindingError(
        "memory_mismatch",
        "a resolved memoryBinding cannot be combined with memory or memorySourceResolver",
      );
    }
    binding = deps.memoryBinding;
  } else {
    const resolver = resolverForDeps(deps);
    binding = await resolveBindingWithPolicy(deps.run, resolver, deps.sleep ?? sleep);
  }
  if (binding.mode !== deps.run.mode || binding.memoryRef !== deps.run.memoryRef) {
    throw new MemoryBindingError("memory_mismatch", "memory binding mode does not match the run mode");
  }
  const reader = binding.reader;
  const client = deps.client ?? defaultClient();
  const observeImage = deps.observe ?? observe;
  const observed = normalizeObserveResult(await observeImage(input.imagePath));
  const observations = observed.features;
  const imageUrl = await (deps.imageDataUri ?? toDataUri)(input.imagePath);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${loadPrompt("analyze")}\n\n${JSON.stringify({ observation: observed })}`,
        },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const groups: FeatureMemoryGroup[] = [];
  const events: ToolEvent[] = [];
  let sequence = 0;
  let memoryHitsRemaining = 60;

  const noMemoryGroup = (feature: FeatureObservation): FeatureMemoryGroup => ({
    attemptId: input.attemptId,
    feature,
    query: null,
    status: "no_hit",
    hits: [],
    failure: null,
    retryCount: 0,
  });

  if (deps.run.memoryRef === null) {
    for (const feature of observations) {
      const group = noMemoryGroup(feature);
      groups.push(group);
    }
  }

  for (const feature of deps.run.memoryRef === null ? [] : observations) {
    let finalGroup: FeatureMemoryGroup | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (events.length >= RETRIEVAL_MODEL_ATTEMPT_BUDGET) {
        const group = failedGroup(input.attemptId, feature, "budget_exhausted", attempt - 1);
        sequence += 1;
        events.push(toolEvent(input.attemptId, group, sequence, deps.run.memoryRef));
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
          promptPort: binding.promptPort,
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
            content: JSON.stringify(serializeMemoryRetrieveResult(group)),
          } as OpenAI.ChatCompletionToolMessageParam);
        } else if (isRetryableFailure(group) && attempt < maxAttempts) {
          messages.push({
            role: "user",
            content: `${loadPrompt("retrieve")}\n\n${JSON.stringify({
              active_feature: feature.key,
              observation: feature.text,
              previous_failure: group.failure,
              retry: true,
            })}`,
          });
        }
      } catch (error) {
        if (error instanceof MemoryToolValidationError) throw error;
        if (error instanceof MemoryBindingError) {
          // Provider availability is a sample-level concern. Do not turn it into a
          // fake feature failure and continue to analyze with a degraded memory run.
          throw error;
        } else {
          group = failedGroup(input.attemptId, feature, isTimeoutFailure(error) ? "timeout" : "memory_error");
        }
      }

      group = { ...group, retryCount: attempt - 1 };
      sequence += 1;
      events.push(toolEvent(input.attemptId, group, sequence, deps.run.memoryRef));
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
