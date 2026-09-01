---
type: Specification
title: "Dynamic feature memory tools без geo-policy"
description: Актуальный контракт model-generated набора визуальных признаков без post-hoc geo-фильтрации, с bounded retrieval, reflection и benchmark isolation.
timestamp: 2026-09-01T00:00:00+03:00
date: 2026-09-01
model: gpt-5
version: 4
tags: [loci, memory, tools, observe, reflection, dynamic-features, specification]
---

# Spec: Dynamic feature memory tools без geo-policy

Эта спецификация является следующей итерацией [dynamic feature memory tools](/specs/memory-tools-observe-dynamic-features/spec.md).
Она меняет observation validation и явно переопределяет reflection для `no_hit`: geo dictionary,
geo policy и semantic content rejection удалены, а подключённая память теперь получает episode
для пары `feature + null`, если retrieval не вернул hit. Остальные dynamic feature, memory, locate,
reflection, train и evaluation contracts предыдущей спецификации остаются нормативными, если ниже
явно не переопределены.

## Changes from v1

Из v1 удалены `src/observe-geo-entities.json`, `ObservationGeoPolicy`, `loadEntities`,
`buildEntityPattern`, `entityPattern`, `implicationPattern`, geo-policy version и geo-entity digest
из cache identity. `text` проверяется только структурно. Все статические инструкции agent flow и
model-facing tool/provider instructions вынесены из TypeScript в отдельные Markdown prompt assets
под `src/promts/`.

## Goal

Реализовать dynamic `observe → retrieve → analyze → reflect` flow, в котором vision-модель сама
формирует variable набор features для конкретной фотографии. Runtime принимает любой structurally
valid feature text, выполняет feature-scoped retrieval и сохраняет связь
`feature → hit|null → episode → lesson`.

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

export const MAX_FEATURES = 12; // budget cap, not a vocabulary or required slot count
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

Model-facing schema:

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
          "key": { "type": "string", "minLength": 1, "maxLength": 64 },
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

The schema describes a dynamic array, not an enum. Model output may contain zero to twelve records;
there is no fixed list and no required `state` or `not_visible` record. The prompt may include examples
such as traffic, writing, plates, poles, barriers, markings, surface, vegetation, terrain, buildings,
vehicles, lighting and camera coverage, but examples are suggestions only.

```ts
export const OBSERVE_PROMPT_VERSION = "dynamic-features-v2" as const;
export const OBSERVE_SCHEMA_VERSION = "dynamic-features-schema-v2" as const;
export const OBSERVE_PROMPT = [
  "ROLE: You are a visual observation instrument.",
  "FEATURE EXAMPLES: traffic, writing, plates, poles, barriers, markings, surface, vegetation, terrain, buildings, vehicles, lighting and camera coverage.",
  "OUTPUT SHAPE: Return JSON only as {\"features\":[{\"key\":\"descriptive key\",\"text\":\"literal visual fact\"}]}.",
  "VISUAL-ONLY RULES: Emit only features grounded in what is visible in the current image.",
  "KEY RULES: Choose one concise descriptive key per useful cue. Examples are not a fixed list. Omit features that are not visible; do not fabricate placeholder records.",
  "TEXT RULES: Use a short phrase of visible facts. Preserve visible writing as observed text when present; do not add unsupported conclusions.",
  "JSON-ONLY RESPONSE: Do not add prose outside the JSON object.",
].join("\n");
```

Before persistence, application normalization applies Unicode NFKC, trims, lowercases and replaces
runs of spaces or hyphens with `_`. The normalized key must match `^[a-z][a-z0-9_]{0,63}$`, must not
match `/^(?:other|misc|unknown|feature|cue|item)(?:_?[0-9]+)?$/`, and must be unique within the
response. A structural or key validation failure rejects the complete response; raw and normalized
keys are not both retained. No substring, entity, implication or semantic rule is applied to `text`.

The cache key is exactly:
`sha256(OBSERVE_SCHEMA_VERSION + "\\0" + OBSERVE_PROMPT_VERSION + "\\0" + model + "\\0" + seed + "\\0" + imagePath + "\\0" + imageDigest)`.
`imageDigest` is SHA-256 of the current image bytes. Only a successful parsed result is cached; cache
hits do not call the model. Changing a geo dictionary cannot affect the cache because no geo artifact
is loaded or consulted.

### 2. Prompt assets — `src/promts/`

Every static instruction sent to an OpenAI model in the agent flow MUST live in its own Markdown file:

```text
src/promts/agent.md
src/promts/observe.md
src/promts/retrieve.md
src/promts/analyze.md
src/promts/reflect.md
src/promts/memory-retrieve.md
src/promts/memory-store.md
src/promts/mem0-extraction.md
src/promts/hindsight-retain.md
```

```ts
export type PromptName =
  | "agent"
  | "observe"
  | "retrieve"
  | "analyze"
  | "reflect"
  | "memory-retrieve"
  | "memory-store"
  | "mem0-extraction"
  | "hindsight-retain";

export const PROMPT_FILES: Record<PromptName, string> = {
  agent: "src/promts/agent.md",
  observe: "src/promts/observe.md",
  retrieve: "src/promts/retrieve.md",
  analyze: "src/promts/analyze.md",
  reflect: "src/promts/reflect.md",
  "memory-retrieve": "src/promts/memory-retrieve.md",
  "memory-store": "src/promts/memory-store.md",
  "mem0-extraction": "src/promts/mem0-extraction.md",
  "hindsight-retain": "src/promts/hindsight-retain.md",
};

export function loadPrompt(name: PromptName): string;
```

The loader resolves paths relative to the source module and returns UTF-8 Markdown. It MUST fail fast
when a required asset is missing or empty. Runtime interpolation may append serialized image, feature,
hit or answer data, but static instruction prose MUST NOT be duplicated in `.ts` prompt constants.
Prompt files MUST be included in package/runtime distribution and their contents MUST be covered by
unit tests. Tool schema descriptions MUST be loaded from `memory-retrieve.md` and `memory-store.md`.
Provider instructions sent to a model-backed provider MUST be loaded from their named assets.
`OBSERVE_PROMPT_VERSION` and other cache/trace versions remain explicit TypeScript constants; prompt
bodies themselves are read from Markdown assets.

### 3. Memory, tools and runtime

The following contracts are inherited unchanged from the predecessor spec:

- `MemoryReader.recall(query: string, limit: number): Promise<Hint[]>` and typed `MemoryWriter.remember`.
- Dynamic `memory_retrieve` and `memory_store` envelopes, provider error mapping and `memoryRef` binding.
- `FeatureMemoryGroup`, `MemoryRunConfig`, `LocateResult`, trace/provenance fields and `memoryRef:null`
  no-hit behavior.
- Feature-scoped query ownership, one logical outcome per emitted feature, blind/reveal boundary,
  per-hit and per-no-hit reflection, deterministic idempotency and train/evaluation isolation.

Implementers MUST read the inherited contracts before coding:
[predecessor spec](/specs/memory-tools-observe-dynamic-features/spec.md), [memory tools](/tools/index.md),
[locate workflow](/workflows/locate.md), [train workflow](/workflows/train.md) and
[evaluation workflow](/workflows/evaluate.md).

## Rules

### Observe

| ID | Rule |
| --- | --- |
| O1 | The model chooses zero or more features from the current image; the application does not inject a fixed registry or placeholder records. |
| O2 | `MAX_FEATURES` is an upper resource bound only; model order is preserved after successful normalization. |
| O3 | Application validation covers JSON shape, required fields, string bounds, key normalization, generic-key rejection and duplicate normalized keys. |
| O4 | Application never rejects a structurally valid feature because its `key` or `text` contains a country, region, city, continent, language, writing system or implication phrase. |
| O5 | Malformed model output returns `features: []` and non-null `error`; it never fabricates observations. |
| O6 | Cache identity contains schema version, prompt version, model, seed, image path and current image digest, and no geo-policy input. |
| O7 | A cache hit returns the cached successful observations without a model call; failed parses are not cached. |

### Prompt assets

| ID | Rule |
| --- | --- |
| P1 | Every static model instruction used by `agent`, `observe`, `retrieve`, `analyze`, `reflect`, model-facing tool metadata or model-backed provider calls is stored in a matching `src/promts/*.md` file. |
| P2 | TypeScript contains no duplicate static prompt body; it only loads an asset and performs runtime interpolation. |
| P3 | Missing or empty prompt assets fail before the corresponding model request. |
| P4 | Prompt assets are shipped with the runtime and are read as UTF-8 Markdown from a path relative to the module, not the caller working directory. |
| P5 | Prompt asset content is covered by tests for file existence, non-empty content and usage by the corresponding model request. |

### Retrieval and analysis

| ID | Rule |
| --- | --- |
| R1 | The application performs at most one logical retrieval outcome per emitted feature and never performs a global cross-feature retrieval. |
| R2 | The model may generate a query for the active feature, while the application selects the active feature, validates the query, resolves `memoryRef` and owns provider execution. |
| R3 | Each group records the original dynamic `featureKey`, query, hits, outcome, retry count and trace provenance. |
| R4 | `memoryRef:null` creates a synthetic `no_hit` group per emitted feature without retrieval model turns, provider calls or writes. |
| R5 | Provider and binding failures use the inherited explicit mapping and never become silent empty successes. |

### Episodes and persistence

| ID | Rule |
| --- | --- |
| E1 | Every returned memory hit creates exactly one episode candidate keyed by attempt, feature and hit identity. |
| E1a | Every valid `no_hit` group with a connected memory creates exactly one episode candidate keyed by attempt, feature and a null hit identity. |
| E2 | Reflection occurs after reveal and receives only the episode's feature, an optional hit (`MemoryHit | null`) and final answer context. |
| E3 | Every attempted episode ends with `stored`, `already_stored`, `write_failed`, `reflection_failed` or another explicit terminal outcome. |
| E4 | Lessons retain `sourceAttemptId`, `featureKey`, nullable `memoryHitId`, effect and deterministic idempotency key. |
| E5 | A valid `no_hit` episode is reflected and stored independently; absent features, failed/skipped/invalid groups and `memoryRef:null` do not reflect or store. |

### Boundaries

| ID | Rule |
| --- | --- |
| B1 | Blind solve does not receive memory hits or lessons; reveal happens only after retrieval and answer generation. |
| B2 | Training may write lessons; evaluation is read-only and does not call reflection or store. |
| B3 | Provider-native failures are mapped at the binding boundary and preserve enough provenance for retry/abort decisions. |

## Out of scope

- Semantic moderation or classification of geographic leakage in observation text.
- Any checked-in country, subdivision, city or continent dictionary for observation parsing.
- Changing provider-native ranking, geocoder behavior, Guess schema or benchmark dataset.
- Semantic synonym merging of dynamic keys.

## Tests

| # | Where | Asserts | Maps to |
| --- | --- | --- | --- |
| 1 | `src/observe.test.ts` | Empty dynamic array is accepted. | O1, O2 |
| 2 | `src/observe.test.ts` | One arbitrary model-generated key is accepted and normalized. | O1, O3 |
| 3 | `src/observe.test.ts` | Two different images at the same path do not share a cache hit. | O6, O7 |
| 4 | `src/observe.test.ts` | Prompt/schema/model/seed changes miss cache. | O6, O7 |
| 5 | `src/observe.test.ts` | Model order is preserved. | O2 |
| 6 | `src/observe.test.ts` | More than twelve features is rejected. | O2, O3 |
| 7 | `src/observe.test.ts` | Duplicate normalized keys reject the complete response. | O3, O5 |
| 8 | `src/observe.test.ts` | Generic and invalid keys reject the complete response. | O3, O5 |
| 9 | `src/observe.test.ts` | Malformed JSON is not cached and returns an error. | O5, O7 |
| 10 | `src/observe.test.ts` | Country/city-like text and visible writing text pass when structurally valid. | O4 |
| 11 | `src/tools/memory.test.ts` | Dynamic retrieve validates feature key/query and returns typed envelope. | R1, R2, R3, R5 |
| 12 | `src/tools/memory.test.ts` | Dynamic store returns typed idempotent outcome. | E4, B3 |
| 13 | `src/locate-runtime.internal.test.ts` | One group/outcome exists per emitted feature. | R1, R3 |
| 14 | `src/locate-runtime.internal.test.ts` | `memoryRef:null` creates no-hit groups without memory calls. | R4 |
| 15 | `src/locate-runtime.internal.test.ts` | Binding failures preserve explicit failure and retry/abort behavior. | R5, B3 |
| 16 | `src/feature-memory.test.ts` | Hits remain isolated by dynamic feature key. | R1, R3 |
| 17 | `src/episode-ledger.internal.test.ts` | Episode identity includes feature and hit identity. | E1 |
| 18 | `src/reflect.test.ts` | Reflection receives only revealed episode context. | E2, B1 |
| 19 | `src/train.test.ts` | Reflection/write failures become explicit terminal outcomes. | E3 |
| 20 | `src/train.test.ts` | Training stores provenance and deterministic idempotency. | E4, B2 |
| 21 | `src/evaluate.test.ts` | Evaluation has no reflection or store calls. | B2 |
| 22 | `src/locate-runtime.internal.test.ts` | Final result uses canonical `LocateResult` groups and trace. | B1, B3 |
| 23 | `src/observe.test.ts` | No fixed twelve-key list or mandatory placeholder is required. | O1, O2 |
| 24 | `src/observe.test.ts` | No runtime geo dictionary read or semantic content rejection occurs. | O4, O6 |
| 25 | `src/prompts.test.ts` | All five prompt assets exist, are non-empty UTF-8 Markdown and map to unique prompt names. | P1, P4, P5 |
| 26 | `src/observe.test.ts` | Observe request uses the contents of `src/promts/observe.md`. | P2, P5 |
| 27 | `src/agent.test.ts` | Solve request uses `src/promts/agent.md` and appends runtime hints without inline replacement prose. | P2, P5 |
| 28 | `src/locate-runtime.internal.test.ts`, `src/reflect.test.ts` | Retrieve/analyze/reflect requests use their corresponding Markdown assets. | P1, P2, P5 |
| 29 | `src/prompts.test.ts`, `src/tools/memory.test.ts` | Retrieve/store tool descriptions come from `memory-retrieve.md` and `memory-store.md`. | P1, P2, P5 |
| 30 | `src/memory/mem0/memory.test.ts`, `src/memory/hindsight/platform.integration.test.ts` | Mem0 extraction and Hindsight retain instructions come from their Markdown assets. | P1, P2, P5 |

## Execution

### Lock

- Branch: `feat/feature-scoped-memory-tools`
- The spec is read-only during implementation; documentation changes require a new version/iteration.

### Phase 1 — Dynamic observe без geo-policy

**Objective.** Replace fixed observation registry, remove geo dictionary/policy from parser and cache,
and externalize every static agent prompt.

**Work.** Migrate `src/observe.ts` to dynamic string keys; preserve structural validation and bounds;
remove `src/observe-geo-entities.json` and all geo imports; move static instructions to
`src/promts/agent.md`, `observe.md`, `retrieve.md`, `analyze.md` and `reflect.md`; add a UTF-8 loader;
update cache identity, prompt versions, fixtures and tests.

**Dependencies.** None.

**Risks.** Existing tests may encode fixed slots or geo rejection; update only those assertions to the new contract.

**Validation.** Tests 1–10, 23–30; typecheck; full suite green.

**Done.** A structurally valid feature containing geographic-looking text is returned unchanged and is
cacheable, and every static model/tool/provider instruction is loaded from a non-empty Markdown asset.

### Phase 2 — Dynamic memory tools

**Objective.** Route arbitrary normalized feature keys through typed retrieve/store contracts.

**Work.** Remove fixed FeatureKey unions from tools and memory adapters; validate dynamic payloads;
preserve result envelopes, provenance, idempotency and binding failure mapping.

**Dependencies.** Phase 1.

**Risks.** Legacy provider adapters may expose different native shapes; keep adaptation at boundaries.

**Validation.** Tests 11–12; adapter suites; typecheck; full suite green.

**Done.** A feature key not known at compile time can complete retrieval and typed store handling.

### Phase 3 — Locate and ledger integration

**Objective.** Execute one isolated memory group per emitted dynamic feature and expose canonical result shape.

**Work.** Iterate model output in order; resolve memory bindings; implement no-memory groups; preserve trace,
retry/abort and episode identity.

**Dependencies.** Phase 2.

**Risks.** Existing runtime may flatten fixed registry state; use dynamic group order as the sole source of truth.

**Validation.** Tests 13–17, 22; typecheck; full suite green.

**Done.** Locate returns one traceable group for every emitted feature and no hidden global retrieval.

### Phase 4 — Reflection, training and evaluation

**Objective.** Reflect every valid dynamic feature episode, including a no-hit feature with a null
memory hit, while keeping training/evaluation isolation.

**Work.** Create explicit episode outcomes for returned hits and valid no-hit groups; pass reveal-only
context with an optional hit to reflection; persist nullable dynamic provenance; keep evaluation read-only.

**Dependencies.** Phase 3.

**Risks.** A failed reflection or unknown write result can disappear from counters; record an explicit terminal outcome.

**Validation.** Tests 18–21; typecheck; full suite green.

**Done.** Every returned hit and valid connected-memory no-hit group has a terminal episode result,
and only training can write lessons.

### Phase 5 — Benchmark and final verification

**Objective.** Verify bounded dynamic behavior and project-wide acceptance criteria.

**Work.** Run benchmark controls, adapter pilots where configured, full unit/integration checks and documentation validation.

**Dependencies.** Phases 1–4.

**Risks.** External dataset or credentials may be unavailable; report the exact blocked check without weakening local acceptance.

**Validation.** Tests 1–30; `npm run typecheck`; `npm run sample`; OKF validation; `git diff --check`.

**Done.** All local dynamic-feature tests and type checks pass, with external blockers explicitly reported.

## Done criteria

- Observation produces a variable model-generated array with zero to twelve records and no fixed vocabulary.
- Structural validation rejects malformed, oversized, invalid or duplicate-key responses without fabricating records.
- Structurally valid geographic-looking text is preserved; no geo dictionary or semantic content filter is loaded.
- Cache identity includes schema, prompt, model, seed, image path and image digest only.
- All static agent instructions are separate non-empty Markdown assets under `src/promts/` and are loaded by name.
- Model-facing tool descriptions and provider instructions are also Markdown assets; no static instruction body is duplicated in TypeScript.
- Retrieval, reflection and lessons retain dynamic feature provenance and explicit outcomes.
- Connected-memory `no_hit` groups run one reflection with `memoryHit: null` and may create one
  feature lesson; absent features, failed/skipped/invalid groups and `memoryRef:null` do not reflect.
- `memoryRef:null` performs no memory model/provider/write calls and creates per-feature no-hit groups.
- Blind/reveal boundaries and training/evaluation isolation remain enforced.
- Required tests and typecheck pass; unavailable dataset/credential checks are reported explicitly.
