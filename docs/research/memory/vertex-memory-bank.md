---
type: Research
title: "Google Agent Platform Memory Bank: managed scoped memory"
description: Исследование Google Agent Platform Memory Bank как managed memory с multimodal generation, revisions, TTL и REST/Python API.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank
tags: [memory, google-cloud, memory-bank, multimodal, revisions, managed, research]
---

# Google Agent Platform Memory Bank: managed scoped memory

## Краткий вывод

Memory Bank — managed storage, который генерирует и поддерживает long-term memories из session
events или заранее подготовленного содержимого. У него есть identity scopes, customizable
extraction topics/few-shot examples, multimodal understanding, similarity retrieval, TTL и
memory revisions. Это сильный cloud reference для Loci, особенно если фотографии должны участвовать
в формировании текстовых memory insights.

## Модель и API

Каждая memory — независимый self-contained fact с `scope`, например `agent_name + user`. Поток
может быть session-based (`CreateSession`, `AppendEvent`, `GenerateMemories`) или прямым через
`CreateMemory`; `RetrieveMemories` возвращает все либо релевантные записи. Generated memories
consolidate с существующими, а revisions позволяют посмотреть, как запись менялась со временем.

Официальный quickstart сейчас показывает Python `vertexai` SDK и REST API; отдельного официального
TypeScript memory SDK в проверенных материалах нет. Из Node.js придётся обращаться к REST API и
самостоятельно поддерживать DTO/error mapping.

```text
scope: { agent_name: "loci", user: "training" }
fact: "Concrete utility poles are more discriminative than red soil for this comparison."
```

## Развёртывание и fit для Loci

- Storage и model-backed generation полностью managed; доступ регулируется IAM, scope и
  региональными настройками. Поддерживаются revisions, TTL и retrieval из разных runtime.
- Multimodal understanding может принимать текст/изображение на пути GenerateMemories и сохранять
  текстовый insight. Это полезно для эксперимента с visual cues, но provider сам выбирает, какую
  информацию извлечь.
- `memory_bank` instance становится binding, scope — dataset/project, а `CreateMemory` после
  reveal — training write. Для inference нужны только memory viewer/retrieve permissions.
- Ограничения — GCP/Gemini coupling, REST вместо native TS, asynchronous generation и риск того,
  что generated fact потеряет точную формулировку исходной заметки. Memory Bank не заменяет внешний
  audit ledger и raw note store.

## Открытые вопросы

- Достаточно ли REST response/revision IDs для внешнего аудита и воспроизводимого evaluation?
- Сохраняются ли изображения или только generated textual insights, и где выполняется ML processing
  для выбранного региона?
- Как сравнить Memory Bank с self-hosted multimodal candidate на одном наборе фотографий и notes?

## Источники

1. [Memory Bank overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank) — scopes, multimodal generation, TTL и revisions.
2. [Memory Bank API quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/api-quickstart) — REST/Python flow и direct API.
3. [Generate memories](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/generate-memories) — extraction и consolidation.
4. [Fetch memories](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/fetch-memories) — retrieval surface.
5. [Memory revisions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/revisions) — history of generated memories.
