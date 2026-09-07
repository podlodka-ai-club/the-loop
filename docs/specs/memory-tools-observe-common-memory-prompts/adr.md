---
type: Decision
title: "Единые prompts для всех memory adapters"
description: Все memory adapters используют общий application-owned prompt contract для retrieve и store без provider-specific instruction assets.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
tags: [loci, memory, prompts, adapters, decision]
---

# Единые prompts для всех memory adapters

**Status:** Accepted
**Date:** 2026-08-31
**Authors:** Loci
**Related ADRs:** [Dynamic features без geo-фильтрации](/specs/memory-tools-observe-dynamic-features-no-geo-filter/adr.md), [Memory adapters](/specs/memory-tools-observe-reflection/adr.md)

## Context

Memory adapters должны сравниваться на равных условиях. Adapter-specific extraction или retain
instructions дают разным backends разные правила обработки одного и того же lesson и делают результат
зависимым от конкретного provider.

Требуются общий контроль prompt-версий, единый retrieve/store context и возможность поддерживать
различные native API без копирования содержимого инструкций. Исследование описано в [research.md](research.md).

## Options considered

**1. Adapter-specific prompts** — используют native API напрямую, но создают разные условия, скрытые
   правила и несопоставимые результаты.

**2. Общие application-owned retrieve/store prompts** — один источник инструкций для всех bindings,
   при этом каждый adapter может преобразовать общий текст в форму своего API.

**3. Не передавать prompt context memory adapters** — полностью устраняет prompt divergence, но
   лишает application контроля там, где native provider поддерживает instruction.

## Decision

Использовать ровно два общих prompt assets: `memory-retrieve.md` и `memory-store.md`. Они принадлежат
application layer и передаются каждому memory binding для соответствующей операции. В репозитории не
должно быть prompt content, принадлежащего отдельному adapter.

Adapter может маппить общий prompt в native field (`agentCustomInstructions`, `retainMission` или
эквивалент), но не может изменять его смысл, добавлять к нему provider-specific instruction или
подменять другим файлом. Если backend не поддерживает prompt, binding всё равно фиксирует общий
prompt version в request/trace, а отсутствие native field не создаёт другой prompt contract.

## Rationale

Такой boundary оставляет prompt ownership у application, где видны workflow, версии и сравнение
backends. Native API differences остаются техническим mapping, а не скрытой разницей поведения.

## Consequences

**Positive:**
- Mem0, Hindsight, xmemory и FileMemory получают одинаковый retrieve/store instruction context.
- Prompt version можно менять и аудировать централизованно.
- Удаляются скрытые provider-specific semantics и лишние prompt assets.

**Negative:**
- Общий prompt должен помещаться в ограничения разных native APIs.
- Adapter mapping потребует дополнительных contract tests на равенство текста и версии.
- Provider-specific optimization нельзя добавлять локально без нового ADR.

**Neutral:**
- Native request shapes, ranking и transport errors по-прежнему могут различаться.
- Runtime data (query, lesson, feature, hit) подставляется приложением и не является отдельным prompt.

## Success metrics

- В `src/promts/` ровно два memory-operation assets, общих для всех adapters.
- 100% adapter retrieve/store requests используют соответствующий общий prompt version.
- 0 adapter-specific prompt constants или instruction files в production source.
- Один и тот же prompt digest для одной operation совпадает во всех configured adapters.
