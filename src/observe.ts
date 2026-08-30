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

export const FEATURE_KEYS = [
  "traffic_side",
  "script_and_language",
  "visible_text",
  "plates",
  "poles",
  "bollards_and_barriers",
  "road_markings",
  "road_surface",
  "vegetation",
  "terrain_and_soil",
  "built_environment",
  "vehicles",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureState = "visible" | "not_visible";

export type FeatureObservation = {
  key: FeatureKey;
  state: FeatureState;
  text: string;
};

export type ObserveResult = {
  features: FeatureObservation[];
  error: string | null;
};

export function eligibleFeatureObservations(
  features: readonly FeatureObservation[],
): FeatureObservation[] {
  return FEATURE_KEYS.flatMap((key) => {
    const feature = features.find((item) => item.key === key);
    return feature?.state === "visible" ? [feature] : [];
  });
}

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
 * (docs/research/geo-guessr/rainbolt-wired.md). The Street View row is dropped:
 * these are dashcam frames.
 */
const PROMPT = `You are a visual observation instrument. Report only what is literally visible in this photograph.

Emit exactly one object per feature key, in this order:
1. traffic_side - side vehicles drive on, camera position in the lane, side of the steering wheel.
2. script_and_language - writing system and language of ANY text, including partial or blurred. Name the script and any diacritics.
3. visible_text - readable strings, quoted verbatim, including fragments.
4. plates - colour and proportions of number plates, front and rear.
5. poles - material, shape, crossarms, insulators of utility and light poles.
6. bollards_and_barriers - bollard shape and reflector colour, guardrail profile, fencing.
7. road_markings - colour, pattern and position of every line, including edge and centre.
8. road_surface - material, colour, width, condition.
9. vegetation - species or type, density, colour, season.
10. terrain_and_soil - relief, soil colour and texture, rocks, water, horizon shape.
11. built_environment - building materials, roof shapes, fences, utility boxes, sign shapes and colours.
12. vehicles - makes, body types, roof racks, bull bars, liveries.

Hard rules:
- key must be exactly the registry key.
- state is "visible" only when the feature is literally visible, otherwise "not_visible".
- text is one short phrase of visual facts only.
- Never name a country, region, city or continent, and never say what a feature implies.
- For "not_visible", use an empty text string.

Answer with JSON only. The features array must contain all 12 feature objects.`;

/** Bumping this invalidates the cache: a changed prompt is a changed observation. */
const PROMPT_VERSION = createHash("sha256").update(PROMPT).digest("hex").slice(0, 8);

export const OBSERVE_SCHEMA = {
  type: "object",
  properties: {
    features: {
      type: "array",
      minItems: FEATURE_KEYS.length,
      maxItems: FEATURE_KEYS.length,
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: FEATURE_KEYS },
          state: { type: "string", enum: ["visible", "not_visible"] },
          text: { type: "string" },
        },
        required: ["key", "state", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["features"],
  additionalProperties: false,
} as const;

export type ObserveModelRequest = {
  imagePath: string;
  prompt: string;
  promptVersion: string;
  schema: typeof OBSERVE_SCHEMA;
};

export type ObserveDeps = {
  cacheDir?: string;
  promptVersion?: string;
  model?: (request: ObserveModelRequest) => Promise<string | null>;
};

let cached: OpenAI | undefined;
function client(): OpenAI {
  cached ??= new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseURL: BASE_URL,
  });
  return cached;
}

const tracer = trace.getTracer("observe");

function cachePath(imagePath: string, cacheDir: string, promptVersion: string): string {
  const key = createHash("sha256").update(`${promptVersion}:${imagePath}`).digest("hex").slice(0, 16);
  return join(cacheDir, `${key}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isFeatureObservation(value: unknown): value is FeatureObservation {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["key", "state", "text"]) &&
    FEATURE_KEYS.includes(value.key as FeatureKey) &&
    (value.state === "visible" || value.state === "not_visible") &&
    typeof value.text === "string"
  );
}

const GEO_CONTEXT_PATTERN =
  /\b(?:city|continent|country|district|municipality|prefecture|province|region|territory)\b/i;
const GEO_IMPLICATION_PATTERN =
  /\b(?:looks?\s+(?:like|as if|to be)|appears?\s+(?:like|to be)|seems?\s+(?:like|to be)|suggests?|implies?|indicates?|points?\s+to|typical\s+of|common\s+in|consistent\s+with|characteristic\s+of|associated\s+with|reminiscent\s+of)\b/i;
const GEO_STYLE_SUFFIXES = new Set(["coded", "inspired", "like", "looking", "style", "styled", "type"]);

const SUPPLEMENTAL_GEO_TERMS = [
  "africa",
  "african",
  "andean",
  "andes",
  "arabian",
  "argentinian",
  "asian",
  "australian",
  "balkan",
  "baltic",
  "bavarian",
  "brazilian",
  "british",
  "california",
  "californian",
  "canadian",
  "caucasus",
  "central american",
  "chilean",
  "chinese",
  "eastern european",
  "european",
  "french",
  "german",
  "iberian",
  "indian",
  "indonesian",
  "italian",
  "japanese",
  "kenyan",
  "latin american",
  "mediterranean",
  "mexican",
  "mongolian",
  "nordic",
  "north american",
  "norwegian",
  "paris",
  "parisian",
  "peruvian",
  "polish",
  "portuguese",
  "quebec",
  "quebecois",
  "russian",
  "scandinavian",
  "south american",
  "soviet",
  "spanish",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "vietnamese",
  "western european",
] as const;

function normalizeGeoText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function geoVariants(term: string): string[] {
  const normalized = normalizeGeoText(term);
  if (normalized === "") return [];
  const variants = [normalized];
  if (!normalized.includes(" ")) {
    if (normalized.endsWith("ia")) variants.push(`${normalized.slice(0, -2)}ian`);
    if (normalized.endsWith("a")) variants.push(`${normalized.slice(0, -1)}an`);
    if (normalized.endsWith("e")) variants.push(`${normalized}an`);
    if (normalized.endsWith("y")) variants.push(`${normalized.slice(0, -1)}ian`);
  }
  return variants;
}

function regionDisplayNames(): string[] {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  const names: string[] = [];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = `${String.fromCharCode(first)}${String.fromCharCode(second)}`;
      const name = displayNames.of(code);
      if (name !== undefined && name !== code) names.push(name);
    }
  }
  for (let code = 1; code <= 999; code += 1) {
    const region = String(code).padStart(3, "0");
    const name = displayNames.of(region);
    if (name !== undefined && name !== region) names.push(name);
  }
  return names;
}

const GEO_TERMS = new Set(
  [...regionDisplayNames(), ...SUPPLEMENTAL_GEO_TERMS].flatMap((term) => geoVariants(term)),
);
const GEO_PHRASES = [...GEO_TERMS].filter((term) => term.includes(" "));
const GEO_TOKENS = new Set([...GEO_TERMS].filter((term) => !term.includes(" ")));

const SCRIPT_LANGUAGE_GEO_TOKENS = new Set([
  "arabic",
  "armenian",
  "bengali",
  "bulgarian",
  "burmese",
  "cambodian",
  "chinese",
  "croatian",
  "czech",
  "danish",
  "dutch",
  "english",
  "estonian",
  "finnish",
  "french",
  "georgian",
  "german",
  "greek",
  "hebrew",
  "hindi",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "korean",
  "lao",
  "latvian",
  "lithuanian",
  "malay",
  "mongolian",
  "norwegian",
  "persian",
  "polish",
  "portuguese",
  "romanian",
  "russian",
  "serbian",
  "slovak",
  "slovenian",
  "spanish",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "urdu",
  "vietnamese",
]);

function containsGeographicImplication(featureKey: FeatureKey, text: string): boolean {
  if (text === "") return false;
  if (GEO_CONTEXT_PATTERN.test(text) || GEO_IMPLICATION_PATTERN.test(text)) return true;

  const normalized = ` ${normalizeGeoText(text)} `;
  if (GEO_PHRASES.some((term) => normalized.includes(` ${term} `))) return true;

  const tokens = normalized.trim().split(" ");
  const hasGeoStyle = tokens.some(
    (token, index) => GEO_TOKENS.has(token) && GEO_STYLE_SUFFIXES.has(tokens[index + 1] ?? ""),
  );
  if (hasGeoStyle) return true;

  const geoTokens = tokens.filter((token) => GEO_TOKENS.has(token));
  if (geoTokens.length === 0) return false;

  if (featureKey === "script_and_language") {
    return geoTokens.some((token) => !SCRIPT_LANGUAGE_GEO_TOKENS.has(token));
  }

  return true;
}

function normalizeFeatureObservation(value: FeatureObservation, index: number): FeatureObservation | null {
  if (value.key !== FEATURE_KEYS[index]) return null;
  const text = value.text.trim().replace(/\s+/g, " ");
  if (value.state === "not_visible") {
    return {
      key: value.key,
      state: value.state,
      text: "",
    };
  }
  if (containsGeographicImplication(value.key, text)) return null;
  return {
    key: value.key,
    state: value.state,
    text,
  };
}

function normalizeCachedObservation(value: unknown): ObserveResult | null {
  if (
    isRecord(value) &&
    (hasExactKeys(value, ["features", "error"]) || hasExactKeys(value, ["features"])) &&
    Array.isArray(value.features)
  ) {
    const features = value.features;
    const error = value.error;
    const normalized = normalizeObservationFeatures(features);
    if (normalized !== null) return { features: normalized, error: typeof error === "string" ? error : null };
  }
  return null;
}

function normalizeObservationFeatures(values: readonly unknown[]): FeatureObservation[] | null {
  if (values.length !== FEATURE_KEYS.length) return null;
  const normalized: FeatureObservation[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isFeatureObservation(value)) return null;
    const item = normalizeFeatureObservation(value, index);
    if (item === null) return null;
    normalized.push(item);
  }
  return normalized;
}

function parseObservation(raw: string | null): ObserveResult {
  if (raw === null || raw.trim() === "") return { features: [], error: "missing observation response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { features: [], error: "malformed observation response" };
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["features"]) ||
    !Array.isArray(parsed.features)
  ) {
    return { features: [], error: "malformed observation response" };
  }
  const features = normalizeObservationFeatures(parsed.features);
  if (features === null) return { features: [], error: "malformed observation response" };
  return { features, error: null };
}

async function defaultObserveModel(request: ObserveModelRequest): Promise<string | null> {
  const response = await client().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    seed: SEED,
    provider: PROVIDER,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: request.prompt },
          { type: "image_url", image_url: { url: await toDataUri(request.imagePath) } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "observation", strict: true, schema: request.schema },
    },
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);
  return response.choices[0]?.message.content ?? null;
}

/**
 * Returns the observed feature registry, or an error result when the call fails.
 *
 * A failure here must not fail the task. Losing the search query costs relevance;
 * losing the row costs the denominator, which is worse and harder to notice.
 */
export async function observe(imagePath: string, deps: ObserveDeps = {}): Promise<ObserveResult> {
  const cacheDir = deps.cacheDir ?? CACHE_DIR;
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const model = deps.model ?? defaultObserveModel;
  const path = cachePath(imagePath, cacheDir, promptVersion);
  try {
    const cachedResult = normalizeCachedObservation(JSON.parse(await readFile(path, "utf8")));
    if (cachedResult !== null) return cachedResult;
  } catch {
    // Not cached yet.
  }

  return tracer.startActiveSpan("observe", async (span) => {
    try {
      const raw = await model({
        imagePath,
        prompt: PROMPT,
        promptVersion,
        schema: OBSERVE_SCHEMA,
      });
      const result = parseObservation(raw);

      span.setAttributes({
        "observe.feature_count": result.features.length,
        "observe.prompt_version": promptVersion,
      });

      if (result.error === null) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(result), "utf8");
      }
      return result;
    } catch (error) {
      span.recordException(error as Error);
      return { features: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      span.end();
    }
  });
}
