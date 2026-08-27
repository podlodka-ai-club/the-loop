---
type: Research
title: "Zep Cloud: темпоральная память и TypeScript SDK"
description: Исследование пользовательских графов Zep, session memory и актуального TypeScript API.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://help.getzep.com/v2/memory
tags: [memory, zep, temporal-graph, typescript, research]
---

# Zep Cloud: темпоральная память и TypeScript SDK

## Краткий вывод

Zep Cloud — managed context platform: сообщения пишутся в thread/session, а извлечённые факты,
сущности и summaries складываются в user-level context graph. `thread.getUserContext()` возвращает готовый
context string, relevant facts и недавние сообщения. Это полезно для temporal retrieval и аудита;
состояние графа может эволюционировать внутри выбранной привязки.

## Модель данных и retrieval

Пользователь может иметь много сессий; знания из всех сессий объединяются на уровне пользователя.
Сообщение является эпизодом с ролью, именем и содержимым. В фоне Zep строит факты, summaries и
временные интервалы `valid_at`/`invalid_at`. Для поиска используются semantic и BM25 сигналы,
после чего возможен graph-aware reranking. Групповые графы позволяют хранить общую память.

Для latency-sensitive потока `thread.addMessages(..., returnContext: true)` может сразу вернуть context,
но обычная ingestion выполняется асинхронно; последние сообщения всё равно рекомендуется
передавать модели отдельно.

## TypeScript API (v3 surface)

Официальный TypeScript клиент публикуется как `@getzep/zep-cloud` (при проверке npm показывал
версию `3.28.0`); community/self-hosted и совместимость с Zep v0.x находятся в
`@getzep/zep-js`. Пакет экспортирует `ZepClient` и типы. Ниже выбран текущий v3 thread API;
старый `memory.*` API оставлен только для миграции.

```ts
import { ZepClient } from "@getzep/zep-cloud";

const client = new ZepClient({ apiKey: process.env.ZEP_API_KEY! });
const userId = "user-123";
const sessionId = "session-456";

await client.user.add({ userId, firstName: "Jane", lastName: "Smith" });
await client.thread.create({ threadId: sessionId, userId });

const added = await client.thread.addMessages(sessionId, {
  messages: [
    {
      name: "Jane",
      role: "user",
      content: "I moved from Boston to Seattle",
      createdAt: "2026-08-27T10:00:00Z",
    },
  ],
  returnContext: true,
});

const context = added.context ?? (await client.thread.getUserContext(sessionId)).context;
const messages = await client.thread.get(sessionId, { lastn: 6 });
console.log(context, messages.messages);

const hits = await client.graph.search({
  userId,
  query: "where does Jane live?",
});
```

В SDK reference также есть `graph.add`, `graph.addBatch`, `graph.search`, node/edge/episode CRUD,
neighbors и `graph.listEntityTypes`; `thread.message.update` меняет metadata сообщения. Для
LangChain.js доступны `ZepChatMessageHistory`, `ZepVectorStore` и `ZepMemory` из
`@getzep/zep-cloud/langchain`.

REST-документация использует snake_case (`return_context`, `created_at`), а TypeScript reference
— camelCase (`returnContext`, `createdAt`) и `thread.*`. Старый `memory.*` surface следует
использовать только для миграции и не смешивать с v3.

## Развёртывание и fit для Loci

- Zep Cloud — managed; Zep comparison на официальном сайте описывает SDK для Python, TypeScript и Go.
- Graph backend Cloud скрыт в Context Graph Engine; для self-hosted Graphiti требуется отдельный
  отчёт и эксплуатация graph database.
- Registry разрешает `memory_ref` Loci в Zep project, `userId` или отдельный graph scope, а
  `run_id` — на session/thread.
- `thread.getUserContext()` возвращает скомпонованный текст, который можно передавать агенту как
  provider-native payload наряду с graph search results.
- Запись в Zep выполняется асинхронно и меняет граф; интеграционный слой проверяет готовность
  episodes, использует read-only credentials для locate/evaluation и извлекает raw facts/provenance.

## Открытые вопросы

- Какой Zep scope (project, user, thread или graph) должен стоять за Loci `memory_ref`,
  и как проверяется tenant isolation?
- Что даёт лучший geolocation score: готовый `context` Zep или graph search payload?

## Источники

1. [Zep Adding Messages](https://help.getzep.com/v3/adding-messages) — текущий thread ingestion, timestamps и processing status.
2. [Zep Episodes](https://help.getzep.com/v3/episodes) — raw provenance artifacts и graph-derived facts.
3. [Zep Key Concepts](https://help.getzep.com/v2/concepts) — context string и temporal facts.
4. [Zep performance guide](https://help.getzep.com/v2/performance) — hybrid search и async/latency режимы.
5. [Zep TypeScript client repository](https://github.com/getzep/zep-js) — пакеты и интеграции.
6. [Zep TypeScript reference](https://github.com/getzep/zep-js/blob/main/reference.md) — thread/graph/episode/node methods.
7. [Zep Cloud package](https://www.npmjs.com/package/@getzep/zep-cloud) — TypeScript declarations и версия пакета.
