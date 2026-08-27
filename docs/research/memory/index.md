# Research

Срез официальных материалов на 2026-08-27. В отчётах отдельно отмечены наличие TypeScript SDK,
границы автоматической записи и пригодность системы как внешнего memory backend для Loci.

Поиск расширил основной список восемью кандидатами: Hindsight, Honcho, OpenViking, Neo4j Agent
Memory, Memobase, Memori, Amazon Bedrock AgentCore Memory и Google Agent Platform Memory Bank.
Первые четыре наиболее интересны для self-hosted или graph/file-based пилота; два Memory Bank —
отдельная cloud baseline; Memobase и Memori требуют проверки того, насколько их user/agent-centric
модель подходит для географических training experiences. Более ранние и harness-oriented проекты собраны
в [watchlist](/research/memory/watchlist.md).

Для сравнения используем целевые ограничения текущего Loci: [memory_store](/tools/memory_store.md)
после `reveal` передаёт выбранной системе свободное Markdown-описание обучающего эпизода, а
[memory_retrieve](/tools/memory_retrieve.md) возвращает provider-native payload без общей модели
memory items. `memory_ref` указывает на настроенный provider и его instance/bank/scope. Формулировки
в разделах Fit — выводы и варианты интеграции, не принятые архитектурные решения.

| Система | Статус | TypeScript surface | Основная модель | Главный риск для Loci |
|---|---|---|---|---|
| [Mem0](mem0.md) | База | `mem0ai` OSS/Platform | Извлечённые факты + vector/entity retrieval | Scope mapping, async visibility и различия OSS/Platform |
| [LangMem](langmem.md) | База | Официального SDK нет; LangGraph JS Store | Extraction managers поверх `BaseStore` | Нет TS extraction; нужно отделить Store от write policy |
| [Zep Cloud](zep.md) | База | `@getzep/zep-cloud` | User-level temporal context graph | Generated context, async ingestion и managed access |
| [Graphiti](graphiti.md) | База | Нативного SDK нет; REST/MCP | OSS temporal graph с episodes/provenance | Python/DB эксплуатация и сетевой integration boundary |
| [Letta](letta.md) | База | `@letta-ai/letta-client` | Agent-managed blocks + archival passages | Агент сам меняет память в inference |
| [Cognee](cognee.md) | База | `@cognee/cognee-ts` | Relational + vector + graph, session bridge | Native TS binding, indexing и generated retrieval |
| [Supermemory](supermemory.md) | База | `supermemory` | Fact-based temporal vector graph + profiles | Automatic updates/forgetting и API version drift |
| [xmemory](xmemory.md) | База | `xmemory` | XMD schema + typed objects/relations | Service access, credentials и качество extraction географического опыта |
| [Hindsight](hindsight.md) | Добавить | `@vectorize-io/hindsight-client` | World/experience/observation facts + temporal hybrid retrieval | Async consolidation, PostgreSQL и выбор raw facts против reflect |
| [Honcho](honcho.md) | Добавить | `@honcho-ai/sdk` | Peer/session/message model + background representations | User-centric semantics, AGPL и generated conclusions |
| [OpenViking](openviking.md) | Добавить | `@openviking/sdk` | Filesystem memory/resources/skills + L0/L1/L2 | Отдельный server, async extraction и custom write boundary |
| [Neo4j Agent Memory](neo4j-agent-memory.md) | Добавить | `@neo4j-labs/agent-memory` | Short/long/reasoning memory в graph + vector store | Labs status, entity resolution и memory poisoning |
| [Memobase](memobase.md) | Добавить | `@memobase/memobase` | Configurable profiles + chronological events | Profile-first модель и buffered async visibility |
| [Memori](memori.md) | Добавить | `@memorilabs/memori` | Facts/preferences/events + agent execution traces | Automatic capture, Cloud/BYODB drift и async augmentation |
| [Amazon Bedrock AgentCore Memory](bedrock-agentcore.md) | Cloud baseline | AWS SDK v3 и TS integrations | Managed events + strategy-derived long-term records | AWS lock-in, cost и eventual consistency |
| [Google Agent Platform Memory Bank](vertex-memory-bank.md) | Cloud baseline | REST/Python; native TS SDK не найден | Managed scoped facts, multimodal generation, revisions и TTL | GCP/Gemini coupling, REST boundary и generated text |

* [Mem0: API и пригодность для внешней памяти Loci](mem0.md) - TypeScript memory layer с extraction, scopes и semantic retrieval.
* [LangMem: инструменты памяти для LangGraph](langmem.md) - Python-only memory managers и TypeScript-путь через LangGraph Store.
* [Zep Cloud: темпоральная память и TypeScript SDK](zep.md) - Managed user-level context graph с session API.
* [Graphiti: open-source temporal knowledge graph](graphiti.md) - OSS temporal graph core и граница между Python, REST и MCP.
* [Letta: agent-managed tiered memory](letta.md) - Stateful agent runtime с blocks и archival passages.
* [Cognee: graph-native memory с session bridge](cognee.md) - Graph/vector/relational memory и Node.js bindings.
* [Supermemory: fact-based temporal vector graph](supermemory.md) - TypeScript SDK, profiles и evolving memory graph.
* [xmemory: schema-grounded memory engine](xmemory.md) - XMD, typed mutations, migrations и TypeScript data/admin API.
* [Hindsight: temporal memory с retain, recall и reflect](hindsight.md) - Hybrid temporal retrieval, evidence-grounded observations и TypeScript client.
* [Honcho: peer-centric memory с background reasoning](honcho.md) - Peers, sessions, representations и TypeScript SDK.
* [OpenViking: context database с filesystem-памятью](openviking.md) - `viking://`, L0/L1/L2, memory diff и TypeScript HTTP SDK.
* [Neo4j Agent Memory: граф, provenance и geospatial retrieval](neo4j-agent-memory.md) - Graph-native short/long/reasoning memory и hosted NAMS.
* [Memobase: profile и temporal event memory](memobase.md) - Настраиваемые profile slots, события и TypeScript REST client.
* [Memori: agent-native memory с attribution и trace](memori.md) - Facts, agent execution traces, manual recall и BYODB.
* [Amazon Bedrock AgentCore Memory: managed event-to-memory service](bedrock-agentcore.md) - AWS-managed short/long-term memory, strategies и namespaces.
* [Google Agent Platform Memory Bank: managed scoped memory](vertex-memory-bank.md) - Scoped facts, multimodal generation, revisions и TTL.
* [Watchlist: emerging agent memory systems](watchlist.md) - MemOS, MIRIX, ReMe и EverMemOS для отдельных пилотов и research reference.
