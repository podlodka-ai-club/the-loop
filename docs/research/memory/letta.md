---
type: Research
title: "Letta: agent-managed tiered memory"
description: Исследование Letta runtime, memory blocks, archival passages и официального TypeScript SDK.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.letta.com/api/typescript
tags: [memory, letta, memgpt, agent-runtime, typescript, research]
---

# Letta: agent-managed tiered memory

## Краткий вывод

Letta (бывший MemGPT) — не только хранилище, а runtime stateful agent. Модель управляет
контекстом через tools: постоянно видимые `memory blocks` образуют core memory, а archival
memory хранит searchable passages вне context window. Это максимально близко к agent-managed
memory, но наименее детерминировано для Loci: агент может менять память в ходе inference.

## Архитектура

Официальная модель описывает:

- in-context persistent blocks (`human`, `persona`, organization и т.п.);
- out-of-context archival passages с embeddings и поиском;
- бесконечную историю сообщений, которую агент может свернуть/искать;
- shared blocks, прикрепляемые нескольким агентам;
- sleep-time agents для фоновой работы с общей памятью.

Таким образом, retrieval и write policy являются частью поведения агента, а не только внешнего
CRUD-сервиса.

## TypeScript API

```ts
import Letta from "@letta-ai/letta-client";

const client = new Letta({ apiKey: process.env.LETTA_API_KEY });
const agent = await client.agents.create({
  model: "openai/gpt-4.1",
  embedding: "openai/text-embedding-3-small",
  memory_blocks: [
    { label: "human", value: "The user prefers concise answers." },
    { label: "persona", value: "I am a helpful assistant." },
  ],
});

await client.agents.messages.create(agent.id, {
  input: "Remember that I prefer metric units.",
});

await client.agents.blocks.update("human", {
  agent_id: agent.id,
  value: "The user prefers concise answers and metric units.",
});
const block = await client.agents.blocks.retrieve("human", { agent_id: agent.id });

const passage = await client.agents.passages.create(agent.id, {
  text: "Red soil alone is not a reliable country cue.",
  tags: ["geolocation"],
});
const hits = await client.agents.passages.search(agent.id, {
  query: "red soil country cue",
});
await client.agents.passages.delete(passage.id!, { agent_id: agent.id });
```

Для общей архивной памяти есть `client.archives.create`, `client.archives.passages.create` и
`createMany`; архив можно attach/detach к нескольким агентам. SDK экспортирует типы запросов,
например `Letta.CreateAgentRequest`, и `LettaError`. Поддерживаются retries, timeouts, SSE
streaming и `baseURL` для self-hosted сервера.

## Fit для Loci

Плюсы — готовые typed blocks/passages, shared memory и self-hosted deployment; archival passages
можно использовать как backend для `memory_retrieve`, а Loci `memory_snapshot_id` связать с
agent/archive ID в registry. Для locate/evaluation используются read-only credentials и отдельный
training writer; agent messages/tools не должны напрямую менять память во время blind solve.
Provenance `source_attempt_id` также добавляется интеграционным tool/worker.

Если нужен самостоятельный долгоживущий геолокационный агент, Letta предоставляет готовый
agent-managed runtime. Если нужен только внешний read-only retrieval с контролируемым обучением,
его opinionated runtime может создать лишнюю связанность.

## Открытые вопросы

- Разрешаем ли мы агенту Loci редактировать `memory blocks` во время inference, или все записи
  должны проходить только через training tool?
- Какой Letta agent/archive ID станет значением registry для Loci `memory_snapshot_id`, и как передавать
  `source_attempt_id` в passage metadata?
- Можно ли отключить или ограничить agent tools, чтобы inference не изменял память, а training
  запись выполнялась отдельным разрешённым tool?

## Источники

1. [Letta TypeScript SDK](https://docs.letta.com/api/typescript) — установка, agent/message API и memory concepts.
2. [Blocks TypeScript reference](https://docs.letta.com/api/typescript/resources/agents/subresources/blocks) — CRUD и attach/detach blocks.
3. [Passages TypeScript reference](https://docs.letta.com/api/typescript/resources/agents/subresources/passages) — archival list/create/search/delete.
4. [Archives reference](https://docs.letta.com/api/typescript/resources/archives) — общие архивы и vector providers.
5. [Letta Node SDK repository](https://github.com/letta-ai/letta-node) — TypeScript types, streaming и self-hosted configuration.
