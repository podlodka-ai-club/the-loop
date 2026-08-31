---
type: Specification
title: "Hindsight Cloud adapter v1"
description: Контракт Hindsight Cloud-адаптера Loci с API key, synchronous retain, native recall и pilot-only ограничениями.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
version: 2
tags: [loci, memory, hindsight, cloud, typescript, adapter, specification]
---

# Spec: Hindsight Cloud adapter v1

Операционализирует [принятый ADR](adr.md). Спецификация создаёт реализацию dynamic `Memory`,
Cloud transport port, нормализованные ошибки и disposable pilot для Hindsight.

Изменения v1: публичная граница адаптера использует один dynamic query и typed write result;
старые array-query примеры описывают только внутреннюю compatibility-логику провайдера.

Массивы `features` в pilot fixtures и native query template являются внутренними входными данными
пилота. Через публичную границу dynamic `Memory.recall(query, limit)` адаптер получает одну строку.

Dynamic retain persists source attempt, feature key, memory hit ID, effect, region, triggers and
idempotency key as machine-readable metadata; recall returns the available provenance or the exact
`[effect=<effect>]` prefix when the provider cannot return metadata.

## Goal

Реализовать `remember` и native `recall` поверх Hindsight Cloud через exact-pinned TypeScript SDK.
Перед границей адаптера registry разрешает `memory_ref` в Cloud bank и credential binding; адаптер
получает resolved source и API key, не реализует snapshot/restore и не изменяет общий контракт
`Memory`, training workflow или evaluation workflow.

## Glossary

- **Cloud bank** — изолированная область Hindsight Cloud, выбранная через `memory_ref`.
- **Fact** — один provider memory unit, извлечённый Hindsight из retained content.
- **Prior query** — фиксированный запрос для `recall` при отсутствии features.
- **Unknown write outcome** — ошибка после timeout, когда Cloud мог уже принять запись.
- **Quarantined adapter** — экземпляр адаптера, который после unknown write больше не выполняет read/write.
- **Defensive slice** — локальное ограничение provider results до `limit` после сохранения их порядка.

## Contract

### 1. Package, scripts and environment

Изменения в `package.json` и `.env.example` должны содержать следующие значения:

```json
{
  "dependencies": {
    "@vectorize-io/hindsight-client": "0.9.2"
  },
  "scripts": {
    "test:hindsight": "node --test src/memory/hindsight/*.test.ts",
    "test:hindsight:integration": "node --env-file-if-exists=.env --test src/memory/hindsight/platform.integration.test.ts",
    "hindsight:pilot": "node --env-file-if-exists=.env src/memory/hindsight/pilot.ts"
  }
}
```

```dotenv
# Hindsight Cloud API key. Bank and memory_ref come from the resolved registry source.
HINDSIGHT_API_KEY=
```

The adapter has exactly one environment variable. Cloud URL, timeouts, recall budget, token budget
and prior query are code defaults or programmatic policy values; bank and `memory_ref` are not read
from environment.

### 2. Cloud bank policy

Bank configuration is an operator prerequisite; the runtime adapter does not create, update or
delete banks.

```ts
export const HINDSIGHT_CLOUD_BASE_URL = "https://api.hindsight.vectorize.io" as const;
export const HINDSIGHT_RETAIN_CONTEXT = "loci_training_reflection" as const;

export type HindsightMemorySource = {
  memoryRef: string;
  provider: "hindsight";
  deployment: "cloud";
  bankId: string;
  purpose: "integration" | "pilot";
  credentialEnv: "HINDSIGHT_API_KEY";
};

export function resolveHindsightMemorySource(
  input: {
    memoryRef: string;
    bankId: string;
    purpose: "integration" | "pilot";
  },
): HindsightMemorySource;

export type HindsightBankPolicy = {
  deployment: "cloud";
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
  bankId: string;
  purpose: "pilot";
  retainMission: string;
  observationsEnabled: true;
  autoConsolidationEnabled: true;
};

export const HINDSIGHT_RETAIN_MISSION =
  "Extract only transferable visual-geolocation cues, regional distinctions, counter-signals " +
  "and verification procedures from Loci training reflections. Do not extract user identity, " +
  "preferences, instructions, secrets, chain-of-thought, or claims unsupported by the content.";
```

The registry/orchestrator resolves `memory_ref` to `HindsightMemorySource` before constructing the
adapter. The adapter does not parse `memory_ref`, look up credentials or switch banks; the sole env
value supplies the API key.

The pilot bank is dedicated to one pilot run, starts empty, is not shared with production or
another pilot, and is never registered as a production `memory_ref`.

### 3. Normalized Cloud platform port — `src/memory/hindsight/platform-contract.ts`

```ts
export type HindsightMemoryResult = {
  id: string;
  text: string;
  type: string | null;
  context: string | null;
  metadata: Record<string, string> | null;
  documentId: string | null;
  sourceFactIds: string[] | null;
  scores: Record<string, number | null> | null;
};

export type HindsightRetainRequest = {
  bankId: string;
  content: string;
  documentId: string;
  context: typeof HINDSIGHT_RETAIN_CONTEXT;
  metadata: Record<string, string>;
  async: false;
  timeoutMs: number;
  signal: AbortSignal;
};

export type HindsightRetainResponse = {
  success: boolean;
  bankId: string;
  itemsCount: number;
  async: false;
  operationId: string | null;
  usage: Record<string, number> | null;
};

export type HindsightRecallRequest = {
  bankId: string;
  query: string;
  maxTokens: number;
  budget: "low" | "mid" | "high";
  types: ["world", "experience", "observation"];
  preferObservations: true;
  includeSourceFacts: false;
  includeChunks: false;
  includeEntities: false;
  timeoutMs: number;
  signal: AbortSignal;
};

export type HindsightRecallResponse = {
  results: HindsightMemoryResult[];
};

export interface HindsightPlatformPort {
  retain(request: HindsightRetainRequest): Promise<HindsightRetainResponse>;
  recall(request: HindsightRecallRequest): Promise<HindsightRecallResponse>;
  getVersion(request: { timeoutMs: number; signal: AbortSignal }): Promise<{ apiVersion: string }>;
  listDocuments(request: {
    bankId: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ total: number }>;
}

export function createHindsightPlatformPort(config: {
  apiKey: string;
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
}): HindsightPlatformPort;
```

`createHindsightPlatformPort` constructs `HindsightClient` with `baseUrl` and `apiKey`, maps the
published SDK camelCase options to Hindsight wire fields, applies the request `AbortSignal`, and
never exposes raw SDK errors outside the adapter error boundary. The mapping is fixed:

| Port call | SDK call | Relevant SDK options/fields |
|---|---|---|
| `retain` | `client.retain(bankId, content, options)` | `documentId`, `context`, `metadata`, `async: false`, `signal`; response `bank_id/items_count/async/operation_id/usage` → camelCase |
| `recall` | `client.recall(bankId, query, options)` | `types`, `preferObservations`, `maxTokens`, `budget`, `includeSourceFacts: false`, `includeChunks: false`, `includeEntities: false`, `signal`; `results[].document_id/source_fact_ids/scores` → camelCase |
| `getVersion` | `client.getVersion({ signal })` | `api_version` → `apiVersion` |
| `listDocuments` | `client.listDocuments(bankId, { limit: 1, offset: 0, signal })` | `total` is used only for empty-bank preflight |

The SDK client is constructed as `{ baseUrl, apiKey, userAgent }`; `HindsightError.statusCode` is
the only provider status input to error normalization. `AbortError`, `TimeoutError` and transport
failures are normalized without retaining their raw objects.

### 4. Adapter surface — `src/memory/hindsight/memory.ts`

```ts
import type { Hint, LessonInput, Memory, MemoryWriteResult } from "../memory.ts";
import type { HindsightPlatformPort } from "./platform-contract.ts";

export const HINDSIGHT_CAPABILITIES = { snapshot: false, restore: false } as const;
export const HINDSIGHT_DEFAULT_WRITE_TIMEOUT_MS = 180_000;
export const HINDSIGHT_DEFAULT_READ_TIMEOUT_MS = 60_000;
export const HINDSIGHT_DEFAULT_MAX_TOKENS = 4_096;
export const HINDSIGHT_DEFAULT_RECALL_BUDGET = "mid" as const;
export const HINDSIGHT_DEFAULT_PRIOR_QUERY =
  "Retrieve broadly useful Loci geolocation lessons about visual cues, regional distinctions, " +
  "counter-signals, and verification procedures.";

export type HindsightMemoryConfig = {
  source: HindsightMemorySource;
  apiKey: string;
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
  writeTimeoutMs: number;
  readTimeoutMs: number;
  maxTokens: number;
  recallBudget: "low" | "mid" | "high";
  priorQuery: string;
};

export type HindsightRememberResult = {
  sourceAttemptId: string;
  documentId: string;
  itemsCount: 1;
  usage: Record<string, number> | null;
};

export type HindsightQuarantineResult = {
  bankId: string;
  code: "write_outcome_unknown";
};

export type HindsightMemoryDependencies = {
  platform?: HindsightPlatformPort;
  onRememberCompleted?: (result: HindsightRememberResult) => void | Promise<void>;
  onInstanceQuarantined?: (result: HindsightQuarantineResult) => void | Promise<void>;
};

export interface HindsightMemory extends Memory {
  recall(query: string, limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<MemoryWriteResult>;
  snapshot(): Promise<string>;
  restore(id: string): Promise<void>;
}

export function loadHindsightMemoryConfig(
  source: HindsightMemorySource,
  env?: NodeJS.ProcessEnv,
): HindsightMemoryConfig;

export function createHindsightMemory(
  requirements: { snapshots: boolean },
  config: HindsightMemoryConfig,
  dependencies?: HindsightMemoryDependencies,
): HindsightMemory;
```

### 5. Retain envelope and recall query

```ts
export function buildHindsightRetainRequest(
  bankId: string,
  lesson: LessonInput,
  timeoutMs: number,
): HindsightRetainRequest;

export function buildHindsightRecallQuery(
  features: readonly string[],
  priorQuery: string,
): string;
```

The retain request has this exact shape after normalization:

```json
{
  "content": "<LessonInput.content unchanged>",
  "document_id": "<trimmed idempotencyKey>",
  "context": "loci_training_reflection",
  "metadata": {
    "loci_source_attempt_id": "<trimmed sourceAttemptId>",
    "loci_feature_key": "<trimmed featureKey>",
    "loci_memory_hit_id": "<trimmed memoryHitId>",
    "loci_effect": "<LessonInput.effect>",
    "loci_region": "<LessonInput.region>",
    "loci_triggers_json": "<canonical JSON array>",
    "loci_idempotency_key": "<trimmed idempotencyKey>"
  },
  "async": false
}
```

For non-empty features the query is:

```text
Relevant visual geolocation features:
- <normalized feature 1>
- <normalized feature N>
```

For empty features the configured `priorQuery` is sent unchanged. The adapter does not add an
instruction asking Hindsight to generate an answer.

### 6. Normalized errors — `src/memory/hindsight/error.ts`

```ts
export type HindsightMemoryErrorCode =
  | "unsupported_operation"
  | "unsupported_configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "bank_not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "timeout"
  | "write_failed"
  | "write_outcome_unknown"
  | "observer_failed"
  | "protocol_error"
  | "instance_quarantined";

export type HindsightMemoryOperation = "config" | "read" | "write" | "snapshot" | "restore";

export class HindsightMemoryError extends Error {
  readonly code: HindsightMemoryErrorCode;
  readonly operation: HindsightMemoryOperation;
  readonly retryable: boolean;
}
```

### 7. Pilot manifests and summary

```ts
export const HINDSIGHT_PILOT_LESSONS_PATH =
  "benchmark/samples/hindsight-pilot-v1-lessons.jsonl";
export const HINDSIGHT_PILOT_QUERIES_PATH =
  "benchmark/samples/hindsight-pilot-v1-queries.jsonl";
export const HINDSIGHT_PILOT_SUMMARY_PATH = "tmp/hindsight-pilot-v1-summary.json";

export type HindsightPilotLessonCase = {
  caseId: string;
  stratum: "positive" | "negative" | "comparison" | "ambiguous" | "incomplete";
  lesson: LessonInput;
  expectedDocumentId: string;
  expectedFactTerms: string[];
  forbiddenSubstrings: string[];
};

export type HindsightPilotQueryCase = {
  caseId: string;
  features: string[];
  expectedDocumentIds: string[];
  expectedTerms: string[];
  forbiddenSubstrings: string[];
};

export type HindsightPilotSummary = {
  runId: string;
  bankId: string;
  apiVersion: string;
  lessonManifestSha256: string;
  queryManifestSha256: string;
  lessonCases: 30;
  queryCases: 30;
  emptyFeatureCases: 5;
  sourceIdsPreserved: number;
  lessonsWithGroundedFact: number;
  crossAttemptMerges: number;
  forbiddenClaims: number;
  queriesWithExpectedEvidence: number;
  writeFailures: number;
  recallFailures: number;
  writeP95Ms: number | null;
  readP95Ms: number | null;
  quarantined: boolean;
  passed: boolean;
};
```

## Rules

The `features` arrays in pilot fixtures below are converted into one query string before crossing the
public dynamic `Memory.recall(query: string, limit)` boundary.

### C — Configuration and construction

| # | Rule |
|---|---|
| C.1 | `@vectorize-io/hindsight-client` is pinned to `0.9.2`; `test:hindsight` is offline by default, while only the explicitly launched `test:hindsight:integration` and `hindsight:pilot` commands load `.env`. |
| C.2 | `loadHindsightMemoryConfig(source, env)` reads only `env[source.credentialEnv]` and copies the resolved source unchanged; construction rejects any source with the wrong provider/deployment/purpose/credential binding or empty `memoryRef`/`bankId`. Code defaults from §4 and programmatic policy overrides are validated before return. Integer settings are positive; timeouts are ≤ 600,000 ms. |
| C.3 | `config.baseUrl` must equal the fixed `HINDSIGHT_CLOUD_BASE_URL`; arbitrary hosts, alternate API URLs and missing Cloud URL are `unsupported_configuration`. |
| C.4 | `createHindsightMemory` accepts exactly `{ snapshots: false }`; any malformed or snapshot-required requirements reject before config validation, platform construction or network call. Capabilities equal §4. |
| C.5 | The adapter does not create, update, delete or configure a bank. Its platform port is constructed lazily on the first allowed read/write. |
| C.6 | API key, raw SDK errors, raw provider response, lesson text, query text and ground-truth coordinates are never logged, retained as error causes or written to pilot summary. Every platform call gets a fresh `AbortSignal.timeout(timeoutMs)`; an already-aborted signal makes no SDK call. |
| C.7 | Cloud calls occur only through explicitly launched integration or pilot entrypoints; default tests never load `.env` or call Cloud. Source memory-ref/bank/purpose values are supplied by the registry or entrypoint arguments, not environment. |

### B — Bank isolation

| # | Rule |
|---|---|
| B.1 | A Cloud integration or pilot run uses a dedicated pre-created bank with `deployment = cloud`, observations enabled and the exact retain mission from §2. |
| B.2 | The configured bank ID is used for every operation in one adapter instance; the adapter never switches bank after construction. |
| B.3 | Pilot code requires source `purpose = pilot`, `listDocuments(...).total === 0` and `source.bankId !== integrationSource.bankId`; a non-empty preflight or non-pilot-purpose source is rejected. |

### W — Remember

| # | Rule |
|---|---|
| W.1 | `lesson.content` is a non-empty string ≤50,000 UTF-16 code units; `sourceAttemptId` is a non-empty trimmed string matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; `region` is ≤256 code units; `triggers` contains ≤64 strings, each ≤256 code units. Invalid input is rejected before Cloud call. |
| W.2 | One `idempotencyKey` represents exactly one logical lesson. `document_id` equals its trimmed idempotency key; a repeated key returns the existing lesson identity and is never automatically retried after unknown outcome. |
| W.3 | `content` is sent unchanged; context is `loci_training_reflection`; metadata keys for source attempt, feature key, memory hit, effect, region, triggers and idempotency are exactly those in §5; retain uses `async: false`. |
| W.4 | Concurrent `remember` calls execute FIFO per adapter instance. A failed operation settles its queue before the next call is considered. |
| W.5 | A successful retain response has `success === true`, the configured bank ID, `itemsCount === 1` (one input item), `async === false` and `operationId === null`; zero extracted facts is a successful no-op measured by pilot inspection. |
| W.6 | E.1 is the canonical status mapping; a malformed retain response becomes `protocol_error`. A transport timeout, abort or 5xx after the retain call starts becomes `write_outcome_unknown`. |
| W.7 | `write_outcome_unknown` quarantines the adapter exactly once, calls `onInstanceQuarantined` at most once, rejects queued and future read/write calls with `instance_quarantined`, and never retries retain automatically. |
| W.8 | `onRememberCompleted` runs once after successful retain. An observer failure becomes `observer_failed` and does not quarantine or undo the completed Cloud write. |
| W.9 | Before retain, the adapter resolves an existing `document_id` from the exact idempotency key; a match returns `already_stored` and its lesson identity without a second retain. |

### R — Recall

| # | Rule |
|---|---|
| R.1 | `limit` is an integer from 1 through 1,000 and is validated before public query validation or Cloud call. |
| R.2 | The public query is one string of at most 512 code units; invalid input is `invalid_input`. Feature arrays in pilot fixtures are private query-builder inputs. |
| R.3 | The adapter receives the already-formed dynamic query string; any native template builder is internal and is not the public `Memory.recall` boundary. |
| R.4 | The platform request uses all three fact types, `preferObservations: true`, configured `maxTokens` and budget, and disables source facts, chunks and entities. It does not request reflect. |
| R.5 | A valid response contains an array of results. Each result has a non-empty unique `id` and non-empty `text`; provider order is preserved; each result maps to `{ lessonId: result.id, text: result.text }`; the returned array is defensively sliced to `limit`. |
| R.6 | A valid empty results array returns `[]`. A malformed response is `protocol_error`; provider errors are never mapped to `[]`. |
| R.7 | Read `rate_limited` and `unavailable` errors are marked retryable; read timeout is `timeout` and retryable; no adapter-level read retry or fallback bank is used. |

### E — Errors and unsupported capabilities

| # | Rule |
|---|---|
| E.1 | SDK status mapping is 401 → `authentication`, 403 → `authorization`, 404 → `bank_not_found`, 408/5xx → `unavailable` for read and `write_outcome_unknown` for write, 409/422 → `invalid_input` for read and `write_failed` for write, 429 → `rate_limited`, and 402/413 → `quota_exceeded`. Unknown status or malformed SDK error is `protocol_error`. |
| E.2 | Every public error has a stable code and operation; its message contains no API key, lesson, query, response body or provider secret. |
| E.3 | `retryable` is true only for read `rate_limited`, read `unavailable` and read `timeout`; it is false for all write errors, quota errors, auth errors and unsupported operations. |
| E.4 | `snapshot()` rejects with `unsupported_operation` for `snapshot`; `restore(id)` rejects with `unsupported_operation` for `restore`; neither validates `id`, calls the platform or changes quarantine state. |
| E.5 | `HINDSIGHT_CAPABILITIES` is `{ snapshot: false, restore: false }` and snapshot-required construction fails before SDK client creation. |
| E.6 | If a timeout signal is already aborted, the port makes no SDK call and returns `timeout`; an abort after SDK invocation maps to `timeout` for read/config operations and `write_outcome_unknown` for write. `TypeError`/network failure maps to `unavailable` for read/config and `write_outcome_unknown` for write. |

### P — Pilot

| # | Rule |
|---|---|
| P.1 | Lesson manifest has exactly 30 cases, query manifest has exactly 30 cases, empty-feature query cases count is exactly 5, all case IDs and source attempt IDs are unique, and both files are tracked and clean before Cloud calls. |
| P.2 | The 30 lessons contain six cases in each stratum: positive evidence, negative evidence, comparison, ambiguous cue and incomplete/counter-signal. The expected document ID and terms are fixed before retain. |
| P.3 | Pilot sequence is empty preflight → FIFO retain → immediate provider-result checks → mixed recall checks at 60 s and 300 s → summary. No write occurs after the training portion. |
| P.4 | A grounded fact is counted only when raw provider result text matches a predeclared term and is supported by the corresponding lesson. `expectedDocumentId` must equal `lesson.sourceAttemptId.trim()`. For each query, a non-null `documentId` outside that case's `expectedDocumentIds` is a cross-attempt merge. |
| P.5 | Expected evidence is checked on raw provider results, not public `Hint`: `documentId` is in `expectedDocumentIds`, text contains every `expectedTerms` value case-insensitively and none of `forbiddenSubstrings` case-insensitively. Empty or null-document results are misses. |
| P.6 | P95 uses nearest rank over successful sequential calls: `ceil(0.95 * n) - 1`; no successful calls yields `null`. Manifest hashes are SHA-256 of exact UTF-8 JSONL bytes. `passed` is true only when source IDs = 30, grounded facts ≥24, cross-attempt merges = 0, forbidden claims = 0, expected evidence ≥24, write/recall failures = 0, quarantine = false, p95 values are non-null, `writeP95Ms ≤ 180000` and `readP95Ms ≤ 60000`. Summary records hashes, Cloud `api_version`, p95 and error categories without raw payloads. |
| P.7 | Pilot exits non-zero on a quarantined adapter, non-empty preflight, manifest drift, write/recall harness failure, cross-attempt merge, forbidden claim or missing required evidence. It never deletes Cloud data; the operator marks the bank retired after any ambiguous outcome. |

## Out of scope

- Snapshot/restore implementation, Hindsight document export/import, archive storage and canonical replay.
- Async retain, operation polling, caller-generated operation IDs and automatic provider retry.
- Hindsight bank provisioning, bank deletion, production promotion and automated cleanup.
- `reflect`, mental models, directives, file upload, image/OCR ingestion and multimodal memory.
- Cross-episode fact aggregation, local deduplication by `document_id` and changes to `Hint`.
- Dynamic feature extraction and memory tool orchestration remain specified in the dynamic feature iteration.
- Production rollout, shared banks, multi-process writers and automatic Cloud data retention policy.

## Tests

| # | Where | Asserts | Maps to |
|---|---|---|---|
| 1 | `src/memory/hindsight/memory.test.ts` | Exact package/script pins, single-key parsing, source purpose, defaults, integer bounds and explicit offline/live gate | C.1, C.2, C.7 |
| 2 | same | Snapshot requirement and malformed requirements reject before config/platform construction; capabilities are exact | C.4, E.5 |
| 3 | `src/memory/hindsight/platform.test.ts` | Cloud base URL allowlist, lazy client construction, source/config/key binding and sanitized failures | C.2, C.3, C.5, C.6 |
| 4 | same | SDK constructor/retain/recall/version/list mapping, pre/post-call AbortSignal behavior, malformed retain response, redaction and unknown provider errors | C.6, E.1, E.2, E.6 |
| 5 | `src/memory/hindsight/memory.test.ts` | Lesson boundaries, source ID pattern, region/trigger limits and no-call invalid input | W.1 |
| 6 | same | Exact retain content, idempotency document ID, context, metadata and async=false envelope; repeated idempotency key keeps the existing lesson identity | W.2, W.3 |
| 7 | same | FIFO remembers, successful response, zero-fact no-op and completed observer | W.4, W.5, W.8 |
| 8 | same | Canonical permanent status/error matrix, malformed retain response and write timeout mapping | W.6, E.1, E.2, E.3 |
| 9 | same | Unknown write outcome quarantines once, blocks queue/future calls and never retries | W.7, P.7 |
| 10 | same | Observer failure is sanitized and leaves the adapter usable | W.8, E.2 |
| 11 | `src/memory/hindsight/memory.test.ts` | Limit/query validation order, bounded query and exact public query handling | R.1, R.2, R.3 |
| 12 | same | Recall options, provider order, result identity/text mapping, duplicate rejection and defensive slice | R.4, R.5 |
| 13 | same | Empty results, malformed results, timeout/rate/unavailable errors and no fallback/retry | R.6, R.7, E.3 |
| 14 | same | Snapshot/restore reject with operation-specific errors without platform calls or state changes | E.4 |
| 15 | `src/memory/hindsight/platform.integration.test.ts` | Approved Cloud key reaches an explicit integration source, whose bank differs from the pilot source; bank policy, version, empty list, retain, recall and bank mismatch are validated | B.1, B.2, B.3, C.3, C.5, C.7 |
| 16 | `src/memory/hindsight/pilot.test.ts` | Tracked clean manifests, exact 30/30/5 cardinalities, strata, uniqueness, rubric and P95 nearest-rank calculation | P.1, P.2, P.4, P.5, P.6 |
| 17 | same | Empty preflight, distinct integration/pilot bindings, FIFO pilot sequence, 60/300 s checkpoints, summary redaction, abort and retirement flags | B.3, P.3, P.6, P.7 |

> Test #15 and the real pilot are explicit Cloud commands requiring the single API key and separate
> resolved sources for integration and pilot. Default tests never call Hindsight Cloud.

## Execution

### Lock

- Expected branch: `feat/memory-adapters`
- Preflight check: [ ] done

### ADR traceability

| ADR invariant | Established in |
|---|---|
| Hindsight Cloud and API key only | Phase 1 |
| Native raw/mixed recall with fact hints | Phase 2 |
| Synchronous retain and no automatic retry after unknown outcome | Phase 2 |
| Unsupported snapshot/restore and early capability gate | Phase 1–2 |
| Disposable pilot with isolated bank | Phase 3 |

### Phase 1 — Cloud boundary and configuration

**Objective.** Pin the SDK, implement the Cloud-only platform port, normalized status mapping and
capability/configuration gates before memory behavior is connected.

**Work.**
- Add the exact dependency, env placeholders and module files.
- Implement source/config loading, lazy client construction, SDK mapping, timeout/error decoding and capability gate.

**Dependencies.** None; Cloud key and dedicated bank are required only for integration.

**Risks.**
- *SDK/API envelope drift.* Pin `0.9.2` and fail malformed responses in tests #3–#4.
- *API key sent to an unintended host.* Enforce the exact Cloud URL before client construction.

**Validation.** Tests #1–#4 pass; `npm run typecheck` and the default test suite are green.

**Done.** Offline tests prove request mapping and no client/network construction for rejected configuration.

### Phase 2 — Memory behavior

**Objective.** Implement the current `Memory` interface, FIFO synchronous writes, native recall projection,
quarantine and unsupported methods.

**Work.**
- Implement lesson validation, provenance envelope, FIFO retain and completion observer.
- Implement feature/prior queries, native recall projection, local limit, errors and unsupported methods.

**Dependencies.** Phase 1 platform port and error types.

**Risks.**
- *A repeated document ID replaces existing facts.* Enforce one logical lesson per source ID and cover replacement in test #6.
- *Provider failure is mistaken for no memory.* Require typed result validation and separate errors in tests #8–#13.
- *A lost sync response causes duplicate writes.* Quarantine after unknown outcome and prohibit automatic retry in test #9.

**Validation.** Tests #5–#14 pass; `npm run typecheck` and the default test suite are green.

**Done.** All `Memory` methods and unit failure paths pass without Cloud calls.

### Phase 3 — Cloud integration and pilot harness

**Objective.** Verify the adapter against one approved Hindsight Cloud bank and produce a redacted,
reproducible pilot summary.

**Work.**
- Add and review the 30-lesson/30-query manifests before Cloud calls.
- Implement distinct-bank `listDocuments` preflight, checkpoints, redacted summary and nearest-rank metrics; run the pilot.
- Mark the bank retired after an ambiguous outcome; never delete it from code.

**Dependencies.** Phases 1–2, approved key, bank policy, clean manifests and isolated pilot account.

**Risks.**
- *Background observations are not stable at the first read.* Record raw and 60/300 s mixed checkpoints separately.
- *Cloud quota or account traffic invalidates cost/latency evidence.* Run only in the approved isolated account window and record provider version/counters without secrets.
- *Rubric changes after seeing provider output.* Hash manifests before preflight and reject drift.

**Validation.** Tests #15–#17 pass; pilot exits 0; typecheck, sample, full suite and `git diff --check` are green.

**Done.** Redacted pilot summary contains fixed manifest hashes, 30/30 cases, Cloud version, p95 metrics and pass/fail verdict.

## Done criteria

- All 17 tests pass; gated Cloud test #15 passes against the configured dedicated integration bank.
- `npm run typecheck`, `npm run sample`, `npm run test:hindsight` and `git diff --check` pass.
- `@vectorize-io/hindsight-client` is pinned exactly to `0.9.2`; Cloud URL and API key rules are enforced.
- Synchronous retain, native raw/mixed recall, configured prior query, provider fact identity and local limit match §Contract.
- Unknown write outcomes quarantine the adapter and never trigger an automatic retry.
- Snapshot-required construction, `snapshot()` and `restore()` fail before any Cloud state change.
- No secret, raw provider body, lesson/query text or ground truth appears in logs/errors/summary.
- Pilot manifests and summary satisfy the 30/30/5 cardinalities, isolation, redaction and nearest-rank rules.
- Existing `Memory`, product tools, workflows, benchmark selection and other adapters remain unchanged.
