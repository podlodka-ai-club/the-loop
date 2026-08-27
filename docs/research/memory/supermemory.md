---
type: Research
title: "Supermemory: fact-based temporal vector graph"
description: Исследование Supermemory, его TypeScript SDK, профилей пользователя и self-hosted режима.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://supermemory.ai/docs/integrations/supermemory-sdk
tags: [memory, supermemory, temporal-graph, typescript, self-hosted, research]
---

# Supermemory: fact-based temporal vector graph

## Краткий вывод

Supermemory — memory/context engine, который из документов и диалогов извлекает атомарные факты,
связывает их отношениями `updates`, `extends`, `derives` и поддерживает automatic forgetting.
Официальные материалы описывают temporal vector-graph engine с vector, FTS и graph внутри; поэтому
исходное описание «только вектор» устарело.

Документы — raw input для RAG, memories — извлечённые facts для персонального состояния. Для
пользователя автоматически поддерживаются `profile.static` (стабильные факты) и `profile.dynamic`
(текущий контекст).

## TypeScript API

```ts
import Supermemory from "supermemory";

const client = new Supermemory({
  apiKey: process.env.SUPERMEMORY_API_KEY,
});

await client.add({
  content: "The user prefers metric units and concise explanations.",
  containerTag: "user_123",
  metadata: { source: "training" },
});

const { results } = await client.search({
  q: "What explanation style does the user prefer?",
  containerTag: "user_123",
  searchMode: "memories",
  include: { relatedMemories: true },
  limit: 5,
});

const profile = await client.profile({ containerTag: "user_123" });
const docs = await client.documents.list({ containerTags: ["user_123"], limit: 10 });
await client.documents.delete({ docId: docs.memories[0].id });
```

SDK содержит TypeScript-типы параметров/ответов, Bearer auth, retries (по умолчанию 2), timeout
и ошибки `APIError` с отдельными классами для 4xx/5xx. `containerTag`/`containerTags` — основной
механизм tenant/user scoping; разрешены также metadata filters.

Документация меняет surface между версиями: старые страницы показывают
`client.search.execute(...)` и `client.memories.add(...)`, а актуальная SDK-страница —
`client.search(...)` и `client.add(...)`. При интеграции нужно фиксировать пакет и проверять
сигнатуры `searchMode` (`memories`, `documents`, `hybrid`) по установленной версии.

## Развёртывание и fit для Loci

Cloud API работает через `https://api.supermemory.ai`; self-hosted quickstart запускает локальный
сервер с embedded graph engine, embeddings и каталогом `.supermemory`, а SDK получает
`baseURL: "http://localhost:6767"`. Репозиторий приложения помечен MIT, но self-hosted сервер
поставляется как бинарный дистрибутив; перед production следует отдельно проверить источник и
лицензию конкретного дистрибутива.

Registry использует `containerTag` как значение Loci `memory_snapshot_id` и ограничивает пользователя,
проект или другой memory binding. Движок по смыслу эволюционирует: новые факты обновляют старые,
временные факты забываются, а `documents.delete` необратим. Это не требует provider snapshots,
но для Loci нужно явно определить, какие updates/forgetting допустимы и как интеграционный слой
обеспечивает operation idempotency.

Сильные стороны — автоматическая экстракция, профиль и related-memory context без ручной схемы;
риски — black-box extraction/forgetting, asynchronous processing и необходимость проверять
статус документа перед retrieval. Для audit важно сохранять исходный документ и version metadata,
а не только результат поиска.

## Открытые вопросы

- Какой `containerTag` и scope становятся значением registry для Loci `memory_snapshot_id`, и как проверяется
  tenant isolation?
- Можно ли в выбранной версии отключить automatic forgetting/updates или зафиксировать их политику
  для заметок, которые добавляет training?
- Какую поверхность фиксируем для адаптера — текущую `client.search`/`client.add` или legacy
  `search.execute`/`memories.add` — и как проверяем совместимость Cloud и self-hosted?

## Источники

1. [Supermemory SDK](https://supermemory.ai/docs/integrations/supermemory-sdk) — официальный JavaScript/TypeScript API.
2. [How Supermemory Works](https://supermemory.ai/docs/concepts/how-it-works) — pipeline documents → memories и processing statuses.
3. [Graph memory](https://supermemory.ai/docs/concepts/graph-memory) — relationships, temporal updates и forgetting.
4. [User profiles](https://supermemory.ai/docs/concepts/user-profiles) — static/dynamic profile.
5. [Search memory entries API](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries) — v4 query, threshold, include и limits.
6. [Self-hosting quickstart](https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/quickstart.mdx) — local server и `baseURL`.
7. [Supermemory repository](https://github.com/supermemoryai/supermemory) — OSS repository, integrations и лицензия.
