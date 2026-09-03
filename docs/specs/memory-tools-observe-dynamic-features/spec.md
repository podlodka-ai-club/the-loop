---
type: Specification
title: "Dynamic feature memory tools и episode-level reflection"
description: Контракт model-generated набора визуальных признаков, bounded retrieval по каждому признаку и отдельной post-reveal записи для каждого memory hit.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
version: 1
tags: [loci, memory, tools, observe, reflection, dynamic-features, specification]
---

# Spec: Dynamic feature memory tools и episode-level reflection

Эта спецификация supersedes fixed-registry iteration [memory-tools-observe-reflection](/specs/memory-tools-observe-reflection/spec.md). Она сохраняет feature-scoped memory и episode-level reflection, но делает состав observations model-generated и variable per image.

## Goal

Реализовать обработку одной фотографии в фазах `observe`, `retrieve`, `analyze` и `reflect`, где vision-модель сама формирует bounded набор наблюдаемых features. Для каждого возвращённого feature приложение выполняет отдельный bounded retrieval, а после reveal создаёт отдельный lesson для каждого memory hit.

## Glossary

- **feature** — model-generated визуальный признак с machine-readable key и описанием того, что видно в кадре.
- **feature key** — bounded slug, сформированный моделью и уникальный внутри attempt.
- **memory hit** — один элемент результата `memory_retrieve`, пригодный для отдельной рефлексии.
- **episode** — тройка `attempt + feature + memory hit`.
- **logical outcome** — итог одной feature-операции после внутренних retry: `hits`, `no_hit` или failure.
- **attempt** — один blind solve, reveal и все связанные feature groups/episodes.

## Contract

### 1. Dynamic observation — `src/observe.ts`

```ts
export type FeatureKey = string;

export type FeatureObservation = {
  key: FeatureKey;
  text: string;
};

export type ObserveResult = {
  features: FeatureObservation[];
  error: string | null;
};

export const MAX_FEATURES = 12; // budget cap, not a feature vocabulary
export const MAX_FEATURE_KEY_LENGTH = 64;
export const MAX_FEATURE_TEXT_LENGTH = 512;

export type ObserveConfig = {
  model: string;
  seed: number;
  schemaVersion: string;
  promptVersion: string;
};

export type ObserveDeps = {
  config?: ObserveConfig;
  cacheDir?: string;
  model?: (input: { imagePath: string; prompt: string; schema: unknown }) => Promise<string | null>;
};

export function observe(imagePath: string, deps?: ObserveDeps): Promise<ObserveResult>;
```

The model-facing schema is:

```json
{
  "type": "object",
  "properties": {
    "features": {
      "type": "array",
      "minItems": 0,
      "maxItems": 12,
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[A-Za-z][A-Za-z0-9 _-]{0,63}$"
          },
          "text": { "type": "string", "minLength": 1, "maxLength": 512 }
        },
        "required": ["key", "text"],
        "additionalProperties": false
      }
    }
  },
  "required": ["features"],
  "additionalProperties": false
}
```

Observation prompt is a concrete versioned instruction with these sections: `role`, `feature examples`,
`output shape`, `visual-only rules`, `key rules`, `text rules` and `JSON-only response`. It explicitly
states that examples are suggestions rather than an enum and that the model must emit only features
visible in the current image.

```ts
export const OBSERVE_PROMPT_VERSION = "dynamic-features-v1" as const;
export const OBSERVE_SCHEMA_VERSION = "dynamic-features-schema-v1" as const;
export const OBSERVE_PROMPT = [
  "ROLE: You are a visual observation instrument.",
  "FEATURE EXAMPLES: traffic, writing, text, plates, poles, barriers, markings, surface, vegetation, terrain, buildings, vehicles, lighting and camera coverage.",
  "OUTPUT SHAPE: Return JSON only as {\"features\":[{\"key\":\"descriptive key\",\"text\":\"literal visual fact\"}]}.",
  "VISUAL-ONLY RULES: Emit only features literally visible in this image; do not emit countries, regions, cities, continents or geographic implications.",
  "KEY RULES: Choose one concise descriptive key per useful cue. Examples are not a fixed list. Omit a feature that is not visible; do not fabricate placeholder records.",
  "TEXT RULES: Use one short phrase of visual facts and no unsupported geographic conclusion.",
  "JSON-ONLY RESPONSE: Do not add prose outside the JSON object.",
].join("\n");
```

Before persistence, application normalization applies Unicode NFKC, trims, lowercases and replaces
runs of spaces or hyphens with `_`. The normalized key must match `^[a-z][a-z0-9_]{0,63}$` and must
not match the exact denylist or ordinal pattern:

```ts
const GENERIC_FEATURE_KEY = /^(?:other|misc|unknown|feature|cue|item)(?:_?[0-9]+)?$/;
```

The normalized key must be unique after normalization and must not match the exact generic-key pattern
above; the word `descriptive` is prompt guidance, not an additional semantic parser rule. A collision
or invalid key rejects the complete observation response; raw and normalized keys are not both retained.
The cache key is exactly:
`sha256(OBSERVE_SCHEMA_VERSION + "\\0" + OBSERVE_PROMPT_VERSION + "\\0" + OBSERVATION_GEO_POLICY.version + "\\0" + geoEntityDigest + "\\0" + model + "\\0" + seed + "\\0" + imagePath + "\\0" + imageDigest)`.
Changing `src/observe-geo-entities.json` requires a new `OBSERVATION_GEO_POLICY.version` before any
new cache entry is accepted. `imageDigest` is SHA-256 of the current image bytes and `geoEntityDigest`
is SHA-256 of canonical JSON for the loaded geo entity file; both are computed by the application.

The observation geo policy artifact is versioned and deterministic:

```ts
export type GeoEntityFile = {
  version: string;
  entities: string[];
};

export type ObservationGeoPolicy = {
  version: string;
  entitySource: "src/observe-geo-entities.json";
  entityNames: readonly string[];
  entityPattern: RegExp;
  implicationPattern: RegExp;
};

export function loadEntities(path: "src/observe-geo-entities.json"): readonly string[];
export function buildEntityPattern(entities: readonly string[]): RegExp;

const entityNames = loadEntities("src/observe-geo-entities.json");

export const OBSERVATION_GEO_POLICY: ObservationGeoPolicy = {
  version: "dynamic-features-geo-v1",
  entitySource: "src/observe-geo-entities.json",
  entityNames,
  entityPattern: buildEntityPattern(entityNames),
  implicationPattern: /\b(?:suggests?|typical(?:ly)?|characteristic(?:ally)?|looks? like|style|from)\b/iu,
};
```

`src/observe-geo-entities.json` has exact shape `{ "version": string, "entities": string[] }`, unique
non-empty entity names and a version matching `OBSERVATION_GEO_POLICY.version`. `loadEntities` reads
the complete checked-in country, subdivision, city and continent dictionary and `buildEntityPattern`
escapes every entry before creating a token-boundary regex. The parser rejects an entity match or implication
pattern, except a language/script name used as a visible writing fact in a key containing `script`,
`language`, `text` or `writing`.

Observation output is a successful parsed array of 0–`MAX_FEATURES` records in model order. Each
`text` contains only literal visual facts; country, region, city, continent and geographic implications
are invalid. A malformed response returns `features: []` and non-null `error` without fabricated records.

Observation cache is keyed by the exact formula above. Only a successful parsed result is cached; cache hits do not call the model.

### 2. Memory and lesson data — `src/memory/memory.ts`

```ts
export type ReflectionEffect =
  | "helped"
  | "irrelevant"
  | "misleading"
  | "insufficient";

export type LessonInput = {
  content: string;
  sourceAttemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  effect: ReflectionEffect;
  triggers: string[];
  region: string;
  idempotencyKey: string;
};

export type Lesson = LessonInput & {
  id: string;
  hits: number;
  wins: number;
};

export type Hint = {
  lessonId: string;
  text: string;
  featureKey?: FeatureKey;
  effect?: ReflectionEffect;
};

export function renderHint(lesson: Lesson): Hint;

export interface MemoryReader {
  recall(query: string, limit: number): Promise<Hint[]>;
}

export interface MemoryWriter extends MemoryReader {
  remember(lesson: LessonInput): Promise<MemoryWriteResult>;
  snapshot(): Promise<string>;
  restore(id: string): Promise<void>;
}

export type Memory = MemoryWriter;

export type MemoryWriteResult = {
  status: "stored" | "already_stored";
  lessonId: string;
};

export type MemoryWriteErrorCode = "write_failed" | "write_outcome_unknown";

export class MemoryWriteError extends Error {
  readonly code: MemoryWriteErrorCode;
}
```

All episode provenance fields are machine-readable metadata. An adapter without structured metadata prefixes rendered content with `[effect=<effect>]` before lesson content. Proven rejection and unknown write outcome use separate `MemoryWriteError` codes.

Provider-specific adapter specs expose the `MemoryReader`/`MemoryWriter` contract above for the dynamic
flow. Any legacy array-query or void-write API is an adapter-internal compatibility surface and is not
called directly by the dynamic dispatcher. A provider adapter must convert it before crossing this
contract, including typed write outcome and machine-readable provenance.

### 3. Retrieval result and attempt trace — `src/tools/memory.ts`

```ts
export type MemoryHit = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  providerId: string | null;
  text: string;
  score: number | null;
  effect: ReflectionEffect | null;
};

export type RetrievalStatus = "hits" | "no_hit" | "failed";
export type RetrievalFailure =
  | "invalid_tool_arguments"
  | "wrong_feature"
  | "missing_tool_call"
  | "multiple_tool_calls"
  | "malformed_tool_json"
  | "memory_error"
  | "timeout"
  | "budget_exhausted"
  | "skipped";

export type FeatureMemoryGroup = {
  attemptId: string;
  feature: FeatureObservation;
  query: string | null;
  status: RetrievalStatus;
  hits: MemoryHit[];
  failure: RetrievalFailure | null;
};

export type EpisodeTrace = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;
  effect: ReflectionEffect | null;
  reflectionStatus:
    | "stored"
    | "already_stored"
    | "write_failed"
    | "write_outcome_unknown"
    | "reflection_failed";
  lessonId: string | null;
};

export type ToolEvent = {
  attemptId: string;
  phase: "retrieve" | "analyze" | "reflect";
  operation: "memory_retrieve" | "memory_store";
  featureKey: FeatureKey;
  memoryHitId: string | null;
  status: string;
  sequence: number;
};

export type AttemptTrace = {
  attemptId: string;
  groups: FeatureMemoryGroup[];
  episodes: EpisodeTrace[];
  events: ToolEvent[];
};

export type LocateResult = {
  attemptId: string;
  guess: Guess;
  observations: FeatureObservation[];
  memoryGroups: FeatureMemoryGroup[];
  episodes: EpisodeTrace[];
  trace: AttemptTrace;
};

export function makeMemoryHitId(
  attemptId: string,
  featureKey: FeatureKey,
  providerId: string | null,
  text: string,
  occurrence: number,
): string;

export function makeIdempotencyKey(
  attemptId: string,
  featureKey: FeatureKey,
  memoryHitId: string,
): string;
```

`memoryGroups` preserves model-generated feature boundaries and order. There is no flattened `hints` field in the canonical analysis context. A hit ID is generated by the application and is valid only for its attempt, feature and normalized provider/text occurrence.

### 4. Tool definitions — `src/tools/memory.ts`

```ts
export type MemoryRetrieveArgs = {
  feature_key: FeatureKey;
  query: string;
};

export const MEMORY_RETRIEVE_TOOL = {
  type: "function",
  function: {
    name: "memory_retrieve",
    description: "Retrieve lessons relevant to the currently assigned visual feature.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        feature_key: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9_]{0,63}$"
        },
        query: { type: "string", minLength: 1, maxLength: 512 }
      },
      required: ["feature_key", "query"],
      additionalProperties: false
    }
  }
} as const;

export type MemoryStoreArgs = {
  feature_key: FeatureKey;
  memory_hit_id: string;
  effect: ReflectionEffect;
  content: string;
  triggers: string[];
  region: string;
};

export const MEMORY_STORE_TOOL = {
  type: "function",
  function: {
    name: "memory_store",
    description: "Store one grounded lesson for one feature and one memory hit after reveal.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        feature_key: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9_]{0,63}$"
        },
        memory_hit_id: { type: "string", minLength: 1 },
        effect: {
          type: "string",
          enum: ["helped", "irrelevant", "misleading", "insufficient"]
        },
        content: { type: "string", minLength: 1, maxLength: 2000 },
        triggers: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 128 }
        },
        region: { type: "string", minLength: 2, maxLength: 2, pattern: "^[A-Z]{2}$" }
      },
      required: ["feature_key", "memory_hit_id", "effect", "content", "triggers", "region"],
      additionalProperties: false
    }
  }
} as const;
```

The base retrieval schema has no fixed feature enum. Each active retrieval request narrows `feature_key.enum` to the current model-generated key. The application supplies attempt, backend, memory reference, idempotency and active feature context; the model cannot override them.

### 5. Dispatcher and runtime binding

```ts
export type MemoryToolPhase = "retrieve" | "reflect";
export type WorkflowMode = "training" | "evaluation" | "production";

export type MemoryRunConfig = {
  memoryRef: string | null;
  mode: WorkflowMode;
  snapshotId: string | null;
  readOnly: boolean;
  recallLimit: 1 | 2 | 3 | 4 | 5;
};

export type MemoryToolContext = {
  attemptId: string;
  reader: MemoryReader;
  writer?: MemoryWriter;
  phase: MemoryToolPhase;
  run: MemoryRunConfig;
  activeFeature: FeatureObservation;
  activeMemoryHit?: MemoryHit;
};

export function executeMemoryRetrieve(
  context: MemoryToolContext,
  args: unknown,
): Promise<FeatureMemoryGroup>;

export function executeMemoryStore(
  context: MemoryToolContext,
  args: unknown,
): Promise<
  | { status: "stored" | "already_stored"; lessonId: string; failure: null }
  | { status: "write_failed" | "write_outcome_unknown"; lessonId: null; failure: "write_failed" | "write_outcome_unknown" }
>;

export type MemoryBindingSource = {
  memoryRef: string | null;
  provider: string | null;
  reader: MemoryReader;
  writer?: MemoryWriter;
  loadSnapshot?: (snapshotId: string) => Promise<MemoryReader>;
};

export interface MemorySourceResolver {
  resolve(memoryRef: string | null): Promise<MemoryBindingSource>;
}

export function resolveMemoryBinding(
  config: MemoryRunConfig,
  resolver: MemorySourceResolver,
): Promise<MemoryBinding>;
```

Retrieve validates dynamic key equality, bounded query and phase before provider access. It calls `reader.recall(query, recallLimit)` once and limits context to five hits. Store requires reflect phase, training mode, writable run, writer and matching active attempt/feature/hit; it generates `sourceAttemptId` and `idempotencyKey` in application code.

When `memoryRef` is `null`, the resolver supplies a no-op `MemoryReader`; every returned feature receives
one `no_hit` group, and no provider access or lesson write occurs. `skipped` is reserved for an explicit
application budget or phase skip. In this mode no retrieval model turn is sent; the application creates
the `no_hit` group directly.

The exact runtime binding is:

```ts
export type MemoryBinding =
  | { mode: "training"; reader: MemoryReader; writer: MemoryWriter; snapshotId: null; readOnly: false }
  | { mode: "evaluation"; reader: MemoryReader; writer?: never; snapshotId: string; readOnly: true }
  | { mode: "production"; reader: MemoryReader; writer?: never; snapshotId: string | null; readOnly: true };
```

### 5a. Model-facing tool result envelopes

```ts
export type MemoryRetrieveToolResult = {
  attempt_id: string;
  feature_key: FeatureKey;
  status: "hits" | "no_hit" | "failed";
  hits: Array<{
    memory_hit_id: string;
    provider_id: string | null;
    text: string;
    score: number | null;
    effect: ReflectionEffect | null;
  }>;
  failure: RetrievalFailure | null;
};

export type MemoryStoreToolResult =
  | { status: "stored" | "already_stored"; lesson_id: string; failure: null }
  | { status: "write_failed" | "write_outcome_unknown"; lesson_id: null; failure: "write_failed" | "write_outcome_unknown" };
```

These snake_case envelopes are serialized into the model conversation. Internal dispatcher groups,
lessons and traces use the camelCase TypeScript types above and are not passed to the model verbatim.

```ts
export function serializeMemoryRetrieveResult(
  group: FeatureMemoryGroup,
): MemoryRetrieveToolResult;

export function serializeMemoryStoreResult(
  result: Awaited<ReturnType<typeof executeMemoryStore>>,
): MemoryStoreToolResult;
```

### 5b. Failure mapping

```ts
export type WorkflowMemoryFailure =
  | "memory_not_found"
  | "memory_mismatch"
  | "unavailable"
  | "timeout";

export type DynamicFailureMapping = {
  providerError: WorkflowMemoryFailure;
  featureGroup: RetrievalFailure;
  workflowOutcome: "degraded" | "sample_failed" | "run_aborted";
};
```

Provider and binding failures are mapped to a per-feature `memory_error` or `timeout` group when the
attempt can continue. `memory_not_found` and `memory_mismatch` abort the configured run before reveal;
`unavailable` and `timeout` use the run retry policy. Tool protocol failures remain the feature-level
codes in `RetrievalFailure` and never become provider binding errors.

### 6. Locate flow — `src/locate.ts` and `src/task.ts`

```ts
export type LocateDeps = {
  memory: MemoryReader;
  run: MemoryRunConfig;
  maxToolAttemptsPerFeature?: 1 | 2;
};

export function locate(
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
): Promise<LocateResult>;
```

The conversation contains the original image and successful observation output. Retrieval iterates the model-emitted features in response order. Every feature gets one logical group, up to two model attempts, a request with only the narrowed `memory_retrieve` tool, forced one call and `parallel_tool_calls: false`. After each call result, the tool call and data envelope are appended before the next feature. Analyze receives the original image, all observations and all groups, with no memory tools and no truth; it returns the existing strict `Guess` schema.

### 7. Reflection flow — `src/reflect.ts` and `src/task.ts`

```ts
export type ReflectionEpisodeInput = {
  attemptId: string;
  imagePath: string;
  feature: FeatureObservation;
  memoryHit: MemoryHit;
  guess: { latitude: number; longitude: number; place: string; reasoning: string };
  truth: { latitude: number; longitude: number; country: string };
  distanceKm: number;
};

export type ReflectionEpisodeResult =
  | { status: "stored" | "already_stored"; effect: ReflectionEffect; lessonId: string; failure: null }
  | { status: "reflection_failed"; effect: null; lessonId: null; failure: "missing_tool_call" | "multiple_tool_calls" | "malformed_tool_json" | "invalid_tool_arguments" | "foreign_hit" }
  | { status: "write_failed" | "write_outcome_unknown"; effect: ReflectionEffect; lessonId: null; failure: "write_failed" | "write_outcome_unknown" };

export function reflectEpisode(
  input: ReflectionEpisodeInput,
  deps: { writer: MemoryWriter; run: MemoryRunConfig },
): Promise<ReflectionEpisodeResult>;
```

One episode sends one request containing the image, one feature, one memory hit, blind guess, truth and distance. Only `memory_store` is exposed, with one forced call and `parallel_tool_calls: false`. Reflection content is one or two grounded sentences and the region equals the revealed truth country code.

### 8. Runtime metrics and fixture labels

```ts
export type RetrievalFixtureCase = {
  featureKey: FeatureKey;
  class: "rare" | "broad";
  expectedProviderIds: string[];
};

export type RetrievalMetric = RetrievalFixtureCase & {
  returnedProviderIds: string[];
  hit: boolean;
};

export type AttemptMetrics = {
  attemptId: string;
  visibleFeatures: number;
  retrievalOutcomes: number;
  memoryHits: number;
  episodesByEffect: Record<ReflectionEffect, number>;
  rareCueHitRate: number | null;
  broadCueHitRate: number | null;
  legacyGlobalTopKRareCueHitRate: number | null;
  featureScopedRareCueHitRate: number | null;
  geoscore: number | null;
  validOutput: boolean;
  toolCalls: number;
  latencyMs: number;
};
```

Fixture labels and expected provider IDs are explicit input. They are never inferred from model-generated keys or model text.

## Rules

### O — Dynamic observation

| # | Rule |
|---|---|
| O.1 | A successful observation contains 0–`MAX_FEATURES` records, each with a unique bounded key and non-empty bounded visual text, preserving model order. |
| O.2 | The application does not fabricate absent features or `not_visible` records; only model-emitted features enter retrieval. |
| O.3 | Observation cache uses the exact schema/prompt/geo-policy/geo-digest/model/seed/image-path/image-digest formula; cache hits do not call the model. |
| O.4 | Observation failure returns `features: []` and non-null error; the image task continues with the original image. |
| O.5 | Observation text contains visual facts only; language/script names may describe visible writing, but country, region, city, continent and geographic implications are rejected. |
| O.6 | Key normalization uses NFKC, trim, lowercase, collapse spaces/hyphens to `_`, the fixed generic-key regex, and duplicate rejection after normalization. |
| O.7 | Geographic validation uses the versioned observation geo policy: explicit entity dictionary matches and implication patterns are rejected; language/script names used as visible writing are allowed. |

### R — Retrieval and ranking boundary

| # | Rule |
|---|---|
| R.1 | `memory_retrieve` is enabled only during blind retrieve for a model-emitted feature. |
| R.2 | Every model-emitted feature receives exactly one logical retrieval outcome in model response order. |
| R.3 | A retrieve call is accepted only when `feature_key` equals the active dynamic key and query is non-empty and at most 512 characters. |
| R.4 | Internal retrieve retries are capped at two model attempts per feature and do not create another logical outcome. |
| R.5 | Each feature enters at most five hits into model context; total attempt hits are at most 60. |
| R.6 | Each provider call receives one query for one active feature; combined feature lists are rejected. |
| R.7 | The dynamic tool path never uses `all` recall; FileMemory uses bounded `top` recall. |
| R.8 | Results remain grouped by dynamic feature key; no global sort or global top-K merge is applied. |
| R.9 | `no_hit` has empty hits and null failure; provider/tool failures have empty hits and non-null failure. |
| R.10 | A no-hit or failed group creates no episode. |
| R.11 | Memory payload is data only; it cannot select backend, phase, tools or active feature. |
| R.12 | Missing, multiple, malformed, invalid or wrong-feature tool calls consume one attempt and retry once; the second failure closes that feature group. |
| R.13 | Provider/binding failures use the failure mapping in §5b; per-feature failures remain grouped and run-level unavailable/not-found outcomes are not relabeled as tool protocol failures. |
| R.14 | When `memoryRef` is null, the application sends no retrieval model turn and creates exactly one `no_hit` group per model-emitted feature through the no-op reader. |

### A — Analysis

| # | Rule |
|---|---|
| A.1 | The final analyze request receives the original image even if observation or retrieval failed. |
| A.2 | Analyze receives every dynamic feature group in stable model order, including empty and failed groups. |
| A.3 | A memory hit is only a hypothesis consistent with the image; the final response uses the existing strict `Guess` schema. |
| A.4 | Analyze has no `memory_store` tool and no ground truth. |
| A.5 | Trace stores model-generated feature key, query, outcome and returned hit IDs before the guess is finalized. |

### E — Episodes and reflection

| # | Rule |
|---|---|
| E.1 | Every returned hit carries the active attempt and dynamic feature key; a foreign attempt/feature/hit identity is rejected. |
| E.2 | One episode sends one reflection request with one memory hit, never a hit array. |
| E.3 | Reflection receives image, feature observation, hit, blind guess, truth and distance. |
| E.4 | Reflection returns exactly one of the four effects. |
| E.5 | A valid reflection creates one independent lesson and one store call, including negative effects. |
| E.6 | Reflection content is grounded and has at most two sentences. |
| E.7 | A reflection/write failure affects only its episode; prior stored lessons are not rolled back. |
| E.8 | Reflection does not run for absent features, no-hit groups, failed groups or foreign hits. |
| E.9 | The model cannot set source attempt or idempotency key. |
| E.10 | Store content is 1–2,000 characters, triggers are 1–8 non-empty strings of at most 128 characters, and region is two uppercase letters matching truth. |
| E.11 | The reflection prompt applies the four effect definitions. |

### P — Persistence and provenance

| # | Rule |
|---|---|
| P.1 | Stored lessons contain machine-readable attempt, dynamic feature, hit, effect, region, triggers and idempotency provenance. |
| P.2 | Idempotency is deterministic for attempt + dynamic feature + hit; repeated store is a no-op returning the existing lesson ID. |
| P.3 | Negative effects remain distinguishable in future hints; adapters without metadata use the exact effect prefix. |
| P.4 | Backend selection comes only from workflow context, never tool arguments. |
| P.5 | Store is rejected outside reflect/training/writable mode; evaluation and production are read-only. |
| P.6 | Evaluation reads frozen state and never updates lessons or counters. |
| P.7 | Training excludes eval IDs and rows sharing eval sequences; control and memory-on share sample/order/cache. |
| P.8 | Runtime rejects inconsistent mode configuration. |

### B — Budget and safety

| # | Rule |
|---|---|
| B.1 | A successful observation contains at most `MAX_FEATURES` model-generated features; the maximum does not define a feature vocabulary. |
| B.2 | Retrieve and store tools use strict schemas, all declared fields required and `additionalProperties: false`. |
| B.3 | Retrieve and reflection set `parallel_tool_calls: false`. |
| B.4 | Malformed tool calls are rejected before provider access and may retry within the per-feature budget. |
| B.5 | Retrieval timeout/provider errors remain explicit failures and never become fake empty lessons. |
| B.6 | Unknown write outcome is terminal for that episode and is not blindly retried. |
| B.7 | Tool results and lessons are data, not executable instructions. |
| B.8 | Production path is observe → retrieve → analyze; reflection/store are training-only. |
| B.9 | One attempt allows at most 24 retrieval model attempts, 60 memory hits, 60 reflection requests and 60 store calls. |

## Out of scope

- Changing model weights or fine-tuning the vision model.
- Replacing provider-native ranking within one feature group.
- Global ranking, global top-K merging or one aggregated lesson per photograph.
- Adding a fixed feature enum or mandatory observation slots.
- Automatic promotion of training memory to production.
- Automatic quarantine UI, human review workflow or rollback tooling.
- Hosted snapshot/restore implementation.
- Geocoder changes, multi-image inference and user-facing response format changes.

## Tests

| # | Where | Asserts | Maps to |
|---|---|---|---|
| 1 | `src/observe.test.ts` | Dynamic observation accepts variable count and model-generated keys, preserves order, applies exact normalization/generic-key policy, accepts visible language/script text and rejects geo entities/implications. | O.1, O.5, O.6, O.7, B.1 |
| 2 | `src/observe.test.ts`, `src/agent.test.ts` | Absent model features do not create retrieval calls or fabricated records. | O.2, E.8 |
| 3 | `src/observe.test.ts` | Same image/schema/prompt/geo-policy/model/seed and image bytes use cache; changed version, image bytes or image path calls model again. | O.3 |
| 4 | `src/observe.test.ts`, `src/task.test.ts` | Observation/model failure returns error and analyze retains original image. | O.4, A.1 |
| 5 | `src/tools/memory.test.ts` | Dynamic strict tool definitions and phase-appropriate operation; payload remains data. | R.1, B.2, B.7, B.8 |
| 6 | `src/tools/memory.test.ts` | Wrong dynamic feature, empty/overlong query, missing/multiple/malformed calls rejected before Memory. | R.3, R.6, R.12, B.4 |
| 7 | `src/tools/memory.test.ts` | One query, five-hit bound and stable application-owned IDs for dynamic features. | R.5, R.6 |
| 8 | `src/tools/memory.test.ts` | `all` mode rejected and no global merge/flattening occurs. | R.7, R.8 |
| 9 | `src/tools/memory.test.ts` | Empty/provider/timeout/skipped/budget outcomes remain distinct and create no episode; workflow/provider failure mapping and null-memory `no_hit` projection are explicit. | R.9, R.10, R.13, R.14, B.5, B.9 |
| 10 | `src/agent.test.ts` | Model-emitted features are processed sequentially in response order, retry cap is two and request flags/history are correct. | R.2, R.4, R.12, B.3, A.5 |
| 11 | `src/agent.test.ts` | Analyze receives original image and every dynamic group, without store tool or truth. | A.1, A.2, A.4, R.11 |
| 12 | `src/task.test.ts` | Guess remains valid with partial failures; dynamic groups are canonical and memory remains hypothesis data. | A.2, A.3, B.5 |
| 13 | `src/reflect.test.ts` | One reflection receives one feature and one hit plus guess/truth/distance. | E.1, E.2, E.3 |
| 14 | `src/reflect.test.ts` | Four effects, grounding, two-sentence content, bounds, strict fields and reflection failure distinction. | E.4, E.6, E.10, E.11 |
| 15 | `src/reflect.test.ts` | Each valid dynamic feature/hit episode makes exactly one store call with app-owned provenance. | E.5, E.9 |
| 16 | `src/task.test.ts`, `src/reflect.test.ts` | Absent/no-hit/failed/foreign feature paths do not invoke reflection/store. | E.8, R.10 |
| 17 | `src/task.test.ts` | One dynamic episode failure does not rollback another; unknown write is not retried. | E.7, B.6 |
| 18 | `src/memory/file/memory.test.ts` | Dynamic lesson metadata/effect survives persistence, rendering distinguishes effects and duplicate idempotency is cross-process. | P.1, P.2, P.3 |
| 19 | `src/memory/mem0/memory.test.ts`, `src/memory/hindsight/memory.test.ts`, `src/memory/xmemory/memory.test.ts` | Dynamic provenance/effect metadata, provider errors, no backend arg and cross-instance idempotency or explicit provider limitation. | P.1, P.4, B.5 |
| 20 | `src/task.test.ts` | Training may write; evaluation/production are reader-only frozen/read-only bindings; inconsistent modes reject. | P.5, P.6, P.8, B.8 |
| 21 | `src/train.test.ts` | Training excludes eval IDs/sequences; control and memory-on share frozen sample/order/cache. | P.7 |
| 22 | `src/experiment.test.ts` | Dynamic feature trace and fixture-based comparison report scoped/global rare/broad rates and geoscore without global top-K. | A.5, R.8, P.6 |
| 23 | `src/feature-memory.e2e.test.ts` | `MAX_FEATURES` model-generated features with mixed failures, five hits each, duplicate store, reader-only evaluation and all numeric budgets. | R.2, R.5, R.8, R.9, E.1, E.2, E.5, E.7, P.2, P.5, P.6, P.7, B.9 |

## Execution

### Lock

- Expected branch: `feat/feature-scoped-memory-tools`
- Preflight check: [x] current branch and clean/unrelated changes confirmed; old fixed-registry implementation identified for migration.

### ADR traceability

| ADR invariant | Established in |
|---|---|
| Dynamic model-generated features with bounded application limits | Phase 1 and Phase 2 |
| Feature-scoped bounded retrieval without global top-K | Phase 2 |
| Tools phase-controlled by application | Phase 2 and Phase 4 |
| One episode per dynamic feature + memory hit | Phase 3 |
| One independent store per valid episode | Phase 4 |
| Blind/evaluation read-only and training writes | Phase 3, Phase 4 and Phase 5 |
| Frozen benchmark isolation | Phase 5 |

### Phase 1 — Dynamic contracts and adapter boundary

**Objective.** Replace fixed feature enum/state contracts with bounded model-generated keys while preserving memory provenance and adapter compatibility.

**Work.**
- Update feature observation, lesson, hit, trace and tool contracts to use dynamic keys.
- Remove mandatory fixed registry cardinality and state records; define bounded key/text validation.
- Update provider adapter contracts to expose the dynamic reader/writer boundary and keep any native compatibility methods internal; add tests #5–#9.

**Dependencies.** None.

**Risks.**
- *Legacy lessons use fixed keys.* Accept old strings as data and preserve metadata without reintroducing an enum.
- *Unbounded model output increases cost.* Enforce `MAX_FEATURES`, key/text bounds and total hit budgets before provider access.

**Validation.** Tests #5–#9 pass. Typecheck and relevant adapter suites pass.

**Done.** Dynamic feature keys compile and a bounded dispatcher handles a single model-generated feature.

### Phase 2 — Dynamic observe and retrieve loop

**Objective.** Make observation model-generated and run retrieval for exactly the returned features in response order.

**Work.**
- Update prompt/schema/cache/parser for variable feature arrays and visual-only text.
- Update `docs/workflows/locate.md` and `docs/workflows/models.md` to the dynamic grouped result and failure mapping.
- Preserve original image through sequential feature retrieval and final analyze.
- Narrow each retrieve tool enum to the current dynamic key and enforce retry/hit budgets.
- Add tests #1–#4 and #10–#11.

**Dependencies.** Phase 1.

**Risks.**
- *Model returns duplicate or unusable keys.* Reject the whole observation response before retrieval.
- *Model omits useful cues.* Record only returned features; do not fabricate slots or silently claim coverage.

**Validation.** Tests #1–#4 and #10–#11 pass. Existing agent/task tests pass.

**Done.** A replayed image produces a bounded dynamic observation array and one grouped outcome per returned feature.

### Phase 3 — Analyze integration and episode ledger

**Objective.** Keep dynamic groups and hit identity canonical in task results and trace before reveal.

**Work.**
- Integrate dynamic locate into `runTask` and remove fixed-registry assumptions.
- Preserve grouped trace on partial analyze failures and derive internal episode candidates from hits.
- Keep terminal `EpisodeTrace` contract separate from pre-reveal candidates.
- Add Test #12 and no-hit/failed regressions.

**Dependencies.** Phase 2.

**Risks.**
- *Legacy consumers expect a fixed feature count.* Keep compatibility telemetry separate from canonical groups.
- *Dynamic keys collide after normalization.* Reject duplicate keys and duplicate hit identity within an attempt.

**Validation.** Test #12 passes. Typecheck and full relevant task suites pass.

**Done.** Every returned dynamic hit has one stable internal episode candidate and no absent feature creates one.

### Phase 4 — Per-episode reflection and persistence

**Objective.** Reflect and store one independent lesson for every valid dynamic feature/hit pair.

**Work.**
- Run one reflection request per hit with only `memory_store` after reveal.
- Validate active dynamic key, hit identity, effect, bounds, truth region and app-owned provenance.
- Persist dynamic provenance/effects and idempotency through FileMemory and Mem0.
- Update `docs/workflows/train.md`, `docs/tools/memory_retrieve.md`, `docs/tools/memory_store.md` and related adapter specs.
- Keep evaluation/production reader-only and isolate episode failures.
- Add tests #13–#20.

**Dependencies.** Phase 3.

**Risks.**
- *Dynamic keys are not stable across model versions.* Store the exact normalized key in each lesson and fixture label.
- *Write count grows with returned hits.* Enforce five hits per feature and 60 total hits/stores per attempt.

**Validation.** Tests #13–#20 pass. Typecheck and relevant adapter suites pass.

**Done.** Each valid reflection produces one independently attributable lesson or a visible terminal episode failure.

### Phase 5 — Benchmark controls and rollout gate

**Objective.** Compare dynamic feature-scoped retrieval with the legacy global control while preserving benchmark isolation.

**Work.**
- Thread fixed retrieval fixture labels through real experiment/task/evaluator output.
- Use frozen samples, cached observations and explicit cold/warm modes.
- Exclude evaluation IDs and sequences from training before image availability filtering.
- Report dynamic scoped/global rare/broad hit rates, geoscore, effects, calls and latency.
- Add tests #21–#23 and repository health checks.

**Dependencies.** Phases 1–4.

**Risks.**
- *Dynamic feature vocabulary changes metric joins.* Fixture labels use explicit normalized keys and missing labels are reported, not inferred.
- *Hosted backend cannot freeze state.* Fail warm hosted mode or label it non-frozen; never claim frozen evaluation.

**Validation.** Tests #21–#23, typecheck, sample, diff check and relevant adapter suites pass.

**Done.** A pilot reports dynamic grouped retrieval, per-episode outcomes, rare/broad rates, geoscore, valid output, cost/latency and no evaluation writes.

## Done criteria

- All 23 tests pass; full relevant test suites are green.
- `observe` emits a bounded model-generated feature array with no fixed feature enum or mandatory slots.
- Each returned feature receives exactly one bounded logical retrieval outcome in model order, with no global top-K merge.
- Each returned hit receives exactly one reflection outcome; each valid reflection makes one independent store call.
- Stored lessons contain machine-readable dynamic feature, attempt, hit, effect and idempotency provenance.
- No-hit, retrieval failure, reflection failure and unknown write outcome remain distinguishable.
- Evaluation and production cannot store; evaluation reads frozen state.
- Trace and pilot output expose dynamic feature groups, hits, effects, rare/broad rates, geoscore, valid output, calls and latency.
- Training excludes evaluation IDs and shared sequences; control and memory-on use the same sample/order/cache.
- No one-image aggregated lesson and no global top-K result is the sole analysis context.
