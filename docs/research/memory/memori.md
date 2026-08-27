---
type: Research
title: "Memori: agent-native memory с attribution и trace"
description: Исследование MemoriLabs как memory infrastructure, извлекающей факты, события и agent execution traces с TypeScript SDK и BYODB.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://memorilabs.ai/docs/memori-cloud/concepts/architecture/
tags: [memory, memori, agent-trace, attribution, typescript, self-hosted, research]
---

# Memori: agent-native memory с attribution и trace

## Краткий вывод

MemoriLabs собирает память не только из текста диалогов, но и из agent execution: tool calls,
решений, исходов и ошибок. Память привязывается к `entity_id`, `process_id` и `session_id`, а
факты извлекаются и индексируются асинхронно. Это особенно интересно для Loci, если в память нужно
помещать не только cue, но и опыт того, какой retrieval или workflow сработал.

## Модель и API

В Cloud SDK основной путь — зарегистрировать LLM client через `llm.register()`: Memori захватывает
сообщения, выполняет Advanced Augmentation и позже добавляет facts, preferences, skills, rules,
events и trace/execution memories. Есть manual `recall(query, limit)`, который возвращает
`id`, `content`, similarity, rank и дату; automatic recall по умолчанию сам инжектирует найденное
в следующий LLM call.

```ts
import OpenAI from "openai";
import { Memori } from "@memorilabs/memori";

const client = new OpenAI();
const mem = new Memori().llm.register(client);
mem.attribution("loci-training", "loci-agent");

const facts = await mem.recall("concrete poles versus red soil", { limit: 5 });
```

Для локального/BYODB режима используется тот же SDK с database connection; Cloud и BYODB имеют
разные operational guarantees. `augmentation.wait()` нужен, если процесс завершается сразу после
записи и следующий шаг должен читать результат.

## Развёртывание и fit для Loci

- Есть `@memorilabs/memori` для TypeScript, Python SDK, Cloud и BYODB с SQLite/PostgreSQL и
  другими SQL-compatible integrations. Локальный Rust core используется для части TS/Python путей.
- Attribution хорошо отображает provider scope: `entity_id` может быть Loci project, а
  `process_id` — версия inference/training workflow. Manual `recall` ближе к Loci retrieval,
  чем автоматическая инъекция.
- Основной write path — автоматический capture разговоров/трейсов. Для строгого правила Loci
  «записывать только после reveal» потребуется отдельный training writer и отключение capture на
  inference; внешнее operation ledger всё равно нужно для idempotency.
- Cloud augmentation и recall асинхронны, а structured memory и graph triples являются derived
  представлением. Нельзя считать их безусловно равными исходной заметке или доказательству.

## Открытые вопросы

- Есть ли стабильный low-level write API для одиночной `memory_note`, или Loci придётся отправлять
  synthetic conversation/trace?
- Как связать manual recall с внешним audit ledger без потери attribution?
- Насколько BYODB сохраняет равенство Cloud surface, особенно для TS SDK и background augmentation?

## Источники

1. [Memori architecture](https://memorilabs.ai/docs/memori-cloud/concepts/architecture/) — capture, attribution, augmentation и recall.
2. [How Memori works](https://memorilabs.ai/docs/memori-cloud/concepts/how-memory-works/) — memory types и manual/automatic recall.
3. [TypeScript quickstart](https://memorilabs.ai/docs/memori-cloud/getting-started/typescript-quickstart/) — npm package и SDK usage.
4. [BYODB architecture](https://memorilabs.ai/docs/memori-byodb/concepts/how-memory-works/) — local database и async lifecycle.
5. [Memori repository](https://github.com/MemoriLabs/Memori) — TypeScript SDK, Python SDK и license/source status.
