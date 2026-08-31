---
type: Specification
title: "Mem0 Cloud adapter v1"
description: Контракт Mem0 Cloud-адаптера для remember и ranked recall без поддержки snapshot и restore.
timestamp: 2026-08-28T00:00:00+03:00
date: 2026-08-28
model: gpt-5
version: 1
tags: [loci, memory, mem0, cloud, typescript, specification]
---

# Spec: Mem0 Cloud adapter v1

Operationalizes [the accepted ADR](adr.md). Produces a `Memory` implementation, normalized Mem0
Platform port, typed errors and a gated 30-case Cloud pilot.

## Goal

Implement `remember` and ranked `recall` in one configured Mem0 `agentId`. Reject snapshot
operations, preserve Cloud failures as errors and validate extraction/retrieval quality without
wiring the adapter into the snapshot-dependent benchmark workflow.

## Glossary

- **deadline** — one 120-second budget covering add, event polling and fact visibility.
- **outcome unknown** — add may have been accepted, but its terminal result cannot be proven.
- **instance quarantine** — one adapter object rejects further reads/writes after an ambiguous ingestion.
- **retired scope** — a one-use pilot `agentId` that must never be selected again.

## Contract

### 1. Adapter surface — `src/mem0-memory.ts`

```ts
import type { Hint, LessonInput, Memory } from "./memory.ts";
import type { Mem0PlatformPort } from "./mem0-platform.ts";

export const MEM0_CAPABILITIES = { snapshot: false, restore: false } as const;

export type Mem0MemoryConfig = {
  apiKey: string;
  agentId: string;
  ingestionTimeoutMs: number; // default 120_000
  pollIntervalMs: number;     // default 1_000
};

export type Mem0RememberResult = {
  sourceAttemptId: string;
  memoryIds: string[];
};

export type Mem0MemoryDependencies = {
  platform?: Mem0PlatformPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRememberCompleted?: (result: Mem0RememberResult) => void;
};

export function loadMem0MemoryConfig(env?: NodeJS.ProcessEnv): Mem0MemoryConfig;

export function createMem0Memory(
  requirements: { snapshots: boolean },
  config: Mem0MemoryConfig,
  dependencies?: Mem0MemoryDependencies,
): Mem0Memory;

export class Mem0Memory implements Memory {
  recall(features: string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<void>;
  snapshot(): Promise<string>;
  restore(id: string): Promise<void>;
}
```

### 2. Error surface — `src/mem0-memory.ts`

```ts
export type Mem0MemoryErrorCode =
  | "unsupported_operation"
  | "unsupported_configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "ingestion_failed"
  | "ingestion_outcome_unknown"
  | "observer_failed"
  | "protocol_error"
  | "instance_quarantined";

export class Mem0MemoryError extends Error {
  readonly code: Mem0MemoryErrorCode;
  readonly eventId?: string;
  readonly retryable: boolean;
}
```

Raw SDK/fetch errors are normalized and discarded before this error is constructed. The public
error never retains an unsanitized `cause`, response body, request body or headers.

### 3. Platform port — `src/mem0-platform.ts`

```ts
export const MEM0_PLATFORM_BASE_URL = "https://api.mem0.ai";

export type Mem0EventStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type Mem0Record = {
  id: string;
  memory: string;
  score?: number;
  metadata: Record<string, unknown>;
};

export type Mem0AddRequest = {
  messages: Array<{ role: "assistant"; content: string }>;
  agentId: string;
  infer: true;
  temporalReasoning: false;
  agentCustomInstructions: string;
  metadata: {
    loci_source_attempt_id: string;
    loci_triggers: string[];
    loci_region: string;
  };
};

export type Mem0SearchRequest = {
  query: string;
  filters: { agent_id: string };
  topK: number; // exactly recall(limit)
  threshold: 0.1;
  rerank: false;
  keywordSearch: true;
};

export interface Mem0PlatformPort {
  add(request: Mem0AddRequest): Promise<{ eventId: string; status: "PENDING" }>;
  getEvent(eventId: string): Promise<{
    eventId: string;
    status: Mem0EventStatus;
    memoryIds?: string[]; // required and explicit for SUCCEEDED
    error?: string;
  }>;
  get(memoryId: string): Promise<Mem0Record | null>;
  list(agentId: string): Promise<Mem0Record[]>; // all pages
  search(request: Mem0SearchRequest): Promise<Mem0Record[]>;
}

export function createMem0PlatformPort(config: {
  apiKey: string;
  baseUrl?: typeof MEM0_PLATFORM_BASE_URL;
}): Mem0PlatformPort;
```

The production port uses `MemoryClient` from exact dependency `mem0ai@3.1.7` for add/get/list/search
and authenticated server-side `fetch` for `GET /v1/event/{event_id}/`. Runtime `unknown` JSON is
validated and normalized to this surface.

### 4. Extraction instruction and query

```text
Extract durable, transferable visual geolocation facts from this lesson.
Preserve observable cues, contrasts between regions, uncertainty, and exceptions.
Do not rewrite the lesson as facts about a user.
Do not invent evidence or strengthen a weak cue into a rule.
Each extracted fact must remain understandable on its own.
```

```ts
function buildMem0Query(features: string[]): string {
  return features.map((value) => value.trim()).filter(Boolean).join("\n");
}
```

### 5. Environment and package scripts

Block added to `.env.example`:

```dotenv
# Mem0 Cloud pilot. Use a new, never-reused agent id for each pilot run.
MEM0_API_KEY=
MEM0_AGENT_ID=
MEM0_INGESTION_TIMEOUT_MS=120000
MEM0_POLL_INTERVAL_MS=1000
MEM0_INTEGRATION=0
```

```json
{
  "dependencies": { "mem0ai": "3.1.7" },
  "scripts": {
    "test:mem0": "node --test src/mem0-*.test.ts",
    "mem0:pilot": "node --env-file-if-exists=.env src/mem0-pilot.ts"
  }
}
```

### 6. Pilot manifests and summary

`benchmark/samples/mem0-pilot-v1-lessons.jsonl`:

```ts
type Mem0PilotLessonCase = {
  caseId: string;
  lesson: LessonInput;
  expectedAnyFact: Array<{ allOf: string[] }>;
  forbiddenFactSubstrings: string[];
};
```

A fact is correct when its lowercased text contains every lowercased member of at least one
`expectedAnyFact.allOf`. A fact is distorted when it contains any `forbiddenFactSubstrings` member.

`benchmark/samples/mem0-pilot-v1-queries.jsonl`:

```ts
type Mem0PilotQueryCase = {
  caseId: string;
  features: string[];
  expectedSourceAttemptIds: string[];
};
```

The harness receives created IDs through `onRememberCompleted`, reads their records through the
shared port and evaluates lesson facts. For query cases it calls `recall(features, 5)`, reads each
returned fact by `Hint.lessonId` and compares `metadata.loci_source_attempt_id`.

```ts
type Mem0PilotSummary = {
  lessonCases: number;
  lessonsWithCorrectFact: number;
  extractedFacts: number;
  distortedFacts: number;
  queryCases: number;
  queriesWithExpectedFactInTop5: number;
  writeFailures: number;
  recallFailures: number;
  harnessFailures: number;
  aborted: boolean;
  instanceQuarantined: boolean;
  scopeRetired: boolean;
  passed: boolean;
};
```

After valid manifests and an empty-scope preflight, `scopeRetired` is always true in the final
summary, including success. It records an operator policy; no durable retirement registry is part
of v1. A write failure increments `writeFailures`; search or provenance-refetch failure increments
`recallFailures`; observer/preflight failure increments `harnessFailures`. Write failures abort the
remaining cases; observer failure also aborts. Recall failures continue to the next query.
`instanceQuarantined` is true only for rules W.3–W.9 quarantine paths. Invalid manifests exit 1
before Cloud calls and before summary creation. A failed/non-empty preflight prints an aborted
summary with `harnessFailures: 1`, both quarantine/retirement flags false, and zero processed cases.

## Rules

### C — Configuration and security

| # | Rule |
|---|---|
| C.1 | `mem0ai` is pinned exactly to `3.1.7` in both manifest and lockfile. |
| C.2 | API key and agent ID are required; timeout/interval are positive integers and interval is smaller than timeout. |
| C.3 | One adapter sends only `agentId`; reads use the same agent scope. |
| C.4 | A snapshot requirement fails before production-port construction. `MEM0_CAPABILITIES` equals Contract §1 exactly. |
| C.5 | Secrets, Authorization, lesson/query content, raw errors and event payloads never enter logs or public errors. |
| C.6 | The 120-second deadline starts immediately before `add`; every sleep is capped to its remaining time. |
| C.7 | Real `.env` remains ignored; Cloud integration executes only when `MEM0_INTEGRATION=1`. |

### W — Remember state machine

| # | Rule |
|---|---|
| W.1 | Empty lesson content/source ID fails before a call; empty triggers and region are valid. |
| W.2 | One lesson produces exactly one add request with Contract §3 metadata and Contract §4 instruction. |
| W.3 | Add is called once. Its only accepted success envelope is non-empty event ID plus `PENDING`; every other envelope is protocol error and instance quarantine. |
| W.4 | Matching `PENDING`/`RUNNING` event polls again; `FAILED` throws `ingestion_failed` and quarantines the instance. |
| W.5 | Matching `SUCCEEDED` requires explicit `memoryIds`. `[]` resolves as no-op; non-empty IDs must be unique non-empty strings. |
| W.6 | Every created ID must become visible before resolve; `get() === null`, 404 and unavailable retry inside the deadline, and returned `record.id` must equal requested ID. |
| W.7 | Network/timeout/reset during add is outcome unknown even without event ID. Any post-add deadline exhaustion is also outcome unknown. Both quarantine. |
| W.8 | Rate-limit/unavailable/404 during event/get may retry inside the deadline. Auth/quota/protocol failure after accepted add quarantines immediately. |
| W.9 | Quarantined instance rejects subsequent remember/recall without calls. Quarantine is process-local instance state. |
| W.10 | No outcome-unknown path automatically retries add. Completion observer fires once only after no-op or visibility success; an observer throw becomes non-retryable `observer_failed` without quarantine. |
| W.11 | Concurrent `remember` calls on one instance execute FIFO. Recall may run during ingestion and observes only facts already visible in Cloud. |

### R — Ranked recall

| # | Rule |
|---|---|
| R.1 | Order is quarantine check, limit validation, then feature normalization. |
| R.2 | Limit is an integer 1–1,000; invalid input fails without search. |
| R.3 | Query follows Contract §4; an empty query returns `[]` without search. |
| R.4 | Search uses Contract §3 with `topK === limit`; pilot always uses limit 5. |
| R.5 | Hints map provider ID/text, preserve provider order and are defensively sliced to limit. |
| R.6 | Empty/mismatched ID, empty text or provider failure becomes an error, never successful `[]`. |

### E — Errors and unsupported operations

| # | Rule |
|---|---|
| E.1 | Every failure is a sanitized `Mem0MemoryError`; no raw cause is retained. |
| E.2 | Invalid/config/auth/authorization/quota/ingestion/observer/protocol/quarantine/unsupported errors are non-retryable. |
| E.3 | Rate limit and unavailable are retryable only before add acceptance or during recall; ambiguous ingestion is never auto-retryable. |
| E.4 | Snapshot rejects with `unsupported_operation` message `Mem0Memory does not support snapshot`; restore uses `Mem0Memory does not support restore`. |
| E.5 | Snapshot/restore are rejected Promises, ignore restore ID, make no calls and change no state. |

### P — Pilot

| # | Rule |
|---|---|
| P.1 | Both manifests have exactly 30 unique valid cases and are validated before Cloud calls. |
| P.2 | Pilot calls `list` before writes and aborts unless scope is empty; after empty preflight it reports the agent ID retired on every exit. Future non-reuse is an operator obligation. |
| P.3 | Outcome unknown prints a summary with aborted/quarantined/retired true, exits 1 and stops further cases. |
| P.4 | Pass requires ≥24 correct lesson cases, 0 distorted facts, ≥24 successful top-5 query cases and all three failure counts zero. |
| P.5 | After valid manifests, pilot prints exactly one complete summary and exits 0 only on pass. It is absent from default CI/test commands. |

## Out of scope

- Snapshot/restore implementation or emulation.
- Wiring `train.ts`, `experiment.ts` or product memory tools.
- Add retry after ambiguous outcome; Cloud backup, cleanup, retention, rollback or migration.
- Graph, temporal reasoning, reranking, Dream, webhooks and manual CRUD.
- General capability framework for other backends; changes to `Memory` or feature extraction.

## Tests

| # | Where | Asserts | Maps to |
|---|---|---|---|
| 1 | `src/mem0-memory.test.ts` | Package/lock pin; env defaults/errors; `.env` ignored; integration gate | C.1, C.2, C.7 |
| 2 | same | Snapshot requirement fails before port construction; capabilities exact | C.4 |
| 3 | same | Invalid lesson and exact add payload/metadata/instruction | C.3, W.1, W.2 |
| 4 | same | Deadline starts before add; sleep never exceeds remaining budget | C.6 |
| 5 | same | Add envelope accepts only PENDING/event ID and add is called once | W.3 |
| 6 | same | PENDING/RUNNING transitions; FAILED and mismatched event ID quarantine with no further calls | W.4, W.5 |
| 7 | same | SUCCEEDED requires IDs; handles zero, duplicates, empties and malformed IDs | W.5 |
| 8 | same | Visibility retries null/404/unavailable; post-accept auth/quota/protocol errors quarantine immediately | W.6, W.8 |
| 9 | same | Every unknown/deadline path quarantines with no add retry; concurrent remembers run FIFO | W.7, W.10, W.11 |
| 10 | same | Quarantine precedes input validation and blocks read/write calls; recall during ingestion sees only provider-visible facts | W.9, W.11, R.1 |
| 11 | same | Recall limit/query/search policy/order/malformed results | R.2, R.3, R.4, R.5, R.6 |
| 12 | same | Error codes/retry flags sanitized; snapshot/restore exact rejected Promises/no state change | C.5, E.1, E.2, E.3, E.4, E.5 |
| 13 | same | Observer fires once after success; observer throw maps to non-retryable observer_failed without quarantine | W.10, E.2 |
| 14 | `src/mem0-platform.test.ts` | Unknown SDK/wire envelopes, casing and HTTP errors normalize to Contract §3 | W.3, W.4, W.8, E.1 |
| 15 | `src/mem0-platform.integration.test.ts` | Early Cloud spike proves add→event→visibility, metadata, list and ranked search | C.3, W.4, W.6, R.4 |
| 16 | `src/mem0-pilot.test.ts` | Manifest matching, provenance lookup, all failure counters/flags, pass/fail exit and absence from default scripts | P.1, P.3, P.4, P.5 |
| 17 | same | Non-empty scope aborts before write; every post-preflight exit reports retirement; unknown outcome stops cases | P.2, P.3 |

> Test #15 requires `MEM0_INTEGRATION=1` and Cloud credentials; default test/CI skips it.

## Execution

### Lock

- Expected branch: `feat/mem0-cloud-adapter-v1`
- Preflight check: [ ] done

### ADR traceability

| ADR invariant | Established in |
|---|---|
| Unsupported snapshots | Phase 3 |
| Async ingestion and visibility | Phases 1–2 |
| Unknown outcome quarantine | Phase 2 |
| Cloud-only disposable pilot | Phase 4 |

### Phase 1 — Cloud contract spike

**Objective.** Produce the normalized port and prove its live add/event/get/list/search envelopes.

**Work.**
- Pin dependency; add config loader, env placeholders and test scripts.
- Implement sanitized errors and the normalized Platform port.
- Run the gated integration fixture in a unique, empty agent scope.

**Dependencies.** Valid Mem0 pilot project and API key.

**Risks.** *SDK/runtime schema drift.* Fail closed through runtime validation. *External data/cost.* Use one synthetic approved lesson and a one-use scope.

**Validation.** Tests #1, #12, #14–#15 pass; typecheck and full default suite green.

**Done.** Live Cloud envelopes normalize to Contract §3 or sanitized errors.

### Phase 2 — Remember lifecycle

**Objective.** Complete one add state machine inside one deadline and quarantine every ambiguous path.

**Work.**
- Implement validation, add, polling, visibility and observer.
- Add injected clock/sleep tests for every transition and deadline boundary.
- Block operations after instance quarantine.

**Dependencies.** Phase 1 port and live envelope fixture.

**Risks.** *Late write after timeout.* Retire pilot scope. *Concurrent remember calls.* Serialize remember per instance in v1.

**Validation.** Tests #3–#10 and #13 pass; typecheck and full suite green.

**Done.** Remember resolves only on explicit no-op or visible IDs; all ambiguity quarantines.

### Phase 3 — Recall and unsupported operations

**Objective.** Implement one ranked recall policy and explicit capability rejection.

**Work.**
- Implement query/limit validation and ordered hint mapping.
- Implement requirement check and snapshot/restore rejected Promises.

**Dependencies.** Phases 1–2.

**Risks.** *Filter shape drift.* Pin unit/live fixtures. *Silent malformed result.* Return protocol error.

**Validation.** Tests #2, #11–#12 pass; typecheck and full suite green.

**Done.** Recall and unsupported operations match the contract without hidden fallbacks.

### Phase 4 — Pilot harness

**Objective.** Measure the fixed extraction and retrieval gates on approved one-use Cloud data.

**Work.**
- Commit and review both 30-case manifests.
- Implement deterministic fact-signal matching, provenance lookup and summary output.
- Run the pilot with a fresh empty scope and retain its stdout summary in the handoff.

**Dependencies.** Phases 1–3; reviewed manifests and Cloud credentials.

**Risks.** *Lexical rubric misses semantic paraphrase.* Review signals before execution and freeze them. *Scope reuse changes results.* Enforce empty preflight and retire after run.

**Validation.** Tests #16–#17 pass; pilot exits 0; typecheck, sample check and full suite green.

**Done.** Pilot passes 24/30 extraction, zero forbidden facts and 24/30 top-5 retrieval.

## Done criteria

- All 17 tests pass; gated test #15 passes against Cloud.
- `npm run typecheck`, `npm run sample` and `git diff --check` pass.
- No unsupported operation or ambiguous ingestion mutates state or calls add again.
- Logs contain no secret, lesson/query text, raw provider body or event payload.
- Two frozen 30-case manifests are committed and the one-use-scope pilot exits 0.
- Existing train/experiment, memory implementations and product contracts are unchanged.
