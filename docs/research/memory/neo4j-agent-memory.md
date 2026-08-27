---
type: Research
title: "Neo4j Agent Memory: граф, provenance и geospatial retrieval"
description: Исследование Neo4j Agent Memory как graph-native memory system с TypeScript SDK, hosted service и временно-географическими сущностями.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://github.com/neo4j-labs/agent-memory
tags: [memory, neo4j, graph, geospatial, temporal, provenance, typescript, research]
---

# Neo4j Agent Memory: граф, provenance и geospatial retrieval

## Краткий вывод

Neo4j Agent Memory — graph-native memory system с тремя слоями: short-term conversations,
long-term facts/preferences/entities и reasoning traces. В отличие от обычного vector memory,
система моделирует сущности и связи, хранит provenance и поддерживает temporal и geospatial
queries. Для Loci это самый прямой путь проверить память, в которой `Location`, `Cue`, `Country`
и `Attempt` являются связанными объектами.

## Модель и API

Проект использует POLE+O-ориентированную схему (Person, Object, Location, Event, Organization с
подтипами), extraction с entity resolution и hybrid vector + graph search. Сообщения связываются
с extracted entities и extractor provenance; отношения могут иметь valid/invalid time. Есть
short-term, long-term и reasoning clients, а hosted Neo4j Agent Memory Service доступен через
REST.

```ts
import { MemoryClient } from "@neo4j-labs/agent-memory";

const client = new MemoryClient({
  endpoint: "https://memory.neo4jlabs.com/v1",
  apiKey: process.env.MEMORY_API_KEY,
});

const conversation = await client.shortTerm.createConversation({
  userId: "loci-training",
});

await client.shortTerm.addMessage(
  conversation.id,
  "user",
  "Concrete utility poles distinguish this region from the red-soil alternative.",
);

const ctx = await client.shortTerm.getContext(conversation.id);
const results = ctx.observations;
```

Точные имена методов поиска и возможности hosted backend нужно фиксировать вместе с версией
SDK: проект предоставляет отдельные short-term, long-term и reasoning surfaces, а часть более
глубоких операций доступна только в NAMS или local Bolt backend.

## Развёртывание и fit для Loci

- TypeScript пакет `@neo4j-labs/agent-memory` поддерживает hosted NAMS REST и локальный Neo4j
  backend; есть MCP и integrations для Vercel AI SDK, LangChain JS, Mastra и Strands.
- `Location` nodes, temporal relations и provenance хорошо совпадают с задачами geolocation. Для
  Loci можно хранить краткую заметку как message/observation, а `source_attempt_id` — как
  metadata и внешний ledger ID.
- Registry сопоставляет `memory_snapshot_id` с workspace/endpoint/graph. Для inference следует
  выдавать read-only search и provenance, а entity mutation и extraction включать только в
  training writer.
- Это проект Neo4j Labs без SLA и гарантий обратной совместимости. Нужны Neo4j/hosted service,
  контроль entity resolution и защита от memory poisoning через повторное связывание одинаковых
  имён из разных пользователей.

## Открытые вопросы

- Даст ли graph model измеримое преимущество на наших location cues по сравнению с Hindsight или
  обычным hybrid retrieval?
- Какая версия и какой backend поддерживают стабильный raw DTO с `source_attempt_id`, а не только
  graph/context view?
- Как разделить curated geography knowledge и новые training notes так, чтобы untrusted input не
  изменял доверенный entity neighborhood?

## Источники

1. [Neo4j Agent Memory repository](https://github.com/neo4j-labs/agent-memory) — модель, extraction, search и deployment.
2. [TypeScript SDK README](https://github.com/neo4j-labs/agent-memory/blob/main/typescript/README.md) — npm surface и hosted client.
3. [Neo4j Agent Memory TCK](https://github.com/neo4j-labs/agent-memory-tck) — REST backend, memory tiers и conformance surface.
4. [Lenny's Memory example](https://github.com/neo4j-labs/agent-memory/tree/main/examples/lennys-memory) — graph, provenance и memory API.
5. [Cross-user graph-memory poisoning issue](https://github.com/neo4j-labs/agent-memory/issues/155) — пример security-рискa, который нужно проверить в конфигурации.
