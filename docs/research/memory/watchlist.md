---
type: Research
title: "Watchlist: emerging agent memory systems"
description: Краткий watchlist новых memory OS и multimodal-проектов, которые стоит проверить в отдельном пилоте после стабилизации основного shortlist.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://github.com/MemTensor/MemOS
tags: [memory, watchlist, multimodal, memory-os, research]
---

# Watchlist: emerging agent memory systems

Эти проекты заслуживают внимания, но пока не поднимаются в основной shortlist из-за зрелости,
неполной TypeScript-поверхности или сильной ориентации на конкретный agent harness.

| Решение | Почему интересно | Почему пока watchlist |
|---|---|---|
| [MemOS](https://github.com/MemTensor/MemOS) | Memory OS с multi-modal memory, composable MemCubes, unified add/retrieve/edit/delete API, async scheduler и REST/MCP. | Core-путь в основном Python; полноценный deployment заметно тяжелее обычного backend; нужно отдельно проверить стабильность API и provenance. |
| [MIRIX](https://github.com/Mirix-AI/MIRIX) | Шесть типов памяти, text/image/voice/screen input, PostgreSQL/SQLite, BM25 + vector search; наиболее близок к визуальной памяти Loci. | Основная официальная поверхность — Python; current main только с v0.1.6 стал pure memory API, поэтому нужен отдельный pilot и security review. |
| [ReMe](https://github.com/agentscope-ai/ReMe) | Local-first file/vector memory, Markdown nodes, HTTP/MCP service, observable Studio и опубликованный shared TypeScript client. | Сильнее ориентирован на coding-agent/context management, чем на универсальный memory backend; extraction и embeddings требуют отдельной настройки. |
| [EverMemOS](https://github.com/NetMindAI-Open/EverMemOS) | Self-organizing memory OS с episodes, profiles, structured extraction, REST API и поддержкой vector/search backends. | Python/Docker-heavy integration и пока мало доказательств стабильности для Loci DTO; benchmark claims нужно воспроизводить самостоятельно. |

## Критерий перехода в основной список

Кандидат следует поднять из watchlist после минимального пилота: explicit write после `reveal`,
read-only retrieval с `limit`, сохранение `source_attempt_id`, повторяемость после retry,
изоляция двух memory bindings и измеримая задержка до видимости новой заметки.

## Источники

1. [MemOS repository](https://github.com/MemTensor/MemOS) — memory OS, MemCubes, multimodal и REST deployment.
2. [MIRIX documentation](https://docs.mirix.io/) — memory components, local storage и search.
3. [MIRIX repository](https://github.com/Mirix-AI/MIRIX) — current pure memory API и client surface.
4. [ReMe repository](https://github.com/agentscope-ai/ReMe) — file/vector memory, HTTP/MCP и TypeScript package.
5. [EverMemOS repository](https://github.com/NetMindAI-Open/EverMemOS) — architecture, API, deployment и evaluation.
