---
type: Research
title: "Memobase: profile и temporal event memory"
description: Исследование Memobase как настраиваемого user-profile backend с событиями, TypeScript SDK и асинхронным буфером обработки.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://docs.memobase.io/features/profile/profile
tags: [memory, memobase, profile, events, temporal, typescript, research]
---

# Memobase: profile и temporal event memory

## Краткий вывод

Memobase строит память вокруг двух сущностей: компактного настраиваемого user profile и
хронологических user events. Profile slots задаются темами и подтемами, а события сохраняют
summary, profile delta, tags и `created_at`. Это не универсальный knowledge graph, но удобный
вариант для проверки гипотезы «географические cues лучше хранить как типизированные категории и
историю наблюдений».

## Модель и API

Схема профиля конфигурируется через `config.yaml` или project API: можно добавить собственные
topics/subtopics либо полностью заменить default slots. `profile()` возвращает структурированный
JSON, `event()` — события, а `context()` собирает prompt-ready строку из profile и релевантных
events. Для `chats_str` система делает semantic filtering событий и может ограничить окно по
токенам, темам и датам.

```ts
import { MemoBaseClient, Blob, BlobType } from "@memobase/memobase";

const client = new MemoBaseClient(
  process.env.MEMOBASE_PROJECT_URL!,
  process.env.MEMOBASE_API_KEY!,
);

const user = await client.getOrCreateUser("loci-training");
const blobId = await user.insert(Blob.parse({
  type: BlobType.Enum.chat,
  messages: [{
    role: "user",
    content: "Concrete utility poles were useful for this location distinction.",
  }],
}));
await user.flush(BlobType.Enum.chat);
const profile = await user.profile(2000);
const events = await user.event(5, 1000);
```

В актуальном TypeScript README поверхность и имена аргументов могут отличаться от REST
snake_case. Нужны pin версии `@memobase/memobase` и contract test против конкретного сервера.

## Развёртывание и fit для Loci

- Есть open-source/self-hosted server, Cloud и SDK для Python, TypeScript/JavaScript и Go.
- Batch buffer снижает стоимость extraction, но делает видимость памяти eventual-consistent:
  flush запускается автоматически по размеру/idle timeout или вручную, а `flush(sync=true)` ждёт
  завершения.
- Registry может связать `memory_snapshot_id` с Memobase project/user. `created_at` и metadata дают
  путь для timeline, однако обязательный DTO Loci придётся собирать поверх profile/event API.
- Основное ограничение — Memobase оптимизирован под сведения о пользователе. Для набора
  географических заметок нужно спроектировать custom profile slots и проверить, не теряет ли
  extraction факты, которые не являются user attributes. `context()` также возвращает готовую
  строку, а не только raw notes.

## Открытые вопросы

- Можно ли выразить taxonomy Loci (`cue`, `region`, `alternative`, `confidence`) без перегрузки
  profile slots?
- Сохраняются ли metadata и исходные event IDs во всех путях `profile`, `event` и `context`?
- Какой flush/latency режим нужен, чтобы следующая training sample видела только что записанную
  заметку?

## Источники

1. [Profile fundamentals](https://docs.memobase.io/features/profile/profile) — profile slots и custom schema.
2. [Event fundamentals](https://docs.memobase.io/features/event/event) — event fields и timeline.
3. [Context API](https://docs.memobase.io/api-reference/prompt/get_context) — filtering, tokens и event retrieval.
4. [Asynchronous operations](https://docs.memobase.io/features/async_insert) — insert/flush и consistency.
5. [Memobase TypeScript SDK](https://github.com/memodb-io/memobase/tree/main/src/client/memobase-ts) — npm package и client surface.
