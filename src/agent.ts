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
import { CROP_BOTTOM_FRACTION, toDataUri } from "./image.ts";

export { provider };

export type Guess = {
  latitude: number;
  longitude: number;
  place: string;
  confidence: number;
  reasoning: string;
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

export const MODEL = process.env.GEOLOCATE_MODEL ?? "gemma-4-31b";

const BASE_URL = process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";

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
    apiKey: requireEnv("CEREBRAS_API_KEY"),
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
  };
}

const tracer = trace.getTracer("geolocate");

/** Guess the location of one photo. Emits one AGENT span with a nested LLM span. */
export function geolocate(imagePath: string): Promise<Guess> {
  return tracer.startActiveSpan("geolocate", async (span) => {
    span.setAttributes({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.INPUT_VALUE]: imagePath,
      [SemanticConventions.INPUT_MIME_TYPE]: "text/plain",
      "geolocate.image.id": basename(imagePath, extname(imagePath)),
      "geolocate.model": MODEL,
      "geolocate.crop_bottom": CROP_BOTTOM_FRACTION,
    });
    try {
      const response = await client().chat.completions.create({
        model: MODEL,
        temperature: 1.0,
        top_p: 0.95,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: await toDataUri(imagePath) } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "location", strict: true, schema: SCHEMA },
        },
      });

      const raw = response.choices[0]?.message.content;
      if (!raw) {
        throw new UnparseableOutputError("model returned no content", "");
      }
      const guess = parseGuess(raw);

      span.setAttributes({
        [SemanticConventions.OUTPUT_VALUE]: JSON.stringify(guess),
        [SemanticConventions.OUTPUT_MIME_TYPE]: "application/json",
        "geolocate.latitude": guess.latitude,
        "geolocate.longitude": guess.longitude,
        "geolocate.confidence": guess.confidence,
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
