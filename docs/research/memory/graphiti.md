---
type: Research
title: "Graphiti: open-source temporal knowledge graph"
description: Исследование Graphiti как самостоятельного graph-native движка и его TypeScript-интеграционных границ.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://help.getzep.com/graphiti/getting-started/welcome
tags: [memory, graphiti, temporal-graph, knowledge-graph, typescript, research]
---

# Graphiti: open-source temporal knowledge graph

## Краткий вывод

Graphiti — OSS core для построения динамического temporal knowledge graph, на котором построены
части Zep. Он принимает episodes, извлекает entity nodes и relationship edges, сохраняет
provenance и временные окна, а затем выполняет hybrid semantic + BM25 + graph retrieval.

В официальном репозитории нет нативного TypeScript SDK: установка и основной `Graphiti` API
описаны для Python (`pip install graphiti-core`). Для Node доступны REST-сервис Graphiti, MCP
server или вызовы Zep Cloud; это не то же самое, что in-process TS client.

## Архитектура

Основные сущности:

- `Episode` — исходный текст/JSON с reference time и provenance.
- `EntityNode` — сущность с evolving summary и labels.
- `EntityEdge` — факт/triplet с `valid_at`/`invalid_at`.
- custom entity/edge types — Pydantic-модели, задающие ontology.

Новые episodes интегрируются инкрементально, без batch recomputation. Для retrieval есть edge
hybrid search, node recipes и reranking по graph distance. Graphiti поддерживает Neo4j, FalkorDB и
Amazon Neptune; Kuzu в текущем репозитории помечен deprecated. Лимит параллелизма ingestion
регулируется `SEMAPHORE_LIMIT`.

## API и TypeScript-граница

Канонический core-пример Python выглядит так:

```py
from graphiti_core import Graphiti

graphiti = Graphiti(uri=URI, user=USER, password=PASSWORD)
await graphiti.build_indices_and_constraints()
await graphiti.add_episode(
    name="turn-1",
    episode_body="Jane moved from Boston to Seattle",
    source_description="chat",
    reference_time=datetime.now(timezone.utc),
)
facts = await graphiti.search(query="where does Jane live?", group_id="user-123")
```

Для TypeScript остаются два интеграционных пути:

1. вызывать официальный FastAPI REST service Graphiti из `fetch` и самостоятельно стабилизировать
   DTO/ошибки;
2. использовать Graphiti MCP server с MCP-клиентом.

REST/MCP — дополнительные сервисные границы с собственной аутентификацией, retry и
совместимостью; они не предоставляют типобезопасность core-моделей автоматически. Managed Zep
Cloud — отдельный продукт с собственным TypeScript SDK, описанный в [отчёте Zep](/research/memory/zep.md),
а не TypeScript-обвязка Graphiti.

## Fit для Loci

Graphiti даёт provenance и возможность спросить «что было верно на дату», поэтому может быть
  полезен для исследования temporal geolocation cues. Для Loci registry сопоставляет
  `memory_snapshot_id` с `group_id`/graph, а read-only access layer для inference и
детерминированная выдача заметок вместо LLM-generated answer. Provider episode IDs при
необходимости можно сопоставлять с внешним audit ledger.

Эксплуатационная стоимость выше vector-only store: нужен Neo4j/FalkorDB/Neptune, индексы,
concurrency tuning и мониторинг фоновых LLM вызовов. Для TypeScript-проекта это также означает
сетевой hop либо отдельный Python worker.

## Открытые вопросы

- Какая база (Neo4j, FalkorDB или Neptune) обеспечивает приемлемые стоимость и latency для
  train/eval-корпуса Loci?
- Какой REST/MCP или Python-worker boundary сопоставляет Loci `memory_snapshot_id` с Graphiti `group_id` и
  возвращает нужные raw facts/provenance?
- Какой read-only credential и схема DTO нужны, чтобы inference не мог вызвать Graphiti write?

## Источники

1. [Graphiti welcome](https://help.getzep.com/graphiti/getting-started/welcome) — назначение и incremental temporal graph.
2. [Graphiti repository](https://github.com/getzep/graphiti) — официальные сущности, retrieval и сервисные адаптеры.
3. [Graphiti quickstart](https://help.getzep.com/graphiti/getting-started/quick-start) — установка и backend prerequisites.
4. [Quickstart example](https://github.com/getzep/graphiti/blob/main/examples/quickstart/README.md) — episodes, hybrid search и temporal metadata.
5. [Graphiti MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server) — Node/MCP integration boundary.
