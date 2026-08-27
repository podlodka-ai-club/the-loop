---
type: Research
title: "Honcho: peer-centric memory с background reasoning"
description: Исследование Honcho как temporal memory library, которая моделирует пользователей, агентов и другие сущности через peers и sessions.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://honcho.dev/docs/v3/documentation/introduction/overview
tags: [memory, honcho, reasoning, temporal, typescript, research]
---

# Honcho: peer-centric memory с background reasoning

## Краткий вывод

Honcho хранит сообщения и события в sessions, связывает их с peer-ами и в фоне строит
representations/conclusions о том, что одна сущность знает о другой. Это более широкая модель,
чем user profile: peer может быть человеком, агентом, группой, проектом или идеей. Для Loci это
интересно, если память должна моделировать не только cue, но и изменяющиеся связи между местом,
гипотезой, попыткой и агентом.

## Модель и API

Основные объекты — workspace, peer, session и message. Сообщение имеет ID, timestamp и metadata;
добавление сообщения запускает background derivation, если reasoning не отключён. Для чтения есть
несколько уровней:

- `session.search()` — raw messages и их metadata;
- `peer.representation()` — отфильтрованные conclusions с semantic search;
- `peer.context()`/`session.context()` — prompt-ready context;
- `peer.chat()` — reasoned answer, который не является каноническим DTO памяти.

```ts
import { Honcho } from "@honcho-ai/sdk";

const honcho = new Honcho({
  workspaceId: "loci",
  apiKey: process.env.HONCHO_API_KEY,
  environment: "production",
});

const learner = await honcho.peer("loci-agent");
const session = await honcho.session("train-2026-08-27:sample-0042");

await session.addMessages([
  learner.message("Concrete poles are a useful cue in this region."),
]);

const hits = await session.search("concrete utility poles", { limit: 5 });
```

Representations могут быть глобальными, session-scoped или перспективными: например, что один
peer знает о другом. Это полезно для multi-agent memory, но создаёт дополнительную семантику
наблюдателя, которую не требует текущий контракт Loci.

## Развёртывание и fit для Loci

- Есть официальный TypeScript SDK `@honcho-ai/sdk`, REST API, MCP-интеграция, managed service и
  self-hosted FastAPI deployment.
- `created_at` и metadata позволяют импортировать исторические события и сохранять контекст
  сообщения. Batch API допускает до 100 сообщений.
- В Loci `memory_ref` можно связать с workspace/peer/session policy. `session.search()`, context и
  `representation()` являются равноправными native retrieval surfaces для evaluation.
- Основные риски — background LLM reasoning и eventual consistency, а также AGPL-3.0 для
  self-hosted кода. Default peer representations могут смешать контексты, если неверно настроить
  workspace, peer и session scopes.

## Открытые вопросы

- Даёт ли peer-centric graph преимущество на географических training experiences?
- Как отключать derivation на inference и как тестировать отсутствие cross-workspace leakage?
- Какие условия AGPL и hosted service подходят для production deployment Loci?

## Источники

1. [Honcho overview](https://honcho.dev/docs/v3/documentation/introduction/overview) — назначение, managed/self-hosted и общий lifecycle.
2. [SDK reference](https://honcho.dev/docs/v3/documentation/reference/sdk) — TypeScript API, peers, sessions и representations.
3. [Storing data](https://honcho.dev/docs/v3/documentation/features/storing-data) — messages и background derivation.
4. [Get context](https://honcho.dev/docs/v3/documentation/features/get-context) — raw/session context и semantic filtering.
5. [Honcho repository](https://github.com/plastic-labs/honcho) — исходный код, SDK и лицензия.
