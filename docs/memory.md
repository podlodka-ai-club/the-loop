---
type: Concept
title: "Шорт-лист memory backends Loci"
description: Три memory backend с TypeScript API, которые входят в базовую версию Loci.
timestamp: 2026-08-27T00:00:00+03:00
tags: [loci, memory, shortlist, typescript, architecture]
---

# Шорт-лист memory backends Loci

Базовая версия Loci поддерживает три memory backend. Все они имеют TypeScript API и могут быть
подключены через единый [memory_store](/tools/memory_store.md) / [memory_retrieve](/tools/memory_retrieve.md)
adapter. Production binding выбирается через registry по `snapshot_id`; этот документ фиксирует
кандидатов baseline, а не решение использовать все три одновременно.

| Backend | TypeScript API | Роль в базовой версии | Почему выбран |
|---|---|---|---|
| [xmemory](/research/memory/xmemory.md) | `xmemory` | Основной structured backend | XMD позволяет описать `memory_note`, использовать явные LLM-free mutations, primary keys, deduplication и `raw-tables`/`xresponse`. Это наиболее близкое соответствие контрактам Loci и лучше всего подходит для воспроизводимой записи после `reveal`. |
| [Mem0](/research/memory/mem0.md) | `mem0ai` | Общий fact-retrieval baseline | У Mem0 есть зрелый TypeScript API, scopes, extraction, semantic/keyword retrieval и OSS/Platform варианты. Он даёт понятную generic baseline для сравнения качества retrieval, но требует внешнего контроля async ingestion, scope и `source_attempt_id`. |
| [Hindsight](/research/memory/hindsight.md) | `@vectorize-io/hindsight-client` | Temporal/hybrid retrieval baseline | Hindsight объединяет semantic, BM25, graph и temporal search, возвращает raw memory units, metadata и source facts, а `retain`/`recall` доступны напрямую из TypeScript. Это позволяет проверить, дают ли временные и evidence-связи преимущество на географических cues. |

## Общие правила интеграции

- В inference вызывается только retrieval; запись разрешена training workflow после `reveal`.
- Каждый backend получает отдельный binding и должен сохранять `source_attempt_id` вместе с
  заметкой или metadata.
- Derived answers, profiles, observations и graph completions не заменяют raw note в evaluation.
- Для каждого backend нужны contract tests на `limit`, scope isolation, retry/idempotency и
  задержку видимости новой заметки.

## Почему не другие кандидаты

OpenViking и Neo4j Agent Memory остаются важными вариантами для расширенного пилота: первый даёт
filesystem-oriented memory, второй — graph/geospatial model. В базовый список сейчас выбран
Hindsight как более компактный temporal/hybrid comparator; подробный список альтернатив находится
в [исследовании memory backends](/research/memory/index.md).
