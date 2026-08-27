# Research

Срез официальных материалов на 2026-08-27. В отчётах отдельно отмечены наличие TypeScript SDK,
границы автоматической записи и пригодность системы как внешнего memory backend для Loci.

Для сравнения используем целевые ограничения текущего Loci: [memory_store](/tools/memory_store.md)
записывает только после `reveal`, а [memory_retrieve](/tools/memory_retrieve.md) читает явно
выбранную систему и возвращает заметки с `source_attempt_id`. Поле `snapshot_id` в этих контрактах
— историческое имя ID привязки к системе памяти, не provider snapshot. Формулировки в разделах Fit
— выводы и варианты интеграции, не принятые архитектурные решения.

| Система | TypeScript surface | Основная модель | Главный риск для Loci |
|---|---|---|---|
| [Mem0](mem0.md) | `mem0ai` OSS/Platform | Извлечённые факты + vector/entity retrieval | Scope mapping, async visibility и различия OSS/Platform |
| [LangMem](langmem.md) | Официального SDK нет; LangGraph JS Store | Extraction managers поверх `BaseStore` | Нет TS extraction; нужно отделить Store от write policy |
| [Zep Cloud](zep.md) | `@getzep/zep-cloud` | User-level temporal context graph | Generated context, async ingestion и managed access |
| [Graphiti](graphiti.md) | Нативного SDK нет; REST/MCP | OSS temporal graph с episodes/provenance | Python/DB эксплуатация и сетевой integration boundary |
| [Letta](letta.md) | `@letta-ai/letta-client` | Agent-managed blocks + archival passages | Агент сам меняет память в inference |
| [Cognee](cognee.md) | `@cognee/cognee-ts` | Relational + vector + graph, session bridge | Native TS binding, indexing и generated retrieval |
| [Supermemory](supermemory.md) | `supermemory` | Fact-based temporal vector graph + profiles | Automatic updates/forgetting и API version drift |
| [xmemory](xmemory.md) | `xmemory` | XMD schema + typed objects/relations | Service access, credentials и schema-fit для notes |

* [Mem0: API и пригодность для внешней памяти Loci](mem0.md) - TypeScript memory layer с extraction, scopes и semantic retrieval.
* [LangMem: инструменты памяти для LangGraph](langmem.md) - Python-only memory managers и TypeScript-путь через LangGraph Store.
* [Zep Cloud: темпоральная память и TypeScript SDK](zep.md) - Managed user-level context graph с session API.
* [Graphiti: open-source temporal knowledge graph](graphiti.md) - OSS temporal graph core и граница между Python, REST и MCP.
* [Letta: agent-managed tiered memory](letta.md) - Stateful agent runtime с blocks и archival passages.
* [Cognee: graph-native memory с session bridge](cognee.md) - Graph/vector/relational memory и Node.js bindings.
* [Supermemory: fact-based temporal vector graph](supermemory.md) - TypeScript SDK, profiles и evolving memory graph.
* [xmemory: schema-grounded memory engine](xmemory.md) - XMD, typed mutations, migrations и TypeScript data/admin API.
