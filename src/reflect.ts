/**
 * Reflection: turn one scored attempt into a lesson.
 *
 * Runs only in training, only after ground truth is revealed. The image is sent again
 * on purpose - the question is which features in the frame pointed at the right answer,
 * and a model that cannot see the frame can only rewrite its own earlier prose.
 *
 * ## Why the lesson is about a region, not a country
 *
 * Measured on 31 August over 99 eval frames: the country was named correctly on 49 of
 * them, and the median error inside those 49 was still 515 km, with 26 of them past
 * 500 km. Half the error lives inside the right country. A lesson shaped "this cue
 * means Brazil" has nothing to say about that half, which is why three different
 * retrieval schemes all failed to move the number - the memory did not contain the
 * kind of statement the task needed.
 *
 * ## What a lesson must contain
 *
 * Three parts, each enforced rather than requested:
 *
 * - a concrete region, from the dataset's own labels, not a country;
 * - a concrete second place it is confused with - "Punjab, not Sindh", never
 *   "South Asia", because a contrast against a continent cannot be checked against
 *   a photograph;
 * - a cue visible in the frame that separates the two.
 *
 * A lesson missing any of the three is refused and counted. The earlier prompt asked
 * for discrimination and got advice: of 28 lessons, 12 were variations of "do not
 * over-rely on vegetation" and exactly one named a concrete second place. Advice
 * cannot be applied to a photograph, and a store full of it is what a retriever was
 * being blamed for.
 */
import { trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import type { LessonInput } from "./memory/memory.ts";

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

/**
 * Below this the attempt was not a guess.
 *
 * A vision model cannot derive a coordinate to within a kilometre from pixels. When it
 * does, it read the answer somewhere - a burned-in overlay, an address on a van, a
 * memorised datapoint. Reflecting on such an attempt produced a lesson that said "the
 * email address mentions the district, the guess was already correct", which teaches
 * nothing and occupies a slot in every later prompt.
 */
const LEAK_THRESHOLD_KM = 1;

/** Contrasts too broad to check against a photograph. */
const VAGUE_PLACES = [
  "northern europe", "southern europe", "western europe", "eastern europe", "europe",
  "north america", "south america", "central america", "latin america", "america",
  "southeast asia", "south asia", "east asia", "central asia", "asia",
  "north africa", "west africa", "east africa", "southern africa", "africa",
  "the midwest", "the south", "the tropics", "the caribbean", "the balkans",
  "oceania", "scandinavia", "the middle east", "the pacific northwest",
  "the american southwest", "the great plains", "the steppe",
];

/** Phrases that mark advice rather than a rule. */
const HEDGES = [
  "over-rely", "over rely", "overrely", "over-relying", "over-weight", "over-index",
  "over-generali", "over-specif", "avoid defaulting", "be cautious", "do not assume",
  "unreliable", "not reliable", "without verifying", "difficult to distinguish",
];

const SCHEMA = {
  type: "object",
  properties: {
    region: { type: "string" },
    confusedWith: { type: "string" },
    cue: { type: "string" },
    triggers: { type: "array", items: { type: "string" } },
    content: { type: "string" },
  },
  required: ["region", "confusedWith", "cue", "triggers", "content"],
  additionalProperties: false,
} as const;

const PROMPT = `You guessed where this photo was taken and you were wrong. You are now told the truth.

Write one rule your future self can apply to a different photograph of the same area.

Fields:
- region: the true region, exactly as given below. A region or province, never a country.
- confusedWith: the specific place your guess landed in or near, named as a region, province or city. It must be a real named place. A continent, a hemisphere or a phrase like "Southeast Asia" is not acceptable.
- cue: one thing visible in THIS frame that separates region from confusedWith. It must be something a camera records: a marking colour, a pole shape, a plate colour, a script, a surface, a species, a landform.
- triggers: 2 to 4 short lowercase noun phrases naming what to look for. No place names.
- content: one or two sentences stating the rule. It must name both places and the cue, in the form "<cue> means <region>, not <confusedWith>".

Rules:
- Never write advice. "Do not over-rely on vegetation", "be careful", "this is unreliable" are rejected: they cannot be applied to a photograph.
- Never contrast against a continent or a compass region.
- Cite only what is visible in this frame.

Answer as JSON matching the schema.`;

let cached: OpenAI | undefined;
function client(): OpenAI {
  cached ??= new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY ?? "", baseURL: BASE_URL });
  return cached;
}

const tracer = trace.getTracer("reflect");

export type Attempt = {
  attemptId: string;
  imagePath: string;
  guess: { latitude: number; longitude: number; place: string };
  truth: {
    latitude: number;
    longitude: number;
    country: string;
    region: string;
    subRegion: string;
    city: string;
  };
  distanceKm: number;
};

/** Why a lesson was not written. Counted per run so refusals stay visible. */
export type RefusalReason =
  | "leak"
  | "no_response"
  | "empty_content"
  | "vague_contrast"
  | "missing_cue"
  | "hedging"
  | "error";

export type ReflectOutcome =
  | { ok: true; lesson: LessonInput }
  | { ok: false; reason: RefusalReason; detail: string };

function isVague(place: string): boolean {
  const normalized = place.trim().toLowerCase();
  if (normalized === "") return true;
  return VAGUE_PLACES.some(
    (vague) => normalized === vague || normalized === vague.replace(/^the /, ""),
  );
}

function hedges(content: string): string | null {
  const normalized = content.toLowerCase();
  return HEDGES.find((phrase) => normalized.includes(phrase)) ?? null;
}

export async function reflect(attempt: Attempt): Promise<ReflectOutcome> {
  if (attempt.distanceKm < LEAK_THRESHOLD_KM) {
    return {
      ok: false,
      reason: "leak",
      detail: `${(attempt.distanceKm * 1000).toFixed(0)} m from truth - read, not inferred`,
    };
  }

  return tracer.startActiveSpan("reflect", async (span) => {
    try {
      const place = [attempt.truth.city, attempt.truth.subRegion, attempt.truth.region]
        .filter((part) => part.trim() !== "")
        .join(", ");
      const facts =
        `Your guess: ${attempt.guess.place} at ${attempt.guess.latitude.toFixed(4)}, ` +
        `${attempt.guess.longitude.toFixed(4)}.\n` +
        `True location: ${place || attempt.truth.country} (${attempt.truth.country}) at ` +
        `${attempt.truth.latitude.toFixed(4)}, ${attempt.truth.longitude.toFixed(4)}.\n` +
        `You were off by ${attempt.distanceKm.toFixed(0)} km.\n` +
        `Use "${attempt.truth.region || attempt.truth.country}" as the region field.`;

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
              { type: "image_url", image_url: { url: await toDataUri(attempt.imagePath) } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "lesson", strict: true, schema: SCHEMA },
        },
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const raw = response.choices[0]?.message.content;
      if (!raw) return { ok: false as const, reason: "no_response" as const, detail: "" };

      const parsed = JSON.parse(raw) as Partial<{
        region: string; confusedWith: string; cue: string; triggers: string[]; content: string;
      }>;
      const content = (parsed.content ?? "").trim();
      const confusedWith = (parsed.confusedWith ?? "").trim();
      const cue = (parsed.cue ?? "").trim();

      if (content === "") return { ok: false as const, reason: "empty_content" as const, detail: "" };
      if (isVague(confusedWith)) {
        return { ok: false as const, reason: "vague_contrast" as const, detail: confusedWith };
      }
      if (cue === "") return { ok: false as const, reason: "missing_cue" as const, detail: "" };
      const hedge = hedges(content);
      if (hedge !== null) return { ok: false as const, reason: "hedging" as const, detail: hedge };

      const triggers = Array.isArray(parsed.triggers)
        ? parsed.triggers
            .filter((t): t is string => typeof t === "string" && t.trim() !== "")
            .map((t) => t.trim().toLowerCase())
        : [];

      span.setAttributes({ "reflect.trigger_count": triggers.length, "reflect.cue": cue });

      return {
        ok: true as const,
        lesson: {
          content,
          sourceAttemptId: attempt.attemptId,
          triggers: triggers.length > 0 ? triggers : [cue.toLowerCase()],
          region: (parsed.region ?? attempt.truth.region ?? attempt.truth.country).trim(),
        },
      };
    } catch (error) {
      span.recordException(error as Error);
      return { ok: false as const, reason: "error" as const, detail: (error as Error).message };
    } finally {
      span.end();
    }
  });
}
