---
type: Research
title: "Amazon Bedrock AgentCore Memory: managed event-to-memory service"
description: Исследование Amazon Bedrock AgentCore Memory как managed short-term и long-term backend с namespaces, strategies и TypeScript AWS SDK.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
tags: [memory, aws, agentcore, managed, namespaces, typescript, research]
---

# Amazon Bedrock AgentCore Memory: managed event-to-memory service

## Краткий вывод

AgentCore Memory — managed AWS service с raw short-term events и извлечёнными long-term records.
Long-term слой включается через strategies: semantic, summarization, user-preference, episodic
или custom. Это production-oriented cloud baseline для Loci, если допустимы AWS dependency,
managed storage и серверная LLM extraction.

## Модель и API

Events привязаны к `memoryId`, `actorId` и `sessionId`. Стратегии размещают записи в namespace
paths; `RetrieveMemoryRecords` ищет по semantic query и namespace/namespace path. Можно добавлять
metadata и indexed keys для application-side filtering. Создание события и извлечение long-term
record — разные этапы, поэтому запись не обязана быть сразу видна в retrieval.

Для TypeScript доступны AWS SDK v3 clients и официальный TypeScript integration layer для Strands.
Низкоуровневый путь для Loci должен напрямую вызывать `CreateEvent`/`RetrieveMemoryRecords` и
внешне ограничивать write permissions:

```ts
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
await client.send(new CreateEventCommand({
  memoryId: process.env.AGENTCORE_MEMORY_ID!,
  actorId: "loci-training",
  sessionId: "train-2026-08-27:sample-0042",
  clientToken: "train-2026-08-27:sample-0042",
  eventTimestamp: Date.now(),
  payload: [{
    conversational: {
      role: "USER",
      content: { text: "Concrete utility poles are a useful location cue." },
    },
  }],
}));

const result = await client.send(new RetrieveMemoryRecordsCommand({
  memoryId: process.env.AGENTCORE_MEMORY_ID!,
  namespace: "loci/loci-training/facts",
  searchCriteria: { searchQuery: "concrete utility poles", topK: 5 },
}));
```

Фактические поля command input и namespace templates нужно брать из версии AWS SDK, которую мы
зафиксируем; пример показывает границу, а не готовый Loci adapter.

## Развёртывание и fit для Loci

- Не требуется отдельная база или extraction worker: storage, strategy processing и retrieval
  managed AWS. Есть IAM, CloudWatch и integration с AgentCore/Strands.
- `memoryId` естественно становится registry binding, `actorId` — scope dataset/project,
  `sessionId` — attempt. Metadata/indexed keys могут хранить provider note IDs, но выдачу raw note
  и порядок processing нужно проверить на реальном response.
- AWS service поддерживает automatic expiration и namespace isolation; это полезно для cleanup,
  но provider retention не равен Loci snapshot/version semantics.
- Главные риски — eventual consistency, стоимость event/record/retrieval, AWS lock-in и то, что
  встроенные strategies извлекают derived records вместо сохранения канонической заметки. Для
  Loci нужны отдельные IAM roles для training writer и inference reader.

## Открытые вопросы

- Можно ли получить из `RetrieveMemoryRecords` стабильный raw record с provider ID и content,
  достаточный для нашего DTO?
- Какая strategy/custom strategy лучше сохраняет короткие географические notes без обобщения?
- Какой polling и retry policy нужен после `CreateEvent`, чтобы training sample не читала
  незавершённую ingestion?

## Источники

1. [AgentCore Memory overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) — short-term/long-term модель.
2. [How AgentCore Memory works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/how-it-works.html) — strategies и namespaces.
3. [Retrieve memory records](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-retrieve-records.html) — semantic retrieval и required scope.
4. [Metadata for long-term memories](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-memory-metadata.html) — indexed metadata filters.
5. [AgentCore TypeScript SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript/blob/main/docs/MEMORY.md) — TypeScript/Strands integration и consistency notes.
