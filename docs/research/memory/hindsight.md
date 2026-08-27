---
type: Research
title: "Hindsight: temporal memory с retain, recall и reflect"
description: Исследование Hindsight как self-hosted и managed memory backend с hybrid temporal retrieval, наблюдениями и TypeScript-клиентом.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://hindsight.vectorize.io/developer/api/quickstart
tags: [memory, hindsight, temporal, provenance, typescript, research]
---

# Hindsight: temporal memory с retain, recall и reflect

## Краткий вывод

Hindsight — отдельный memory service с тремя явно разделёнными операциями: `retain` принимает
содержимое и извлекает факты, `recall` возвращает ранжированные memory units, а `reflect` строит
ответ поверх найденного. Для Loci особенно интересны временной поиск, entity links, метаданные,
document IDs и возможность получить evidence вместо только сгенерированного ответа.

## Модель и API

Hindsight хранит три типа памяти: `world` для объективных фактов, `experience` для событий и
действий, `observation` для дедуплицированных выводов, поддержанных исходными фактами. `recall`
объединяет semantic, BM25, graph и temporal retrieval, а затем reranks результаты.

```ts
import { HindsightClient } from "@vectorize-io/hindsight-client";

const client = new HindsightClient({
  baseUrl: "http://localhost:8888",
  apiKey: process.env.HINDSIGHT_API_KEY,
});

await client.retain("loci-prod", "Concrete utility poles are a stronger clue than red soil.", {
  documentId: "train-2026-08-27:sample-0042",
  metadata: { source_attempt_id: "train-2026-08-27:sample-0042" },
});

const result = await client.recall("loci-prod", "How should red soil be weighted?", {
  types: ["world", "observation"],
});
```

`metadata` возвращается вместе с recalled memory, а `document_id` группирует содержимое и
позволяет повторную загрузку как upsert. `include_source_facts` и `include_chunks` дают путь от
сводного observation к исходному факту и текстовому chunk. `reflect` не следует использовать в
`memory_retrieve`: он возвращает LLM-generated ответ, а не канонический список заметок.

## Развёртывание и fit для Loci

- Есть Node.js/TypeScript client `@vectorize-io/hindsight-client`, REST и MCP; core и self-hosted
  server используют PostgreSQL с pgvector.
- Memory bank изолирует область данных. Доступны self-hosted, managed Cloud и enterprise-вариант;
  при self-hosting остаётся операционная стоимость PostgreSQL, фоновых LLM-вызовов и миграций.
- Loci может сопоставить `memory_snapshot_id` с bank, `document_id` — с `attempt_id`, а
  `source_attempt_id` — с metadata. Для retrieval следует выбирать `world`/`experience` или
  `observation` отдельно и возвращать raw facts с их IDs.
- Асинхронная консолидация observations означает, что только что добавленная заметка может быть
  видна раньше как raw fact, чем как observation. Training pipeline должен дождаться готовности
  ingestion; inference получает только read-only доступ.

## Открытые вопросы

- Достаточно ли Hindsight `metadata` и document-level IDs для обязательного
  `source_attempt_id` без внешнего ledger?
- Нужны ли Loci observations, или для воспроизводимости evaluation лучше хранить и читать только
  raw `world` facts?
- Какова фактическая задержка между `retain` и доступностью raw fact/observation на выбранном
  deployment?

## Источники

1. [Hindsight quickstart](https://hindsight.vectorize.io/developer/api/quickstart) — Node.js client и три операции.
2. [Retain API](https://hindsight.vectorize.io/developer/api/retain) — metadata, document IDs и extraction.
3. [Recall API](https://hindsight.vectorize.io/developer/api/recall) — типы памяти, hybrid retrieval и source facts.
4. [Memories API](https://hindsight.vectorize.io/developer/api/memories) — memory units, состояния и history.
5. [Hindsight repository](https://github.com/vectorize-io/hindsight) — self-hosted/Cloud deployment и лицензия.
