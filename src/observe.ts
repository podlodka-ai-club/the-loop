/**
 * First of two calls: list what is visible in the frame, so memory has something to
 * search with.
 *
 * Why this exists. `recall` used to run before anything had looked at the image, so
 * its query was always empty: ranking had no input, and every query-based backend
 * (mem0, xmemory, hindsight) would have been asked to search for nothing.
 *
 * What this is NOT. It does not replace looking at the photo. An earlier two-phase
 * design passed only this feature list to the solver and dropped the image; measured
 * on 26 August, its median error was 5711 km against 772 km for the single call that
 * kept the image. Whatever this step fails to notice is not lost, because the solver
 * still sees the frame itself. The output is a search query, not a summary.
 *
 * Features are cached on disk by image and prompt version: a memory-on and a
 * memory-off run over the same corpus must issue the same observation, and paying
 * for it twice would double the quota cost of every comparison.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";

const MODEL = process.env.OBSERVE_MODEL ?? process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const TEMPERATURE = Number(process.env.OBSERVE_TEMPERATURE ?? 0);
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

const CACHE_DIR = process.env.OBSERVE_CACHE_DIR ?? join("tmp", "cache", "observe");

/**
 * Slot list, from the feature table a professional player works through
 * (docs/research/geo-guessr/rainbolt-wired.md). Slots are mandatory and answered
 * with "not visible" when absent: a silent omission cannot be told apart from a
 * feature the model never looked for, and both end up as a missing search term.
 *
 * The Street View row of that table is dropped - these are dashcam frames.
 */
const PROMPT = `You are a visual observation instrument. Report only what is literally visible in this photograph.

Emit exactly one entry per slot, in this order. If a slot is not visible, emit it with the value "not visible". Never omit a slot.

1. "traffic side: ..." - side vehicles drive on, camera position in the lane, side of the steering wheel.
2. "script and language: ..." - writing system and language of ANY text, including partial or blurred. Name the script and any diacritics.
3. "visible text: ..." - readable strings, quoted verbatim, including fragments.
4. "plates: ..." - colour and proportions of number plates, front and rear.
5. "poles: ..." - material, shape, crossarms, insulators of utility and light poles.
6. "bollards and barriers: ..." - bollard shape and reflector colour, guardrail profile, fencing.
7. "road markings: ..." - colour, pattern and position of every line, including edge and centre.
8. "road surface: ..." - material, colour, width, condition.
9. "vegetation: ..." - species or type, density, colour, season.
10. "terrain and soil: ..." - relief, soil colour and texture, rocks, water, horizon shape.
11. "built environment: ..." - building materials, roof shapes, fences, utility boxes, sign shapes and colours.
12. "vehicles: ..." - makes, body types, roof racks, bull bars, liveries.

Hard rules:
- Never name a country, region, city or continent, and never say what a feature implies.
- One short phrase per slot, after the slot prefix.

Answer with JSON only:
{"features": ["traffic side: ...", "script and language: ...", "..."]}`;

/** Bumping this invalidates the cache: a changed prompt is a changed observation. */
const PROMPT_VERSION = createHash("sha256").update(PROMPT).digest("hex").slice(0, 8);

const SCHEMA = {
  type: "object",
  properties: { features: { type: "array", items: { type: "string" } } },
  required: ["features"],
  additionalProperties: false,
} as const;

let cached: OpenAI | undefined;
function client(): OpenAI {
  cached ??= new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseURL: BASE_URL,
  });
  return cached;
}

const tracer = trace.getTracer("observe");

function cachePath(imagePath: string): string {
  const key = createHash("sha256").update(`${PROMPT_VERSION}:${imagePath}`).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${key}.json`);
}

/**
 * Returns the observed features, or an empty list when the call fails.
 *
 * A failure here must not fail the task. Losing the search query costs relevance;
 * losing the row costs the denominator, which is worse and harder to notice.
 */
export async function observe(imagePath: string): Promise<string[]> {
  const path = cachePath(imagePath);
  try {
    return JSON.parse(await readFile(path, "utf8")) as string[];
  } catch {
    // Not cached yet.
  }

  return tracer.startActiveSpan("observe", async (span) => {
    try {
      const response = await client().chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        seed: SEED,
        provider: PROVIDER,
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
          json_schema: { name: "observation", strict: true, schema: SCHEMA },
        },
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const raw = response.choices[0]?.message.content;
      const parsed = raw ? (JSON.parse(raw) as { features?: unknown }) : {};
      const features = Array.isArray(parsed.features)
        ? parsed.features
            .filter((f): f is string => typeof f === "string" && f.trim() !== "")
            .map((f) => f.trim().toLowerCase())
        : [];

      span.setAttributes({
        "observe.feature_count": features.length,
        "observe.prompt_version": PROMPT_VERSION,
      });

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(features), "utf8");
      return features;
    } catch (error) {
      span.recordException(error as Error);
      return [];
    } finally {
      span.end();
    }
  });
}
