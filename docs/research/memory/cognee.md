---
type: Research
title: "Cognee: graph-native memory с session bridge"
description: Исследование Cognee v1.0 и официальных Node.js bindings для remember/recall и графового retrieval.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.cognee.ai/core-concepts/overview
tags: [memory, cognee, knowledge-graph, sessions, typescript, research]
---

# Cognee: graph-native memory с session bridge

## Краткий вывод

Cognee превращает текст, файлы и URL в searchable knowledge graph. В v1.0 основной lifecycle
состоит из `remember`, `recall`, `improve`, `forget`; старые `add`, `cognify`, `memify`, `search`
остались для тонкого контроля. Архитектура использует relational store для provenance, vector
store для similarity и graph store для entities/relationships.

## Два режима памяти

`remember(data)` без `session_id` запускает тяжёлую постоянную ingestion pipeline: chunking,
entity/relationship extraction, embeddings и Improve pass. `remember(data, session_id)` пишет
быстрый raw entry в session cache; при `self_improvement=true` (по умолчанию) фоновый Improve
может перенести полезное содержимое в постоянный граф.

`recall()` при наличии session сначала проверяет cache, затем graph; результат помечает `_source`
как `session` или `graph`. Автоматический выбор query type rule-based, но indexing может ещё идти,
поэтому для строгого пайплайна нужно проверять dataset status.

## TypeScript API

Официальные Node.js bindings публикуются как `@cognee/cognee-ts` и построены через Neon вокруг
Cognee-RS. Это отличается от Python/HTTP документации, где встречается модульный импорт
`cognee`.

```ts
import { init, Cognee } from "@cognee/cognee-ts";

init(); // один раз на процесс
using c = new Cognee({
  llmModel: "gpt-4o-mini",
  llmApiKey: process.env.OPENAI_TOKEN,
});

await c.warm();
const datasetName = "geolocation";
const sessionId = "solve-42";
await c.remember(
  { type: "text", text: "The red soil clue is ambiguous." },
  datasetName,
  { sessionId },
);

const result = await c.recall("How should red soil be used?", {
  sessionId,
  scope: "auto", // graph | session | trace | graph_context | all
});

await c.improve({ datasetName, sessionIds: [sessionId] });
await c.forget({ kind: "dataset", dataset: { name: datasetName } });
c.close();
```

Для детерминированного контроля доступны `add`, `cognify`, `search`, `memify`, dataset/session
CRUD и `rememberEntry` типов `qa`, `trace`, `feedback`. `search` поддерживает 16 search types,
включая `TEMPORAL`, `HYBRID_COMPLETION`, `TRIPLET_COMPLETION` и `CHUNKS_LEXICAL`.

## Развёртывание и fit для Loci

Bindings поддерживают локальные настройки, `serve()` для подключения к HTTP/Cloud и явные
конфигурации LLM/embeddings/vector/graph DB. `init()` запускает Rust async runtime, а `close()`
освобождает connection pool; это важный lifecycle для worker-процесса.

Cognee хорошо отражает разделение short-term и long-term памяти: registry сопоставляет
Loci `memory_snapshot_id` с dataset, а `sessionId` — с solve или временным контекстом. `improve` и `forget`
изменяют выбранный backend, что допустимо при внешнем контракте Loci, но требует operation ledger
и запрета training-записей из inference. Для `memory_retrieve`
лучше запрашивать source-tagged/raw results, а не полагаться только на generated completion.

## Открытые вопросы

- Насколько стабилен `@cognee/cognee-ts` для production Node worker и какие native-бинарники
  доступны для целевых окружений Loci?
- Нужен ли полный graph completion, или следует ограничить retrieval типами `CHUNKS`/`HYBRID`
  и хранить generated answer отдельно от заметки?
- Какой mapping registry фиксирует для Loci `memory_snapshot_id` → dataset/user и session entries
  без смешения пользователей?

## Источники

1. [Cognee core concepts](https://docs.cognee.ai/core-concepts/overview) — storage architecture и четыре операции.
2. [Remember](https://docs.cognee.ai/core-concepts/main-operations/remember) — permanent/session modes и indexing status.
3. [Recall](https://docs.cognee.ai/core-concepts/main-operations/recall) — routing и ограничения во время indexing.
4. [Sessions and caching](https://docs.cognee.ai/core-concepts/sessions-and-caching) — TTL, cache backends и session-first retrieval.
5. [Cognee-RS TypeScript README](https://github.com/topoteretes/cognee-rs/blob/main/ts/README.md) — пакет, constructor, lifecycle и Node API.
6. [Cognee-RS bindings overview](https://github.com/topoteretes/cognee-rs) — соответствие TS/Python/Rust surfaces.
