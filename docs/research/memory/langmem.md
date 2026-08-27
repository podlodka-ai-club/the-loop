---
type: Research
title: "LangMem: инструменты памяти для LangGraph"
description: Исследование архитектуры LangMem, его Python-only API и TypeScript-пути через LangGraph Store.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://langchain-ai.github.io/langmem/
tags: [memory, langmem, langgraph, typescript, research]
---

# LangMem: инструменты памяти для LangGraph

## Краткий вывод

LangMem — не отдельная база данных, а слой извлечения и управления памятью поверх LangGraph
`BaseStore`. Он даёт hot-path tools и background manager для записи/обновления знаний. На
2026-08-27 официальный пакет остаётся Python-only: репозиторий публикует `pip install langmem`,
содержит преимущественно Python, а открытый запрос на TypeScript-порт остаётся без реализации.

Для TypeScript-команды это означает: использовать напрямую можно LangGraph JS Store, но не
LangMem extraction/tooling; полноценный эквивалент потребует собственного сервиса или порта.

## Архитектура

LangMem разделяет две задачи:

1. `create_memory_manager` — stateless обработка сообщений и выдача структурированных
   `ExtractedMemory`.
2. `create_memory_store_manager` — stateful обработка с записью в переданный `BaseStore`.

`create_manage_memory_tool` и `create_search_memory_tool` позволяют самому агенту записывать и
искать память в текущем ходе. Background manager может извлекать, консолидировать и обновлять
знания после ответа. Область определяется namespace (обычно кортеж вроде `(user_id,
"memories")`), значение хранится как JSON item по ключу.

`InMemoryStore` годится только для разработки. Для длительного хранения LangGraph предлагает
Postgres/Redis и другие DB-backed stores; семантический поиск включается конфигурацией embeddings.

## Официальный API и граница TypeScript

Python API (для понимания контракта):

```py
from langmem import create_memory_store_manager

manager = create_memory_store_manager(
    "openai:gpt-4.1-mini",
    namespace=("users", "alice"),
    store=store,
)
memories = await manager.ainvoke({"messages": messages})
```

В официальном reference перечислены `create_memory_manager`,
`create_memory_store_manager`, `create_manage_memory_tool` и `create_search_memory_tool`; npm-
пакета LangMem и TypeScript-сигнатур этих функций в официальном репозитории нет.

Ближайший TypeScript-путь — прямой LangGraph Store:

```ts
import { InMemoryStore } from "@langchain/langgraph";

const store = new InMemoryStore({
  index: { embeddings, dims: 1536 },
});
const namespace = ["alice", "memories"];

await store.put(namespace, "note-1", { content: "Red soil is not decisive" });
const hits = await store.search(namespace, { query: "red soil", limit: 5 });
const item = await store.get(namespace, "note-1");
await store.delete(namespace, "note-1");
```

Это CRUD/search storage, а не автоматическое извлечение, разрешение конфликтов или фоновые
операции LangMem. Для production нужен persistent store и миграции.

## Fit для Loci

Сильная сторона — минимальная инфраструктурная поверхность для уже существующего LangGraph и
естественная модель namespace/key, сопоставляемая с Loci `memory_snapshot_id` (ID привязки к
конкретному Store) и `note_id`. Слабая сторона — отсутствие официальной TS extraction-библиотеки.
Прямой `put` из training можно направить в выбранный namespace, но идемпотентность по
`attempt_id`, валидацию заметок и read-only policy реализует интеграционный слой.

Если Loci остаётся на TypeScript, LangMem следует рассматривать как архитектурный ориентир и
контракт Store, а не как готовую зависимость. Если появится Python worker, можно вынести в него
background extraction, оставив TypeScript runner клиентом Store-сервиса.

## Открытые вопросы

- Нужен ли Loci автоматический extraction, или достаточно сохранять короткие заметки напрямую
  после `reveal`?
- Если нужен extraction, допустимы ли Python worker и сетевой hop, либо требуется собственный
  TypeScript manager с теми же namespace/JSON-правилами?
- Как registry будет связывать Loci `memory_snapshot_id` с namespace и backend Store, чтобы один solve не
  переключал привязку в середине запроса?

## Источники

1. [LangMem repository](https://github.com/langchain-ai/langmem) — официальная установка, состав и Python API.
2. [LangMem API reference](https://langchain-ai.github.io/langmem/reference/) — memory managers и tools.
3. [LangMem memory API](https://langchain-ai.github.io/langmem/reference/memory/) — сигнатуры managers и разрешённые операции.
4. [TypeScript support issue](https://github.com/langchain-ai/langmem/issues/121) — официальный открытый запрос на TS.
5. [LangGraph JS long-term memory](https://docs.langchain.com/oss/javascript/langchain/long-term-memory) — Store и TypeScript-пример.
6. [LangGraph JS persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) — namespace/key и persistent stores.
