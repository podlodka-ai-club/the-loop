---
type: Research
title: "OpenViking: context database с filesystem-памятью"
description: Исследование OpenViking как self-hosted контекстной базы, объединяющей memory, resources и skills через иерархические URI и TypeScript HTTP SDK.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.openviking.ai/en/api/01-overview
tags: [memory, openviking, filesystem, hierarchical-retrieval, multimodal, typescript, research]
---

# OpenViking: context database с filesystem-памятью

## Краткий вывод

OpenViking представляет память не как плоскую коллекцию vector chunks, а как виртуальную
файловую систему `viking://`. В ней отдельно живут memory, resources и skills; retrieval сначала
находит подходящую директорию, затем углубляется по иерархии. Это даёт Loci наблюдаемую структуру
памяти и естественное место для исходной Markdown-заметки, её краткого описания и полного текста.

## Модель и API

Для каждого контекста есть три уровня загрузки:

- L0 — короткий abstract для vector retrieval;
- L1 — overview директории для rerank и навигации;
- L2 — исходный файл, который читается on demand.

Простой `find()` не требует session context; `search()` добавляет intent analysis и hierarchical
retrieval. Session `commit()` архивирует сообщения, запускает асинхронное извлечение памяти и
пишет `memory_diff.json` с операциями add/update/delete, что полезно для аудита и rollback.

```ts
import { OpenVikingClient } from "@openviking/sdk";

const client = new OpenVikingClient({
  baseUrl: "http://localhost:1933",
  apiKey: process.env.OPENVIKING_API_KEY,
});

const hits = await client.search("concrete utility poles", {
  targetUri: "viking://user/loci/memories",
  limit: 5,
});
const note = await client.read(hits[0].uri);
```

Официальный TypeScript SDK покрывает HTTP API, filesystem/content operations, retrieval и
sessions. Для записи memory есть session message + commit/extract API; в текущем SDK это
экспериментальная область и конкретную форму payload следует сверить с зафиксированной версией.
Для мультимодальных session messages поддерживаются `ImagePart` и другие parts; при memory
extraction изображение может быть преобразовано в текст configured VLM.

## Развёртывание и fit для Loci

- Официальный пакет `@openviking/sdk` — HTTP-only ESM/CommonJS TypeScript client для Node.js 18+;
  сервер остаётся отдельным процессом. Доступны CLI, HTTP API и MCP.
- URI и directory scope естественно выражают `memory_snapshot_id → user/project namespace`, а
  frontmatter и `source_attempt_id` можно хранить в L2 Markdown. L0/L1 следует рассматривать как
  derived index, не как источник истины.
- Для `memory_retrieve` лучше использовать `find()`/list/read и возвращать raw L2 note вместе с
  URI; `search(mode="context")` удобен для prompt assembly, но скрывает часть решения на стороне
  сервера.
- Session `commit()` и semantic processing асинхронны. В inference их нужно запретить, а training
  writer должен дождаться task status. Для полного self-hosted deployment потребуются storage,
  vector index, LLM/VLM и мониторинг очереди.

## Открытые вопросы

- Поддерживает ли выбранный release SDK явные custom memory writes с metadata, или для них нужен
  прямой REST endpoint?
- Какая схема URI изолирует production, training и evaluation без использования agent-driven
  auto-memory?
- Нужны ли Loci L0/L1 summaries и VLM extraction, или достаточно хранить text notes как L2?

## Источники

1. [OpenViking API overview](https://docs.openviking.ai/en/api/01-overview) — HTTP mode и TypeScript SDK.
2. [Context types](https://docs.openviking.ai/en/concepts/02-context-types) — memory/resource/skill и scopes.
3. [Context layers](https://docs.openviking.ai/en/concepts/03-context-layers) — L0/L1/L2 и мультимодальная обработка.
4. [Retrieval mechanism](https://docs.openviking.ai/en/concepts/07-retrieval) — find/search и hierarchical retrieval.
5. [Session management](https://docs.openviking.ai/en/concepts/08-session) — commit, async extraction и memory diff.
6. [OpenViking repository](https://github.com/volcengine/OpenViking) — self-hosted server и лицензия.
