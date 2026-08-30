/**
 * Reflection: turn one scored attempt into a lesson.
 *
 * Runs only in training, only after ground truth is revealed. The image is sent
 * again on purpose - the question is which features in the frame pointed at the
 * right answer, and a model that cannot see the frame can only rewrite its own
 * earlier prose.
 */
import { trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import type { LegacyLessonInput } from "./memory/memory.ts";

const MODEL = process.env.REFLECT_MODEL ?? process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const TEMPERATURE = Number(process.env.REFLECT_TEMPERATURE ?? 0);
const SEED = Number(process.env.GEOLOCATE_SEED ?? 1);

/** Same routing policy as the solver, see `src/agent.ts`. */
const PROVIDER = {
  order: (process.env.OPENROUTER_PROVIDER ?? "Novita,Venice")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
  allow_fallbacks: false,
  quantizations: [process.env.OPENROUTER_QUANTIZATION ?? "bf16"],
} as const;

const SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string" },
    triggers: { type: "array", items: { type: "string" } },
    region: { type: "string" },
  },
  required: ["content", "triggers", "region"],
  additionalProperties: false,
} as const;

const PROMPT = `You guessed where this photo was taken and you were wrong. You are now told the truth.

Write one transferable lesson for your future self. The lesson must answer both halves:
- which features visible in this frame pointed at the true location
- why your guess went where it did instead

Rules:
- The lesson must be usable on a different photo. "This is Argentina" is worthless; "wooden poles with two crossarms plus dry scrub is Argentina, not Brazil" is not.
- Cite only features you can actually see in the frame.
- triggers: the observable features that should make this lesson come to mind. Short noun phrases, lowercase, no country names.
- region: ISO 3166-1 alpha-2 code of the true country.
- content: two sentences at most.

Answer as JSON matching the schema.`;

let cached: OpenAI | undefined;
function client(): OpenAI {
  cached ??= new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseURL: BASE_URL,
  });
  return cached;
}

const tracer = trace.getTracer("reflect");

export type Attempt = {
  attemptId: string;
  imagePath: string;
  guess: { latitude: number; longitude: number; place: string };
  truth: { latitude: number; longitude: number; country: string };
  distanceKm: number;
};

/** Returns null when the model gives nothing usable: a bad lesson is worse than none. */
export async function reflect(attempt: Attempt): Promise<LegacyLessonInput | null> {
  return tracer.startActiveSpan("reflect", async (span) => {
    try {
      const facts =
        `Your guess: ${attempt.guess.place} at ${attempt.guess.latitude.toFixed(4)}, ` +
        `${attempt.guess.longitude.toFixed(4)}.\n` +
        `True location: ${attempt.truth.country} at ${attempt.truth.latitude.toFixed(4)}, ` +
        `${attempt.truth.longitude.toFixed(4)}.\n` +
        `You were off by ${attempt.distanceKm.toFixed(0)} km.`;

      const response = await client().chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        seed: SEED,
        provider: PROVIDER,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${PROMPT}\n\n${facts}` },
              {
                type: "image_url",
                image_url: { url: await toDataUri(attempt.imagePath) },
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "lesson", strict: true, schema: SCHEMA },
        },
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const raw = response.choices[0]?.message.content;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<LegacyLessonInput>;
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (content === "") return null;

      const triggers = Array.isArray(parsed.triggers)
        ? parsed.triggers
            .filter((t): t is string => typeof t === "string" && t.trim() !== "")
            .map((t) => t.trim().toLowerCase())
        : [];

      span.setAttribute("reflect.trigger_count", triggers.length);
      return {
        content,
        sourceAttemptId: attempt.attemptId,
        triggers,
        region: typeof parsed.region === "string" ? parsed.region.trim().toUpperCase() : "",
      };
    } catch (error) {
      span.recordException(error as Error);
      return null;
    } finally {
      span.end();
    }
  });
}
