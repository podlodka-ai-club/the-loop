---
type: Decision
title: "Dynamic features без post-hoc geo-фильтрации"
description: Dynamic observation сохраняет структурно валидные model-generated features без словаря географических сущностей и semantic content filter.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
tags: [loci, observe, features, memory, decision]
---

# Dynamic features без post-hoc geo-фильтрации

**Status:** Accepted
**Date:** 2026-08-31
**Authors:** Loci
**Related ADRs:** [Dynamic feature memory tools](/specs/memory-tools-observe-dynamic-features/adr.md), [feature-scoped retrieval](/specs/memory-tools-observe-reflection/adr.md)

## Context

Предыдущий dynamic ADR правильно отказался от фиксированного набора feature keys, но добавил
словарную geo-policy для удаления observations, похожих на страны, регионы, города или континенты.
На реальных фотографиях такие строки неотделимы от вывесок, брендов, языковых признаков и прочего
текста без semantic понимания контекста. Смешанный словарь даёт ложные срабатывания и удаляет
полезные признаки.

Нужно сохранить variable features, bounded стоимость и provenance, но не превращать приложение в
непроверяемый semantic classifier. Исследование описано в [research.md](research.md).

## Options considered

**1. Расширять словарь и regex** — покрывает больше названий, но увеличивает ложные срабатывания,
   требует постоянного обновления и не различает географический вывод и видимый текст.

**2. Структурная валидация без content filter** — принимает любые model-generated visual facts,
   если они соответствуют JSON-контракту и лимитам; оставляет semantic interpretation модели.

**3. Отдельный semantic classifier** — может точнее классифицировать контент, но добавляет новый
   model call, latency, стоимость и отдельный источник ошибок в основном loop.

## Decision

Выбрать структурную валидацию dynamic features без post-hoc geo-фильтрации. Приложение проверяет
JSON shape, допустимые длины, нормализацию keys, уникальность и budget cap, но не ищет географические
сущности, implication phrases или другие semantic patterns в `text`.

Prompt может описывать желательный формат наблюдений и приводить примеры, однако prompt guidance не
становится вторым runtime-фильтром. Feature-scoped retrieval, blind/reveal, reflection, lessons и
training/evaluation isolation предыдущих ADR остаются действующими.

## Rationale

Такое разделение оставляет модели ответственность за выбор содержания features, а приложению — за
проверяемые и воспроизводимые границы протокола. Оно устраняет ложные удаления без отказа от лимита
features или защиты от malformed output.

## Consequences

**Positive:**
- Видимый текст и редкие visual cues не теряются из-за словарного совпадения.
- Нет отдельного geo dictionary, regex policy и cache invalidation по его версии.
- Поведение parser проще тестировать и объяснять по структурному контракту.

**Negative:**
- Semantic geographic leakage может попасть в observations, если модель его сгенерировала.
- Prompt quality и downstream reflection должны контролировать полезность содержимого.
- Для semantic moderation в будущем потребуется отдельное решение, а не неявное расширение parser.

**Neutral:**
- Dynamic vocabulary, per-feature retrieval, provenance и bounded limits не меняются.
- Невалидный JSON, duplicate key, invalid key и resource overflow по-прежнему отклоняются целиком.

## Success metrics

- 100% structurally valid feature records, включая записи с geographic-looking text, проходят parser.
- 0 runtime reads of `src/observe-geo-entities.json` и 0 content-based geo rejections.
- Observation cache identity не меняется при изменении любого внешнего geo dictionary, поскольку такого
  dependency больше нет.
- Не менее 99% успешных parses сохраняют только уникальные bounded keys в порядке модели.
