---
type: Research
title: "Mem0: API и пригодность для внешней памяти Loci"
description: Актуальное состояние Mem0 OSS и Platform, включая TypeScript API, области памяти и ограничения версионирования.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.mem0.ai/open-source/node-quickstart
tags: [memory, mem0, typescript, vector-search, research]
---

# Mem0: API и пригодность для внешней памяти Loci

## Краткий вывод

Mem0 — memory layer с автоматическим извлечением фактов из сообщений, областью видимости
`user`/`agent`/`app`/`run` и семантическим поиском. TypeScript-пакет покрывает и локальный OSS-
режим, и облачный Platform API. ID привязки Loci сопоставляется со стабильным scope Mem0, а
различия OSS/Platform скрываются за единым контрактом.

## Архитектура и жизненный цикл

При `add()` Mem0 (если `infer=true`) извлекает факты, сопоставляет их с существующими записями,
дедуплицирует и сохраняет embedding. При поиске объединяются semantic, keyword/BM25 и entity
сигналы; reranker подключается отдельно. `metadata`, `categories` и временные поля доступны для
фильтрации.

В актуальной v3-документации extraction является ADD-only: новые факты накапливаются, а явные
`update()`/`delete()` выполняются приложением. В OSS отдельный graph store (Neo4j и аналоги) в
миграции v3 удалён: entity linking хранится в параллельной коллекции vector store. Graph Memory
остаётся возможностью Platform. Поэтому описание «вектор + граф» из исходной таблицы нельзя
считать точным для текущего OSS SDK.

## TypeScript API

```ts
import { Memory } from "mem0ai/oss";

const memory = new Memory();

await memory.add(
  [
    { role: "user", content: "I prefer aisle seats" },
    { role: "assistant", content: "I will remember that" },
  ],
  { userId: "alice", metadata: { source: "onboarding" } },
);

const { results } = await memory.search("What seat does Alice prefer?", {
  filters: { user_id: "alice" },
  topK: 5,
  rerank: true,
});

const all = await memory.getAll({ filters: { user_id: "alice" } });
await memory.update(results[0].id, { text: "Alice prefers aisle seats" });
await memory.delete(results[0].id);
await memory.deleteAll({ userId: "alice" });
const history = await memory.history(results[0].id);
```

Для облака используется `MemoryClient`:

```ts
import MemoryClient from "mem0ai";

const client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
await client.add(messages, { userId: "alice" });
const page = await client.getAll({ filters: { user_id: "alice" }, page: 1, pageSize: 50 });
```

Методы SDK возвращают `Promise`; cloud `add()` может вернуть pending event, а обработка записи
происходит асинхронно. Для согласованности нужно ждать событие/вебхук или повторять чтение с
политикой backoff.

В TypeScript верхнеуровневые параметры используют camelCase (`userId`, `topK`, `pageSize`), но
ключи внутри `filters` остаются snake_case (`user_id`, `agent_id`). `getAll()` требует хотя бы
один идентификатор области. В документации есть различия между версиями API, поэтому версию
`mem0ai` следует фиксировать.

## Развёртывание и интеграция

- OSS запускается библиотекой в Node или self-hosted REST-сервером.
- Platform — managed REST API с проектами, webhook-событиями, history и multi-tenant доступом.
- Для TypeScript официально перечислены vector stores Qdrant, Redis, Valkey, Vectorize и
  in-memory; список Python-провайдеров шире.
- Дефолты в документации различаются: Node quickstart показывает in-memory vector store, а
  общий OSS overview — локальный Qdrant. Для production конфигурацию LLM, embedder, vector store
  и history нужно задавать явно.

## Fit для Loci

Mem0 подходит как внешний retrieval-движок: registry привязок сопоставляет Loci
`memory_snapshot_id` со стабильным Mem0 scope (обычно `userId`/`agentId` + tenant metadata;
`runId` лучше оставить операционным/session ID) и различает read-only вызовы locate/evaluation от
training-записи. Протокол Loci требует идемпотентность по `attempt_id` и provenance
`source_attempt_id`; Mem0 не заменяет внешний operation ledger, поэтому это реализует
интеграционный слой.

Основные риски — асинхронная видимость записи, стоимость LLM extraction и несовпадение текущего
OSS поведения с заявленной в исходном ответе операцией SUPERSEDE. Для графовых запросов нужен
Platform или отдельный graph backend.

## Открытые вопросы

- Достаточна ли задержка cloud/OSS ingestion для training-run, или нужен отдельный staging queue?
- Какой стабильный Mem0 scope (`userId`/`agentId` и tenant metadata) использовать для ID привязки
  и как передавать `source_attempt_id` без смешения tenant-данных?
- Как интеграционный слой дождётся завершения async `add()` и безопасно повторит запись при `timeout`?

## Источники

1. [Node SDK Quickstart](https://docs.mem0.ai/open-source/node-quickstart) — установка и локальный TypeScript API.
2. [Mem0 SDK Guide](https://github.com/mem0ai/mem0/blob/main/skills/mem0/references/sdk-guide.md) — `add`, `search`, CRUD, history, batch и naming conventions.
3. [How Mem0 Works](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx) — extraction и multi-signal retrieval.
4. [Architecture reference](https://github.com/mem0ai/mem0/blob/main/skills/mem0/references/architecture.md) — v3 lifecycle, scopes и search defaults.
5. [Graph Memory migration](https://docs.mem0.ai/platform/features/graph-memory) — удаление graph store из OSS и entity linking.
6. [Vector database support](https://docs.mem0.ai/components/vectordbs/overview) — доступные backend-провайдеры для TypeScript.
