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

await client.retain(
  "loci-prod",
  "# Observation\n\nRed soil, concrete utility poles, Portuguese text.\n\n# Reveal\n\nParaná, Brazil.",
  { context: "Loci training episode after reveal" },
);

const result = await client.recall("loci-prod", "How should red soil be weighted?", {
  types: ["world", "observation"],
});
```

`metadata` возвращается вместе с recalled memory, а `document_id` группирует содержимое и
позволяет повторную загрузку как upsert. `include_source_facts` и `include_chunks` дают путь от
сводного observation к исходному факту и текстовому chunk. `recall` и `reflect` являются
равноправными кандидатами для `memory_retrieve`: лучший режим выбирается по итоговому качеству Loci.

## Развёртывание и fit для Loci

- Есть Node.js/TypeScript client `@vectorize-io/hindsight-client`, REST и MCP; core и self-hosted
  server используют PostgreSQL с pgvector.
- Memory bank изолирует область данных. Доступны self-hosted, managed Cloud и enterprise-вариант;
  при self-hosting остаётся операционная стоимость PostgreSQL, фоновых LLM-вызовов и миграций.
- Loci сопоставляет `memory_ref` с bank и provider-specific настройками `retain`, `recall` и
  `reflect`. Общий контракт не требует `document_id`, IDs memory units или выбора только raw facts.
- Асинхронная консолидация observations означает, что результат памяти может развиваться после
  `retain`. Нужно определить подходящий settle period перед evaluation, не заменяя native lifecycle
  внешним ledger.

## Открытые вопросы

- Что даёт лучший geolocation score: `recall` с facts/observations/source facts или `reflect`?
- Какой набор `world`/`experience`/`observation` лучше подходит для географических эпизодов?
- Какой settle period между training и evaluation нужен выбранному deployment?

## Источники

1. [Hindsight quickstart](https://hindsight.vectorize.io/developer/api/quickstart) — Node.js client и три операции.
2. [Retain API](https://hindsight.vectorize.io/developer/api/retain) — metadata, document IDs и extraction.
3. [Recall API](https://hindsight.vectorize.io/developer/api/recall) — типы памяти, hybrid retrieval и source facts.
4. [Memories API](https://hindsight.vectorize.io/developer/api/memories) — memory units, состояния и history.
5. [Hindsight repository](https://github.com/vectorize-io/hindsight) — self-hosted/Cloud deployment и лицензия.
