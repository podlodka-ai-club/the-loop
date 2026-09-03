/**
 * Extract the visual cues that are actually present in one image.
 *
 * Observation is deliberately an open-vocabulary boundary. The model chooses
 * the useful cues for a particular frame; the application only supplies a
 * bounded transport contract and validates the result before it can influence
 * retrieval.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { toDataUri } from "./image.ts";
import { loadPrompt, PROMPT_VERSIONS } from "./promts.ts";
import { throttleOpenRouterRequest } from "./openrouter-throttle.ts";

export type FeatureKey = string;

export type FeatureObservation = {
  key: FeatureKey;
  text: string;
};

export type ObserveResult = {
  features: FeatureObservation[];
  error: string | null;
};

export const MAX_FEATURES = 12;
export const MAX_FEATURE_KEY_LENGTH = 64;
export const MAX_FEATURE_TEXT_LENGTH = 512;

export const OBSERVE_PROMPT_VERSION = PROMPT_VERSIONS.observe;
export const OBSERVE_SCHEMA_VERSION = "dynamic-features-schema-v2" as const;

export const OBSERVE_PROMPT = loadPrompt("observe");

export const OBSERVE_SCHEMA = {
  type: "object",
  properties: {
    features: {
      type: "array",
      minItems: 0,
      maxItems: MAX_FEATURES,
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: MAX_FEATURE_KEY_LENGTH,
            pattern: "^[A-Za-z][A-Za-z0-9 _-]{0,63}$",
          },
          text: { type: "string", minLength: 1, maxLength: MAX_FEATURE_TEXT_LENGTH },
        },
        required: ["key", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["features"],
  additionalProperties: false,
} as const;

export type ObserveConfig = {
  model: string;
  seed: number;
  schemaVersion: string;
  promptVersion: string;
};

export type ObserveModelRequest = {
  imagePath: string;
  prompt: string;
  schema: typeof OBSERVE_SCHEMA;
};

export type ObserveDeps = {
  config?: ObserveConfig;
  cacheDir?: string;
  model?: (input: ObserveModelRequest) => Promise<string | null>;
};

const DEFAULT_MODEL = process.env.OBSERVE_MODEL ?? process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const TEMPERATURE = Number(process.env.OBSERVE_TEMPERATURE ?? 0);
const DEFAULT_SEED = Number(process.env.GEOLOCATE_SEED ?? 1);
const CACHE_DIR = process.env.OBSERVE_CACHE_DIR ?? join("tmp", "cache", "observe");

/** Same routing policy as the solver, see `src/agent.ts`. */
const PROVIDER = {
  order: (process.env.OPENROUTER_PROVIDER ?? "Novita,Venice")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
  allow_fallbacks: false,
  quantizations: [process.env.OPENROUTER_QUANTIZATION ?? "bf16"],
} as const;

export const OBSERVE_CONFIG: ObserveConfig = {
  model: DEFAULT_MODEL,
  seed: DEFAULT_SEED,
  schemaVersion: OBSERVE_SCHEMA_VERSION,
  promptVersion: OBSERVE_PROMPT_VERSION,
};

const GENERIC_FEATURE_KEY = /^(?:other|misc|unknown|feature|cue|item)(?:_?[0-9]+)?$/;
const NORMALIZED_FEATURE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function unicodeCodePointLength(value: string): number {
  return [...value].length;
}

export function normalizeFeatureKey(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!NORMALIZED_FEATURE_KEY.test(normalized) || GENERIC_FEATURE_KEY.test(normalized)) return null;
  return normalized;
}

export function isNormalizedFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && NORMALIZED_FEATURE_KEY.test(value) && !GENERIC_FEATURE_KEY.test(value);
}

function normalizeFeatureObservation(value: unknown): FeatureObservation | null {
  if (!isRecord(value) || !hasExactKeys(value, ["key", "text"])) return null;
  if (typeof value.key !== "string" || typeof value.text !== "string") {
    return null;
  }
  const key = normalizeFeatureKey(value.key);
  if (
    key === null ||
    unicodeCodePointLength(value.key) < 1 ||
    unicodeCodePointLength(value.key) > MAX_FEATURE_KEY_LENGTH ||
    unicodeCodePointLength(key) > MAX_FEATURE_KEY_LENGTH ||
    value.text.trim() === "" ||
    unicodeCodePointLength(value.text) < 1 ||
    unicodeCodePointLength(value.text) > MAX_FEATURE_TEXT_LENGTH
  ) {
    return null;
  }
  return { key, text: value.text };
}

function normalizeObservationFeatures(values: readonly unknown[]): FeatureObservation[] | null {
  if (values.length > MAX_FEATURES) return null;
  const normalized: FeatureObservation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values)) return null;
    const feature = normalizeFeatureObservation(values[index]);
    if (feature === null || seen.has(feature.key)) return null;
    seen.add(feature.key);
    normalized.push(feature);
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
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["features"]) || !Array.isArray(parsed.features)) {
    return { features: [], error: "malformed observation response" };
  }
  const features = normalizeObservationFeatures(parsed.features);
  return features === null
    ? { features: [], error: "malformed observation response" }
    : { features, error: null };
}

/**
 * Re-validates an observation result crossing an injected runtime boundary.
 * `observe` already returns this shape, but locate also accepts an observe hook;
 * hooks are untrusted inputs and must not be able to bypass feature budgets.
 */
export function normalizeObserveResult(value: unknown): ObserveResult {
  if (!isRecord(value) || !hasExactKeys(value, ["features", "error"]) || !Array.isArray(value.features)) {
    return { features: [], error: "invalid observation result" };
  }
  if (value.error !== null && typeof value.error !== "string") {
    return { features: [], error: "invalid observation result" };
  }
  const features = normalizeObservationFeatures(value.features);
  if (features === null) return { features: [], error: "invalid observation result" };
  return value.error === null ? { features, error: null } : { features: [], error: value.error };
}

function normalizeCachedObservation(value: unknown): ObserveResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ["features", "error"]) || value.error !== null) return null;
  if (!Array.isArray(value.features)) return null;
  const features = normalizeObservationFeatures(value.features);
  return features === null ? null : { features, error: null };
}

function effectiveConfig(deps: ObserveDeps): ObserveConfig {
  const config = deps.config ?? OBSERVE_CONFIG;
  return {
    model: config.model,
    seed: config.seed,
    schemaVersion: config.schemaVersion,
    promptVersion: config.promptVersion,
  };
}

function validateConfig(config: ObserveConfig): void {
  if (
    typeof config.model !== "string" ||
    config.model.trim() === "" ||
    !Number.isSafeInteger(config.seed) ||
    typeof config.schemaVersion !== "string" ||
    config.schemaVersion.trim() === "" ||
    typeof config.promptVersion !== "string" ||
    config.promptVersion.trim() === ""
  ) {
    throw new Error("invalid observation configuration");
  }
}

function cacheIdentity(config: ObserveConfig, imagePath: string, imageDigest: string): string {
  return [
    config.schemaVersion,
    config.promptVersion,
    config.model,
    String(config.seed),
    imagePath,
    imageDigest,
  ].join("\0");
}

function cachePath(cacheDir: string, config: ObserveConfig, imagePath: string, imageDigest: string): string {
  const key = createHash("sha256").update(cacheIdentity(config, imagePath, imageDigest), "utf8").digest("hex");
  return join(cacheDir, `${key}.json`);
}

let cachedClient: OpenAI | undefined;
function client(): OpenAI {
  cachedClient ??= new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY ?? "", baseURL: BASE_URL });
  return cachedClient;
}

async function defaultObserveModel(request: ObserveModelRequest, config: ObserveConfig): Promise<string | null> {
  const response = await throttleOpenRouterRequest(async () =>
    client().chat.completions.create({
      model: config.model,
      temperature: TEMPERATURE,
      seed: config.seed,
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
    } as OpenAI.ChatCompletionCreateParamsNonStreaming),
  );
  return response.choices[0]?.message.content ?? null;
}

const tracer = trace.getTracer("observe");

/**
 * Returns the model-selected visual features. A malformed or failed observation
 * is represented as an empty result so the image task can continue without
 * fabricated retrieval cues.
 */
export async function observe(imagePath: string, deps: ObserveDeps = {}): Promise<ObserveResult> {
  const config = effectiveConfig(deps);
  try {
    validateConfig(config);
    const imageDigest = createHash("sha256").update(await readFile(imagePath)).digest("hex");
    const path = cachePath(deps.cacheDir ?? CACHE_DIR, config, imagePath, imageDigest);
    try {
      const cachedResult = normalizeCachedObservation(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (cachedResult !== null) return cachedResult;
    } catch {
      // Cache miss or stale/malformed cache entry.
    }

    return tracer.startActiveSpan("observe", async (span) => {
      try {
        const raw = deps.model === undefined
          ? await defaultObserveModel({ imagePath, prompt: OBSERVE_PROMPT, schema: OBSERVE_SCHEMA }, config)
          : await deps.model({ imagePath, prompt: OBSERVE_PROMPT, schema: OBSERVE_SCHEMA });
        const result = parseObservation(raw);
        span.setAttributes({
          "observe.feature_count": result.features.length,
          "observe.prompt_version": config.promptVersion,
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
  } catch (error) {
    return { features: [], error: error instanceof Error ? error.message : String(error) };
  }
}
