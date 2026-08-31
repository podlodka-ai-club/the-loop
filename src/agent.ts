/**
 * Port of tmp/geolocate.py: guess where a photo was taken.
 *
 * The tracing import must stay first so the OpenAI client is patched before use.
 */
import { provider } from "./tracing.ts";

import { basename, extname } from "node:path";
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import type { Hint } from "./memory.ts";

export { provider };

export type Guess = {
  latitude: number;
  longitude: number;
  place: string;
  confidence: number;
  reasoning: string;
  /** Provider that actually served the response, as reported by OpenRouter. */
  provider: string;
};

/** The model produced output that is not a usable Guess. Track separately from accuracy. */
export class UnparseableOutputError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = "UnparseableOutputError";
    this.raw = raw;
  }
}

const PROMPT =
  "You are a geolocation expert. Look at this landscape photo and guess where " +
  "it was taken. Use terrain, vegetation, architecture, sky and any visible text. " +
  "Always give your single best guess, even when you are unsure.";

/**
 * Lessons are appended to the prompt, never sent as tool calls the model may choose
 * to make. Comparing memory-on with memory-off requires that both runs issue exactly
 * one request per image; a model that decides for itself whether to search turns the
 * comparison into a measurement of that decision.
 */
function withHints(hints: readonly Hint[]): string {
  if (hints.length === 0) return PROMPT;
  const lines = hints.map((hint) => `- ${hint.text}`).join("\n");
  return (
    `${PROMPT}\n\n` +
    "Notes you wrote after earlier attempts. Each one may be wrong, and none of them " +
    "describes this photo. Use a note only where it agrees with what you can see.\n" +
    `${lines}`
  );
}

const SCHEMA = {
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

export const MODEL = process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/**
 * Decoding is pinned instead of sampled: temperature 0 plus a fixed seed, so two
 * runs over the same frozen sample differ only where the provider itself is
 * nondeterministic. The Cerebras baseline used temperature 1.0 with top_p 0.95 and
 * three A/A runs to bound decode noise; that number is not comparable with this one.
 */
const TEMPERATURE = Number(process.env.GEOLOCATE_TEMPERATURE ?? 0);
const SEED = Number(process.env.GEOLOCATE_SEED ?? 1);

/**
 * OpenRouter routes one model slug to many providers, and a single provider can
 * serve several quantizations of it. Pinning `order` alone still lets the request
 * land on an fp4 endpoint, so the quantization is pinned too.
 *
 * The list has two entries rather than one because a single provider's per-minute
 * quota was the throughput ceiling: half of a sequential 200-image run came back
 * 429. Both listed providers serve bf16, so moving between them does not change the
 * weights - only the queue. `allow_fallbacks: false` still forbids everything
 * outside the list, so an fp4 endpoint can never answer.
 *
 * Venice does not accept `seed`. At temperature 0 that costs little, but it is the
 * reason the provider that served each response is recorded per item.
 */
const PROVIDERS = (process.env.OPENROUTER_PROVIDER ?? "Novita,Venice")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");

const PROVIDER = {
  order: PROVIDERS,
  allow_fallbacks: false,
  quantizations: [process.env.OPENROUTER_QUANTIZATION ?? "bf16"],
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Export it before running the agent.`);
  }
  return value;
}

let cachedClient: OpenAI | undefined;

function client(): OpenAI {
  cachedClient ??= new OpenAI({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    baseURL: BASE_URL,
  });
  return cachedClient;
}

function parseGuess(raw: string): Guess {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnparseableOutputError("response is not valid JSON", raw);
  }
  if (typeof value !== "object" || value === null) {
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
    provider: "",
  };
}

const tracer = trace.getTracer("geolocate");

/**
 * Guess the location of one photo. Emits one AGENT span with a nested LLM span.
 *
 * `hints` is the seam for memory. With none it behaves exactly as before, so a
 * memory-off run is unchanged by this parameter existing.
 *
 * Frames are sent whole. The corpus screen rejects any frame with a burned-in
 * overlay, so there is nothing to crop here.
 */
export function geolocate(imagePath: string, hints: readonly Hint[] = []): Promise<Guess> {
  return tracer.startActiveSpan("geolocate", async (span) => {
    span.setAttributes({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.INPUT_VALUE]: imagePath,
      [SemanticConventions.INPUT_MIME_TYPE]: "text/plain",
      "geolocate.image.id": basename(imagePath, extname(imagePath)),
      "geolocate.model": MODEL,
      "geolocate.temperature": TEMPERATURE,
      "geolocate.seed": SEED,
      "geolocate.hint_count": hints.length,
      "geolocate.hint_ids": hints.map((hint) => hint.lessonId).join(","),
    });
    try {
      const response = await client().chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        seed: SEED,
        // `provider` is an OpenRouter extension, absent from the OpenAI schema.
        provider: PROVIDER,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: withHints(hints) },
              { type: "image_url", image_url: { url: await toDataUri(imagePath) } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "location", strict: true, schema: SCHEMA },
        },
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const raw = response.choices[0]?.message.content;
      if (!raw) {
        throw new UnparseableOutputError("model returned no content", "");
      }
      const guess = parseGuess(raw);
      guess.provider = (response as { provider?: string }).provider ?? "unknown";

      span.setAttributes({
        [SemanticConventions.OUTPUT_VALUE]: JSON.stringify(guess),
        [SemanticConventions.OUTPUT_MIME_TYPE]: "application/json",
        "geolocate.latitude": guess.latitude,
        "geolocate.longitude": guess.longitude,
        "geolocate.confidence": guess.confidence,
        "geolocate.provider": guess.provider,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return guess;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof UnparseableOutputError) {
        span.setAttribute("geolocate.failure", "unparseable");
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
