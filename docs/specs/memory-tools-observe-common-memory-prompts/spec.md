---
type: Specification
title: "Common memory prompts для всех adapters"
description: Overlay-контракт, который заменяет adapter-specific memory instructions едиными application-owned retrieve/store prompts.
timestamp: 2026-09-01T00:00:00+03:00
date: 2026-09-01
model: gpt-5
version: 2
tags: [loci, memory, prompts, adapters, specification]
---

# Spec: Common memory prompts для всех adapters

Эта спецификация является overlay для [dynamic features без geo-policy](/specs/memory-tools-observe-dynamic-features-no-geo-filter/spec.md).
Все контракты dynamic observe, locate, reflection, training и evaluation из базовой spec остаются
нормативными, кроме prompt ownership, memory adapter boundaries и no-hit reflection, переопределённых
ниже.

## Goal

Обеспечить одинаковый application-owned prompt context для memory retrieve и store во всех adapters.
Provider-specific API mapping разрешён, но provider-specific instruction content и отдельные prompt
assets запрещены.

## Contract

### 1. Shared prompt assets — `src/promts/`

```text
src/promts/agent.md
src/promts/observe.md
src/promts/retrieve.md
src/promts/analyze.md
src/promts/reflect.md
src/promts/memory-retrieve.md
src/promts/memory-store.md
```

```ts
export type PromptName =
  | "agent"
  | "observe"
  | "retrieve"
  | "analyze"
  | "reflect"
  | "memory-retrieve"
  | "memory-store";

export const PROMPT_FILES: Record<PromptName, string> = /* one source of truth */ {};
export const PROMPT_VERSIONS: Record<PromptName, string> = /* explicit trace/cache versions */ {};
export function loadPrompt(name: PromptName): string;
```

`memory-retrieve.md` и `memory-store.md` — единственные static instruction assets для memory
operations. `src/promts/mem0-extraction.md`, `src/promts/hindsight-retain.md` и любые другие
adapter-named prompt files MUST NOT exist.

### 2. Memory prompt context — `src/memory/memory.ts`

```ts
export type MemoryOperation = "retrieve" | "store";

export type MemoryPrompt = {
  operation: MemoryOperation;
  text: string;
  version: string;
  digest: string;
};

export function sharedMemoryPrompt(operation: MemoryOperation): MemoryPrompt;

export type MemoryBindingRequest = {
  memoryRef: string;
  operation: MemoryOperation;
  prompt: MemoryPrompt;
  featureKey: string;
  query?: string;
  lesson?: LessonInput;
};
```

The application creates `prompt` from the shared asset. Every configured adapter receives the same
`text`, `version` and `digest` for the same operation. Adapter code may map the fields to native API
names, but it MUST NOT append, replace or branch on provider identity to choose instruction content.

### 3. Adapter mapping

```ts
export type MemoryAdapterPromptPort = {
  retrieve(input: MemoryBindingRequest): Promise<Hint[]>;
  store(input: MemoryBindingRequest): Promise<MemoryWriteResult>;
};
```

Mem0 maps `operation:"store"` to its native instruction field; Hindsight maps the same common text
to its retain instruction field. XMemory and FileMemory preserve the prompt metadata in the binding
trace even if their native operation has no instruction field. No adapter exports a prompt constant.

### 4. Existing dynamic flow

The base spec remains normative for dynamic feature parsing, feature-scoped retrieval, no-memory mode,
binding resolution, failure mapping, episode ledger, reflection, provenance, idempotency and benchmark
controls. In particular, `memoryRef:null` remains a no-op and does not receive a memory prompt or make
a provider call.

## Rules

### Prompt ownership

| ID | Rule |
| --- | --- |
| P1 | All static instructions used by the agent and memory operations are loaded from `src/promts/*.md`. |
| P2 | `memory-retrieve.md` is the only static instruction for every memory retrieve binding. |
| P3 | `memory-store.md` is the only static instruction for every memory store binding. |
| P4 | Adapter identity never selects or changes memory prompt content. |
| P5 | Adapter-specific prompt files and inline instruction constants are forbidden. |
| P6 | Prompt text, version and digest are identical across adapters for the same operation. |
| P7 | `memoryRef:null` performs no provider call and does not require a memory prompt. |

### Adapter boundary

| ID | Rule |
| --- | --- |
| A1 | Native API field names may differ, but their values derive directly from the shared prompt text. |
| A2 | Provider-specific errors, ranking and transport remain adapter concerns and do not alter prompt selection. |
| A3 | Binding trace records operation, memoryRef, prompt version and prompt digest when a provider call occurs. |

## Out of scope

- Provider-specific prompt optimization or hidden instruction suffixes.
- Changes to dynamic feature selection, geo content validation, memory ranking or geocoding.
- Treating runtime query/lesson/feature JSON as separate static prompt assets.

## Tests

| # | Where | Asserts | Maps to |
| --- | --- | --- | --- |
| 1 | `src/prompts.test.ts` | Exactly seven shared assets exist, are non-empty and have unique paths. | P1, P2, P3, P5 |
| 2 | `src/prompts.test.ts` | Adapter-named prompt assets and adapter-specific prompt constants are absent. | P5 |
| 3 | `src/tools/memory.test.ts` | Retrieve/store shared prompt text, version and digest are stable. | P2, P3, P6 |
| 4 | adapter unit tests | Mem0, Hindsight, xmemory and FileMemory receive identical operation prompt metadata. | P4, P6, A1, A3 |
| 5 | `src/locate-runtime.internal.test.ts` | `memoryRef:null` makes no provider call and creates no memory prompt request. | P7 |
| 6 | `src/memory/mem0/memory.test.ts` | Mem0 uses shared store prompt and has no extraction instruction constant. | P2, P5 |
| 7 | `src/memory/hindsight/platform.integration.test.ts` | Hindsight uses shared store prompt and has no retain mission constant. | P3, P5 |
| 8 | `src/memory/xmemory/memory.test.ts`, `src/memory/file/memory.test.ts` | Non-LLM adapters preserve common prompt metadata without introducing local prompt content. | P6, A2, A3 |

## Execution

### Lock

- Branch: `feat/feature-scoped-memory-tools`
- This overlay spec is read-only during implementation.

### Phase 1 — Shared prompt boundary

**Objective.** Replace adapter-specific instruction assets/constants with common retrieve/store prompts.

**Work.** Keep seven shared assets; remove `mem0-extraction` and `hindsight-retain`; make loader the
single source of truth; add shared prompt metadata and digest; update tool/provider bindings and tests.

**Dependencies.** Base Phase 1 prompt loader and dynamic contracts.

**Risks.** Native APIs use different field names; map the same text at the boundary and test equality.

**Validation.** Tests 1–8; typecheck; adapter suites; full suite green.

**Done.** Every adapter receives the same retrieve/store prompt digest and no adapter owns prompt content.

### Phase 2 — End-to-end dynamic runtime

**Objective.** Continue the remaining base-spec phases with shared prompt context intact.

**Work.** Finish dynamic memory bindings, locate/no-memory, ledger, reflection, training/evaluation and benchmark controls.

**Dependencies.** Phase 1.

**Risks.** Existing partial diff may mix phase boundaries; preserve one shared prompt source while completing runtime behavior.

**Validation.** Base spec tests 1–30 plus this overlay tests 1–8; typecheck; full suite green.

**Done.** Dynamic flow and adapter parity pass together.

## Done criteria

- Exactly seven shared prompt assets exist under `src/promts/`; no adapter-specific prompt asset exists.
- No adapter-specific static instruction constant remains in production source.
- All adapters use identical shared retrieve/store prompt text, version and digest.
- Native API mappings do not change the shared instruction content.
- `memoryRef:null` remains provider/prompt-free.
- A connected-memory `no_hit` feature receives one reflection with `memoryHit: null`; nullable
  provenance remains consistent across all adapters.
- Base dynamic feature, memory, locate, reflection, training and evaluation criteria remain green.
