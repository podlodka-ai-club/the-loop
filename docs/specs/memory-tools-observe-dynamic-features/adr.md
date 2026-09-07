---
type: Decision
title: "Динамический набор visual features для каждой фотографии"
description: Vision-модель сама выбирает наблюдаемые признаки кадра, а приложение ограничивает и последовательно обрабатывает их через feature-scoped tools.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
tags: [loci, observe, features, memory, tools, decision]
---

# Динамический набор visual features для каждой фотографии

**Status:** Accepted
**Date:** 2026-08-31
**Authors:** Loci
**Related ADRs:** [Предыдущий feature-scoped ADR](/specs/memory-tools-observe-reflection/adr.md)

Этот ADR supersedes только решение о фиксированном observe registry из 12 слотов; feature-scoped
retrieval, blind/reveal, episode-level reflection и training/evaluation isolation предыдущего ADR
остаются действующими.

---

## Context

Предыдущий ADR зафиксировал feature-scoped retrieval, но выбрал фиксированный registry из 12
слотов. Такой registry удобен для измерения coverage, однако не каждая фотография содержит текст,
столбы, дорожную разметку или другие слоты. Он также не позволяет модели выделить заметный cue,
которого нет в заранее подготовленном списке.

Новая модель должна работать с разными кадрами и выбирать признаки по их содержанию. При этом Loci
нужны bounded стоимость, воспроизводимый trace, безопасные tool arguments и сохранение связи
`feature → hit → episode → lesson`. Исследование описано в [research.md](research.md).

## Options considered

**1. Сохранить фиксированный registry** — сохраняет одинаковую coverage-таблицу и простые метрики,
но продолжает выдавать искусственные пустые слоты и не позволяет добавлять photo-specific cues.

**2. Полностью свободный tool-loop** — модель сама выбирает признаки и retrieval-вызовы без плана,
но может пропускать важные признаки, повторять вызовы и делать стоимость запуска непредсказуемой.

**3. Bounded dynamic observe + управляемый retrieval** — модель формирует bounded список признаков,
а приложение выполняет по одному retrieval на каждый возвращённый признак. Это сохраняет гибкость
для фотографии и даёт приложению лимиты, валидацию и полный trace.

## Decision

Выбрать **bounded dynamic features с application-controlled tool-loop**. Vision-модель возвращает
только признаки, которые она считает наблюдаемыми в конкретном кадре; prompt содержит примеры, но
не фиксированный список ключей. Приложение ограничивает количество и размер признаков, сохраняет
порядок модели и запускает отдельный retrieval для каждого уникального признака. Модель формирует
per-feature query в narrowed tool call; приложение выбирает active feature и `memory_ref`, валидирует
query и выполняет provider call.

Структура памяти, blind/reveal граница, episode-level reflection и ручное разделение training и
evaluation остаются прежними. Максимум признаков и максимум hits нужны для контроля стоимости, но
не являются vocabulary или обязательными слотами.

## Rationale

Фиксированный список лучше подходит для таблицы coverage, но не для разнообразного визуального
потока: отсутствие слота не является наблюдением, а редкий cue может не совпасть с registry. Свободный
tool-loop устраняет registry, но переносит coverage и бюджет на решения модели. Bounded dynamic
вариант разделяет эти ответственности: модель выбирает содержание observations, приложение отвечает
за безопасность, лимиты, порядок операций и provenance.

Такой вариант сохраняет преимущество feature-scoped retrieval — разные cues не конкурируют в одном
global top-K — и уменьшает ложную унификацию входных фотографий. Стоимость остаётся ограниченной
максимальным числом model-generated features и hits.

## Consequences

**Positive:**
- Каждый кадр получает набор признаков, соответствующий его видимому содержанию.
- Новые типы visual cues не требуют изменения enum и feature registry.
- Retrieval, reflection и lessons сохраняют связь с реально выбранным моделью признаком.
- Application limits сохраняют воспроизводимый верхний предел стоимости.

**Negative:**
- Состав и порядок features могут различаться между фотографиями и model versions.
- Метрики coverage требуют fixture labels и slug-normalization ключей, а не простого сравнения фиксированных
  слотов.
- Runtime validation и duplicate handling становятся обязательными для каждого model-generated key.
- При большом числе признаков prompt, latency и стоимость растут до установленного лимита.

**Neutral:**
- Отсутствующий признак не записывается как `not_visible`; он просто не входит в observation array.
- Keys остаются машинно-читаемыми bounded slugs, но их vocabulary не закрыт enum.
- ADR определяет open vocabulary keys, но не решает semantic synonym merging (`road_sign` и `traffic_sign` могут оставаться разными keys).
- Provider-native ranking, Guess schema, geocoder и memory promotion этим решением не меняются.

## Success metrics

- Доля успешных observation parses среди всех observation calls не ниже 99%; успешные parses содержат
  только уникальные bounded keys и не превышают лимит features.
- 100% model-generated features в attempt получают ровно один retrieval outcome или явный failure
  без global merge.
- 100% returned memory hits сохраняют исходный dynamic feature key в trace, reflection и lesson
  metadata.
- В сравнительном pilot-е memory-on и control используют одинаковый cached observation output.
- Каждый attempt остаётся в пределах 24 retrieval model/tool-call attempts, 12 logical retrieval
  outcomes, 60 returned hits, 60 reflection requests и 60 store calls.
