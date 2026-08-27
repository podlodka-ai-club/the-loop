---
type: Concept
title: "Шорт-лист memory backends Loci"
description: Три memory backend с TypeScript API, которые входят в базовую версию Loci.
timestamp: 2026-08-27T00:00:00+03:00
tags: [loci, memory, shortlist, typescript, architecture]
---

# Шорт-лист memory backends Loci

Базовая версия Loci поддерживает три memory backend. Все они имеют TypeScript API и могут быть
подключены через общий envelope [memory_store](/tools/memory_store.md) / [memory_retrieve](/tools/memory_retrieve.md).
Production memory выбирается через registry по `memory_ref`; этот документ фиксирует
кандидатов baseline, а не решение использовать все три одновременно.

| Backend | TypeScript API | Роль в базовой версии | Почему выбран |
|---|---|---|---|
| [xmemory](/research/memory/xmemory.md) | `xmemory` | Schema-grounded backend | XMD позволяет извлекать из свободного training experience типизированные признаки, места и связи, а `read` возвращает synthesized или structured result. |
| [Mem0](/research/memory/mem0.md) | `mem0ai` | Fact-retrieval baseline | У Mem0 есть зрелый TypeScript API, автоматическая extraction, scopes, semantic/keyword retrieval и OSS/Platform варианты. |
| [Hindsight](/research/memory/hindsight.md) | `@vectorize-io/hindsight-client` | Temporal/hybrid retrieval baseline | Hindsight объединяет semantic, BM25, graph и temporal search, возвращает raw memory units, metadata и source facts, а `retain`/`recall` доступны напрямую из TypeScript. Это позволяет проверить, дают ли временные и evidence-связи преимущество на географических cues. |

## Общие правила интеграции

- В inference вызывается только retrieval; запись разрешена training workflow после `reveal`.
- Каждый backend получает отдельную `memory_ref` с provider-specific write и retrieval policy.
- `memory_store` передаёт свободное Markdown-описание опыта; provider сам решает, какие внутренние
  memories, facts, relations или observations создать.
- `memory_retrieve` возвращает provider-native payload: derived answers, profiles, observations,
  graph results и source facts являются полноценной частью оцениваемой памяти.
- Адаптер не хранит canonical copy, не вводит общие IDs memory items и не навязывает
  идемпотентность или общий `limit`.
- Для каждого backend проверяются scope isolation, отсутствие ground-truth leakage, корректная
  передача native payload и фактическое влияние на итоговую геолокацию.

## Почему не другие кандидаты

OpenViking и Neo4j Agent Memory остаются важными вариантами для расширенного пилота: первый даёт
filesystem-oriented memory, второй — graph/geospatial model. В базовый список сейчас выбран
Hindsight как более компактный temporal/hybrid comparator; подробный список альтернатив находится
в [исследовании memory backends](/research/memory/index.md).
