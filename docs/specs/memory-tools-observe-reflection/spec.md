---
type: Specification
title: "Feature-scoped memory tools и episode-level reflection"
description: Контракт tool-loop для поиска памяти по отдельным визуальным признакам и сохранения отдельного урока по каждой паре feature и memory hit.
timestamp: 2026-08-30T00:00:00+03:00
date: 2026-08-30
model: gpt-5
version: 1
tags: [loci, memory, tools, observe, reflection, specification]
---

# Spec: Feature-scoped memory tools и episode-level reflection

Спецификация операционализирует [принятый ADR](adr.md). Она изменяет общий агентский flow,
контракт lesson и memory-tool dispatcher, добавляя retrieval по отдельным признакам и отдельную
post-reveal запись для каждого memory hit.

## Goal

Реализовать обработку одной фотографии в фазах `observe`, `retrieve`, `analyze` и `reflect`. Для
каждого видимого feature агент получает bounded memory result в отдельной группе, а после reveal
создаёт и сохраняет отдельный episode-level lesson для каждого возвращённого memory hit.

## Glossary

- **feature** — один стабильный слот наблюдения фотографии из `FEATURE_KEYS`.
- **memory hit** — один элемент результата `memory_retrieve`, пригодный для отдельной рефлексии.
- **episode** — тройка `attempt + feature + memory hit`.
- **logical outcome** — итог одной операции после внутренних retry: `hits`, `no_hit` или failure.
- **effect** — оценка влияния memory hit: `helped`, `irrelevant`, `misleading` или `insufficient`.
- **eligible feature** — feature со `state: "visible"`; `not_visible` не запускает memory call.
- **attempt** — один blind solve, reveal и все связанные feature groups/episodes.

## Contract

### 1. Feature registry and observation — `src/observe.ts`

```ts
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

export function observe(imagePath: string): Promise<ObserveResult>;
```

The model-facing observation schema is:

```json
{
  "type": "object",
  "properties": {
    "features": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": { "type": "string", "enum": ["traffic_side", "script_and_language", "visible_text", "plates", "poles", "bollards_and_barriers", "road_markings", "road_surface", "vegetation", "terrain_and_soil", "built_environment", "vehicles"] },
          "state": { "type": "string", "enum": ["visible", "not_visible"] },
          "text": { "type": "string" }
        },
        "required": ["key", "state", "text"],
        "additionalProperties": false
      }
    }
  },
  "required": ["features"],
  "additionalProperties": false
}
```

On a successful parse, the model response contains exactly one object per `FEATURE_KEYS` entry, in
registry order. `text`
contains only visual observations, never a country, region, city, continent or implication. A missing
or malformed observation response produces `features: []` and a non-null `error`; it does not fabricate
`not_visible` records. The cache key includes the prompt version and image path.

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

`LessonInput` fields are persisted or passed to provider metadata. `featureKey`, `memoryHitId`,
`effect`, `sourceAttemptId` and `idempotencyKey` are machine-readable; copying them only into prose is
not sufficient. `Hint.effect` is present whenever the backend can return stored provenance. A provider
that drops metadata must preserve the effect in its adapter-rendered text using the exact prefix
`[effect=<effect>]` before the lesson content.

Adapters return `MemoryWriteError("write_failed")` for a proven rejection and
`MemoryWriteError("write_outcome_unknown")` when acceptance or completion cannot be proven. They
never convert an unknown write into a successful empty result.

### 3. Retrieval result and attempt trace — `src/tools/memory.ts`

```ts
export type MemoryHit = {
  attemptId: string;
  featureKey: FeatureKey;
  memoryHitId: string;       // generated by the application, stable within the attempt
  providerId: string | null;  // null when the backend has no item id
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
  reflectionStatus: "stored" | "already_stored" | "write_failed" | "write_outcome_unknown" | "reflection_failed";
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

`makeMemoryHitId` uses `attemptId`, `featureKey`, provider identity, normalized text and occurrence
index. The model never creates a hit ID. A hit returned by one attempt is not valid in another attempt.
`makeIdempotencyKey` is a deterministic hash of its three inputs.

`Guess` is the existing structured geolocation result. `memoryGroups` preserves the feature boundary;
the type has no flattened `hints` field. `EpisodeTrace` is append-only for the attempt and is emitted
to tracing/evaluation.

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
        feature_key: { type: "string", enum: FEATURE_KEYS },
        query: { type: "string" },
      },
      required: ["feature_key", "query"],
      additionalProperties: false,
    },
  },
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
        feature_key: { type: "string", enum: FEATURE_KEYS },
        memory_hit_id: { type: "string" },
        effect: {
          type: "string",
          enum: ["helped", "irrelevant", "misleading", "insufficient"],
        },
        content: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        region: { type: "string" },
      },
      required: ["feature_key", "memory_hit_id", "effect", "content", "triggers", "region"],
      additionalProperties: false,
    },
  },
} as const;
```

The `memory_retrieve` result is serialized for the model as one of these envelopes:

```json
{
  "attempt_id": "train-v1:img-42",
  "feature_key": "poles",
  "status": "hits",
  "hits": [
    {
      "memory_hit_id": "train-v1:img-42/poles/8b4d",
      "provider_id": "lesson-0012",
      "text": "Two wooden crossarms are a useful regional separator.",
      "score": 2,
      "effect": "helped"
    }
  ],
  "failure": null
}
```

`status: "no_hit"` uses `hits: []` and `failure: null`. `status: "failed"` uses `hits: []` and a
failure code from `RetrievalFailure`.

Example failure envelope:

```json
{
  "attempt_id": "eval-v1:img-42",
  "feature_key": "poles",
  "status": "failed",
  "hits": [],
  "failure": "timeout"
}
```

`attemptId`, `memory_ref`, `idempotencyKey` and the active memory instance are application context;
the model cannot choose or override them. The dispatcher accepts only the tool that is enabled for
the current phase.

### 5. Tool dispatcher — `src/tools/memory.ts`

```ts
export type MemoryToolPhase = "retrieve" | "reflect";
export type WorkflowMode = "training" | "evaluation" | "production";

export type MemoryRunConfig = {
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
  activeMemoryHit?: MemoryHit;         // required for memory_store
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
```

The dispatcher validates unknown input before calling the selected capability. For retrieval it calls
`reader.recall(query, run.recallLimit)` and converts each returned `Hint` into an application-owned
`MemoryHit` carrying the active attempt and feature. For store it requires `phase: "reflect"`,
`run.mode: "training"`, `run.readOnly: false`, a non-null `writer`, and an active hit whose
`attemptId`, `featureKey` and `memoryHitId` match the episode and tool argument. It constructs
`LessonInput` from validated arguments and application context, then calls `writer.remember`.

### 6. Locate flow — `src/locate.ts` and `src/task.ts`

```ts
export type LocateDeps = {
  memory: MemoryReader;
  run: MemoryRunConfig;
  maxToolAttemptsPerFeature?: 1 | 2; // default 2
};

export function locate(
  input: { attemptId: string; imagePath: string },
  deps: LocateDeps,
): Promise<LocateResult>;
```

The request history is one tool-capable conversation for the attempt. It contains the original image
and observation output. Retrieval is executed in `FEATURE_KEYS` order for eligible features. Each
feature turn exposes only `MEMORY_RETRIEVE_TOOL` with `feature_key.enum` narrowed to the active key,
forces one function call, and sets
`parallel_tool_calls: false`. After the tool result is appended, the next feature is processed. The
final analyze turn exposes no memory tools and returns the existing strict `Guess` schema.

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

`reflectEpisode` receives one `MemoryHit`, never an array of hits. Its model context contains the image,
the feature observation, the selected memory hit, the blind guess, the truth and the distance. It
exposes only `MEMORY_STORE_TOOL`, forces one call and sets `parallel_tool_calls: false`. The dispatcher
compares `attemptId`, `featureKey` and `memoryHitId` from the tool arguments with its active episode.

### 8. Reflection output envelope

```json
{
  "feature_key": "road_markings",
  "memory_hit_id": "attempt-42/road_markings/3",
  "effect": "misleading",
  "content": "A single yellow centre line was visible, but the recalled rule was too broad for this road type. The line should be treated as a weak signal and checked against poles and vegetation.",
  "triggers": ["single yellow centre line", "rural road"],
  "region": "BR"
}
```

`content` is one or two grounded sentences. It states what helped, what did not help, or what was
wrong. It contains no hidden chain-of-thought, tool instructions or unsupported visual claims.

Write failures are returned separately from reflection effect:

```json
{
  "status": "write_outcome_unknown",
  "effect": "misleading",
  "lesson_id": null,
  "failure": "write_outcome_unknown"
}
```

The effect rubric is:

| Effect | Meaning |
|---|---|
| `helped` | The hit supplied a cue consistent with the revealed location and useful for the answer. |
| `irrelevant` | The hit was usable data but did not affect this image's location decision. |
| `misleading` | The hit asserted a wrong cue or pulled the analysis toward the wrong location. |
| `insufficient` | The hit was partly useful but did not contain enough evidence for this decision. |

### 9. Runtime mode, failure and metric envelopes

```ts
export type RetrievalMetric = {
  featureKey: FeatureKey;
  class: "rare" | "broad";
  expectedProviderIds: string[];
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

export type FrozenMemoryConfig = {
  mode: "evaluation";
  snapshotId: string;
  readOnly: true;
};

export type MemoryBinding =
  | { mode: "training"; reader: MemoryReader; writer: MemoryWriter; snapshotId: null; readOnly: false }
  | { mode: "evaluation"; reader: MemoryReader; writer?: never; snapshotId: string; readOnly: true }
  | { mode: "production"; reader: MemoryReader; writer?: never; snapshotId: string | null; readOnly: true };

export function resolveMemoryBinding(config: MemoryRunConfig): Promise<MemoryBinding>;
```

`AttemptMetrics` is emitted once per attempt. Rare/broad fixture labels and expected provider IDs are
defined by the fixed retrieval fixture, not inferred from model output.

Runtime validation requires `mode: "evaluation"` to have a non-empty `snapshotId` and `readOnly: true`,
`mode: "production"` to have `readOnly: true`, and `mode: "training"` to have `readOnly: false`.
The frozen evaluation artifact is the JSONL snapshot selected by `snapshotId`; its content hash is the
run identifier.

## Rules

### O — Observation

| # | Rule |
|---|---|
| O.1 | A successfully parsed `observe` response returns exactly one record for each `FEATURE_KEYS` entry and preserves registry order; an observation error returns zero feature records. |
| O.2 | A record with `state: "not_visible"` is excluded from retrieval and reflection. |
| O.3 | `observe` output is cached by image path and prompt version; cache hits do not call the model. |
| O.4 | Observation failure returns an error record and does not fail the image task; analyze still receives the original image. |
| O.5 | Observation text contains visual facts only and never a geographic implication. |

### R — Retrieval and ranking boundary

| # | Rule |
|---|---|
| R.1 | The dispatcher enables `memory_retrieve` only in the blind retrieve phase. |
| R.2 | Each eligible feature receives exactly one logical retrieval outcome in registry order. |
| R.3 | A retrieval tool call is accepted only when `feature_key` equals the active feature and `query` is a non-empty string of at most 512 characters. |
| R.4 | Internal retrieval retries are capped at 2 attempts per feature and do not create another logical outcome. |
| R.5 | `recallLimit` is capped at 5; a provider result entering the agent context contains at most 5 hits per feature. |
| R.6 | The dispatcher calls `Memory.recall` once with a query derived from the active feature; it never sends a combined feature list. |
| R.7 | `all` recall mode is not allowed in the new tool path; FileMemory uses bounded `top` recall for each feature. |
| R.8 | Retrieval results remain grouped by `featureKey`; no global sort or global top-K is applied after retrieval. |
| R.9 | `no_hit` has an empty hits array and no failure; memory/provider/tool failures have `status: "failed"` and a non-null failure code. |
| R.10 | A `no_hit` or failed retrieval creates no pair episode and no lesson. |
| R.11 | Memory payload is treated as data; it cannot select a backend, change phase, add tools or override the active feature. |
| R.12 | `missing_tool_call`, `multiple_tool_calls`, `malformed_tool_json`, `invalid_tool_arguments` and `wrong_feature` consume one model attempt and retry once; after the second attempt the feature is `failed`. |

### A — Analysis

| # | Rule |
|---|---|
| A.1 | The final analyze request receives the original image even when observation or retrieval failed. |
| A.2 | Analyze receives every `FeatureMemoryGroup` in stable feature order, including empty or failed groups. |
| A.3 | Analyze may use a memory hit only as a hypothesis consistent with the image; the final response uses the existing strict `Guess` schema. |
| A.4 | The analyze phase has no `memory_store` tool and does not receive ground truth. |
| A.5 | The attempt trace stores the feature key, query, retrieval outcome and returned hit IDs before the guess is finalized. |

### E — Episodes and reflection

| # | Rule |
|---|---|
| E.1 | Each returned `MemoryHit` carries the active `attemptId` and `featureKey` and creates exactly one episode identified by those fields plus `memoryHitId`; a hit with mismatched attempt or feature is rejected. |
| E.2 | One episode sends exactly one reflection request; reflection receives one memory hit, never a hit array. |
| E.3 | Reflection receives the image, observed feature text, memory hit, blind guess, ground truth and distance. |
| E.4 | Reflection returns exactly one `effect` from `helped`, `irrelevant`, `misleading`, `insufficient`. |
| E.5 | A valid reflection outcome produces one independent lesson and one `memory_store` call, including valid negative/counter-signal lessons; the store result is `stored` or `already_stored`. |
| E.6 | Reflection content is grounded in the image, memory hit and revealed truth, and has at most two sentences. |
| E.7 | A reflection or write failure affects only its episode; previously stored episode lessons are not rolled back. |
| E.8 | Reflection does not run for `not_visible`, `no_hit`, failed retrieval or a hit outside the active attempt. |
| E.9 | The model cannot set `sourceAttemptId` or `idempotencyKey`; both are generated by the application. |
| E.10 | A store payload has non-empty `content` of at most 2,000 characters, 1–8 non-empty triggers of at most 128 characters, and a two-uppercase-letter `region`. |
| E.11 | The reflection prompt applies the effect rubric: `helped`, `irrelevant`, `misleading` and `insufficient` have the meanings defined in the contract. |

### P — Persistence and provenance

| # | Rule |
|---|---|
| P.1 | Every stored lesson contains machine-readable `sourceAttemptId`, `featureKey`, `memoryHitId`, `effect`, `region`, triggers and `idempotencyKey`. |
| P.2 | `idempotencyKey` is deterministic for one `attemptId + featureKey + memoryHitId`; a repeated store is a no-op returning the existing lesson ID. |
| P.3 | `misleading`, `irrelevant` and `insufficient` effects remain distinguishable when a lesson is rendered for a future prompt; adapters without metadata use `[effect=<effect>]`. |
| P.4 | `memory_ref`/backend selection is supplied by workflow context and is never accepted from tool arguments. |
| P.5 | The dispatcher rejects `memory_store` unless `phase: "reflect"`, `run.mode: "training"` and `run.readOnly: false`; evaluation and production are read-only. |
| P.6 | Evaluation uses a frozen snapshot and never updates hit counters or lessons. |
| P.7 | Training excludes eval IDs and rows sharing an eval sequence; memory-on and control use the same frozen sample and observation cache. |
| P.8 | Runtime rejects inconsistent mode configuration: evaluation requires a non-empty frozen snapshot and read-only access; production is read-only; training is writable. |

### B — Budget, safety and failure handling

| # | Rule |
|---|---|
| B.1 | The maximum eligible feature count is `FEATURE_KEYS.length` (12). |
| B.2 | `memory_retrieve` and `memory_store` use strict schemas with `additionalProperties: false` and all declared fields required. |
| B.3 | `parallel_tool_calls` is false for retrieval and reflection. |
| B.4 | A malformed tool call is rejected before provider access and may be retried within the phase attempt budget. |
| B.5 | A retrieval timeout/provider error is recorded for its feature and does not become a fake empty lesson. |
| B.6 | A write timeout with unknown outcome is recorded as `write_outcome_unknown`; the same episode is not blindly written again. |
| B.7 | Tool results and stored lessons are data, not executable instructions. |
| B.8 | The production path is `observe → retrieve → analyze`; `reflect` and `memory_store` are training-only. |
| B.9 | A run budget allows at most 24 retrieval model attempts, 60 memory hits, 60 reflection requests and 60 store calls per attempt. |

## Out of scope

- Changing model weights or fine-tuning the vision model.
- Replacing provider-native ranking inside one feature group with BM25, IDF, a vector index or a new ranking algorithm.
- Cross-feature global ranking, global top-K merging or one aggregated lesson for a photograph.
- Adding new observe slots or changing the feature registry version.
- Automatic promotion of training memory into production memory.
- Automatic quarantine UI, human review workflow or rollback tooling for bad lessons.
- Snapshot/restore implementation for hosted memory backends.
- Geocoder changes, multi-image inference and user-facing response format changes.

## Tests

| # | Where | Asserts | Maps to |
|---|---|---|---|
| 1 | `src/observe.test.ts` | Successful observation contains one ordered record per registry key and rejects geographic implications. | O.1, O.5, B.1 |
| 2 | `src/observe.test.ts` | `not_visible` records are excluded from eligible features. | O.2 |
| 3 | `src/observe.test.ts` | Same image/prompt version uses cache; changed prompt version or image path makes a new call. | O.3 |
| 4 | `src/observe.test.ts` | Model/parse failure returns an error result and locate keeps the original image path. | O.4, A.1 |
| 5 | `src/tools/memory.test.ts` | Tool definitions are strict, complete and expose only the phase-appropriate operation; payloads are returned as data. | R.1, B.2, B.7, B.8 |
| 6 | `src/tools/memory.test.ts` | Wrong feature, empty/overlong query, missing/multiple tool calls and malformed JSON are rejected before Memory. | R.3, R.6, R.12, B.4 |
| 7 | `src/tools/memory.test.ts` | Retrieval calls Memory with one query and returns at most five hits with stable IDs. | R.5, R.6 |
| 8 | `src/tools/memory.test.ts` | `all` mode is rejected for the new dispatcher and no global merge occurs. | R.7, R.8 |
| 9 | `src/tools/memory.test.ts` | Empty result, provider error, timeout, skipped feature and exhausted budget get distinct outcomes and no episode. | R.9, R.10, B.5, B.9 |
| 10 | `src/agent.test.ts` | Retrieve loop processes visible features in order, retries at most twice, appends tool results before analyze and sets `parallel_tool_calls: false` for retrieve and reflection. | R.2, R.4, R.12, B.3, A.5 |
| 11 | `src/agent.test.ts` | Final analyze sees original image and all stable feature groups, with no memory_store or ground truth. | A.1, A.2, A.4, R.11 |
| 12 | `src/task.test.ts` | Guess remains valid when observe/retrieval has partial failures; groups are not flattened and memory is treated as hypothesis data. | A.2, A.3, B.5 |
| 13 | `src/reflect.test.ts` | One reflection receives exactly one feature and one memory hit plus guess/truth/distance. | E.1, E.2, E.3 |
| 14 | `src/reflect.test.ts` | All four effect values follow the rubric; reflection prompt contains image/hit/truth grounding, content is at most two sentences, fields are bounded and reflection failure is distinct. | E.4, E.6, E.10, E.11 |
| 15 | `src/reflect.test.ts` | A valid positive, irrelevant, misleading or insufficient episode makes exactly one store call with app-owned provenance. | E.5, E.9 |
| 16 | `src/reflect.test.ts` | No-hit, not-visible, failed retrieval and foreign hit do not invoke reflection/store. | E.8, R.10 |
| 17 | `src/task.test.ts` | One episode reflection/write failure does not rollback another stored lesson and unknown write is not retried. | E.7, B.6 |
| 18 | `src/memory/file/memory.test.ts` | Lesson metadata and effect survive persistence, rendering distinguishes negative effects, and duplicate idempotency is a cross-process no-op returning the existing ID. | P.1, P.2, P.3 |
| 19 | `src/memory/mem0/memory.test.ts` | Mem0 adapter passes episode provenance/effect metadata, preserves provider errors and never accepts memory_ref from lesson input. | P.1, P.4, B.5 |
| 20 | `src/task.test.ts` | Training may write after reveal; evaluation/production receives reader-only binding, direct write/restore is unavailable, frozen memory does not mutate, and inconsistent mode config is rejected. | P.5, P.6, P.8, B.8 |
| 21 | `src/train.test.ts` | Training selection excludes eval IDs/sequences; control and memory-on share sample/order/cache contract. | P.7 |
| 22 | `src/experiment.test.ts` | Trace contains groups, hits, verdicts and no global top-K; comparison reports feature-scoped versus legacy global rare-cue hit rates and geoscore. | A.5, R.8, P.6 |
| 23 | `src/feature-memory.e2e.test.ts` | Twelve-feature attempt with mixed failures, five hits per feature, duplicate store, reader-only evaluation and frozen memory proves cardinality, no global merge and all numeric budgets. | R.2, R.5, R.8, R.9, E.1, E.2, E.5, E.7, P.2, P.5, P.6, P.7, B.9 |

## Execution

### Lock

- Expected branch: `feat/feature-scoped-memory-tools`
- Preflight check: [ ] confirm branch is based on current `main`, working tree changes are unrelated or understood, and no implementation already exists.

### ADR traceability

| ADR invariant | Established in |
|---|---|
| Feature-scoped bounded retrieval; no global top-K | Phase 2 |
| Tools available to the agent but phase-controlled by application | Phase 2 and Phase 4 |
| One episode per `feature + memory hit` | Phase 3 |
| One independent store per valid episode | Phase 4 |
| Blind/evaluation read-only and post-reveal training writes | Phase 3 and Phase 5 |
| Frozen benchmark isolation | Phase 5 |

### Phase 1 — Contracts and deterministic dispatcher

**Objective.** Add feature, hit, episode, effect, lesson metadata and tool dispatcher contracts with a
fake in-memory backend.

**Work.**
- Add `FeatureKey`, `FeatureObservation`, `ReflectionEffect`, `MemoryHit`, trace and outcome types.
- Extend `LessonInput`, `Lesson`, `Hint`, typed `MemoryWriteResult`, reader/writer bindings and adapter metadata projections.
- Implement strict `memory_retrieve`/`memory_store` definitions and dispatcher validation.
- Implement deterministic hit IDs and idempotency keys.
- Add tests #5–#9.

**Dependencies.** None (foundational slice).

**Risks.**
- *Existing adapters reject new lesson fields.* Update validation and metadata projection together; keep provider errors typed.
- *Provider IDs are missing or duplicated.* Generate attempt-scoped IDs using feature and occurrence index.

**Validation.** Tests #5–#9 pass. `npm run typecheck` passes.

**Done.** A fake backend can retrieve one bounded feature group and store one idempotent episode lesson.

### Phase 2 — Observe and feature-scoped retrieve loop

**Objective.** Replace string-only observation with the fixed feature registry and add the model tool
loop that retrieves one bounded group per eligible feature.

**Work.**
- Change observe schema/prompt/cache normalization to `FeatureObservation[]`.
- Preserve the success/error observation cardinality and cache behavior.
- Keep the image in the tool-loop and final analyze request.
- Process visible features in registry order with `parallel_tool_calls: false`.
- Enforce active feature, two-attempt cap, one-item Memory query and five-hit bound.
- Reject FileMemory `all` mode in this path and use `top` mode.
- Add tests #1–#4 and #10–#11.

**Dependencies.** Phase 1.

**Risks.**
- *Configured model does not emit the forced function call.* Record a bounded tool error and continue with the image; do not synthesize a hit.
- *Per-feature calls exceed provider quota.* Keep sequential calls and expose counts/latency in trace.

**Validation.** Tests #1–#4 and #10–#11 pass. Full existing agent/task tests pass.

**Done.** A replayed attempt produces one bounded, traceable group per eligible feature and a final Guess without a flattened hint list.

### Phase 3 — Analyze integration and episode ledger

**Objective.** Integrate grouped retrieval into `runTask` and establish the episode set before reveal.

**Work.**
- Replace the single `memory.recall(features, limit)` path in the new flow.
- Store groups and returned hit IDs in `LocateResult` and Phoenix trace.
- Keep no-hit/error groups without creating episodes.
- Preserve existing Guess parsing, backoff and structured task failures.
- Add test #12 and regression coverage for no-hit/failed groups.

**Dependencies.** Phase 2.

**Risks.**
- *Existing benchmark consumers expect `hints` and `hintCount`.* Provide a compatibility projection for telemetry while making grouped context canonical.
- *A failed group changes denominator behavior.* Keep the task row and record the group failure explicitly.

**Validation.** Test #12 passes. `npm run typecheck` passes.

**Done.** Every returned memory hit has exactly one stable episode candidate, and no-hit/errors have none.

### Phase 4 — Per-episode reflection and persistence

**Objective.** Reflect on each feature/hit pair and store one independent lesson with effect and
machine-readable provenance.

**Work.**
- Replace image-level `reflect` with `reflectEpisode` over each hit.
- Expose only `memory_store` after reveal and force one call per episode.
- Validate effect, active hit, feature, content, triggers and ISO region.
- Persist effect/provenance through FileMemory and Mem0; implement duplicate no-op and unknown-write handling.
- Add tests #13–#20.

**Dependencies.** Phase 3.

**Risks.**
- *Write count grows with hits.* Keep the five-hit cap and collect per-episode latency/cost.
- *Negative lessons are rendered as positive hints.* Preserve effect metadata and an explicit counter-signal marker in every adapter projection.
- *Provider write outcome is unknown.* Record it and do not automatically retry the same idempotency key.

**Validation.** Tests #13–#20 pass. `npm run typecheck` and all relevant memory adapter suites pass.

**Done.** A successful reflection episode produces exactly one independently attributable lesson or a visible terminal failure.

### Phase 5 — Benchmark, controls and rollout gate

**Objective.** Make the new flow measurable against a legacy global top-K control and preserve
benchmark isolation.

**Work.**
- Update training/evaluation to use frozen sample, cached observations and explicit cold/warm mode.
- Add feature-scoped versus legacy-global rare/broad hit-rate, effect, episode, cost and latency metrics.
- Verify no evaluation/production store access and train exclusion of eval IDs/sequences.
- Run file backend first, then Mem0 through the same tool dispatcher.
- Add tests #21–#23 and run the repository health commands.

**Dependencies.** Phases 1–4.

**Risks.**
- *New call volume changes baseline comparability.* Run memory-on and control on the same manifest and report model/tool counts separately.
- *Backend-specific metadata is lost.* Fail the provenance test for that adapter; do not silently claim episode-level attribution.

**Validation.** Tests #21–#23, `npm run typecheck`, `npm run sample`, `git diff --check`, and the relevant memory test scripts pass.

**Done.** A frozen pilot reports grouped retrieval, per-episode reflection/store outcomes, rare/broad hit rates, geoscore and no evaluation writes.

## Done criteria

- All 23 tests in §Tests pass; full relevant test suites are green.
- `npm run typecheck` and `npm run sample` pass after source changes.
- `observe` produces the versioned feature registry and preserves the original image for analyze.
- Each eligible feature has exactly one bounded logical retrieval outcome with no global top-K merge.
- Each returned memory hit has exactly one reflection outcome; each valid outcome has one independent store call.
- Stored lessons contain machine-readable attempt, feature, memory hit, effect and idempotency provenance.
- No-hit, retrieval failure, reflection failure and unknown write outcome remain distinguishable.
- Evaluation and production cannot call `memory_store`; evaluation reads only frozen memory state.
- Trace and pilot output expose feature groups, memory hits, verdicts, rare/broad hit rates, geoscore,
  valid output, token cost and latency.
- No one-image aggregated lesson is written and no existing global top-K result is used as the sole
  analysis context.
