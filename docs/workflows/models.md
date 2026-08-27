---
type: Model Catalog
title: Общие модели Loci
description: Общие структуры данных, используемые несколькими workflow и tool-контрактами Loci.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, models, contracts, workflow]
---

# Общие модели Loci

Здесь определены только модели, используемые несколькими документами. Request и result одного
инструмента остаются в его tool contract, а модели конкретного workflow — в соответствующем
workflow.

## Runner config

```text
runner_config
  runner_config_id
  model_id
  prompt_id
  preprocessing_id
  generation_config
  memory_retriever_id
  geocoder_id
  tool_budget
    max_duration_ms
    max_memory_calls
    max_geocoder_calls
  retry_policy
    max_sample_attempts
    max_store_attempts
  content_hash
```

Runner config неизменяем. Любое изменение поля создаёт новый `runner_config_id` и `content_hash`.
Workflow передаёт только ID, а оркестратор разрешает его в полную конфигурацию.
`memory_retriever_id` выбирает код адаптера retrieval, а `memory_snapshot_id` в конкретном
workflow выбирает его registry-привязку к provider и instance.

## Corpus manifest

```text
corpus_manifest
  corpus_ref
  content_hash
  samples[]
    sample_id
    data_group_id
    image_ref
    ground_truth
```

Порядок `samples` входит в `content_hash`. `data_group_id` объединяет одну локацию, capture
session, кампанию съёмки и близкие дубликаты. Одна группа не может одновременно находиться в train
и eval.

## Ground truth

Ground truth содержит только необходимые для scoring координаты:

```text
ground_truth
  latitude
  longitude
```

Ground truth хранится в закрытом контексте оркестратора и передаётся агенту только после reveal в
training. В evaluation его получает только scorer после фиксации ответа.

## Location candidate

```text
location_candidate
  display_name
  latitude | null
  longitude | null
  type | null
```

`type` — необязательная строка провайдера. Координаты могут отсутствовать, если геокодер не вернул
точку.

## Memory notes

До записи training создаёт:

```text
memory_note_input
  content
```

После [`memory_store`](../tools/memory_store.md) заметка имеет provenance:

```text
memory_note
  note_id
  source_attempt_id
  content
```

## Memory binding identifier

`memory_snapshot_id` — историческое имя поля для opaque ID привязки к выбранной системе памяти.
Оркестратор разрешает его через конфигурацию в конкретный provider и instance (например, xmemory
instance, Cognee dataset или Mem0 tenant). Это не версия содержимого и не provider snapshot:
системе памяти не нужны операции создания, переключения, клонирования или rollback snapshots.

Одна привязка фиксируется на время workflow. Сменить её можно только изменением конфигурации между
запусками. `null` означает отсутствие memory binding.

Оркестратор хранит registry привязок вне memory provider:

```text
memory_binding
  snapshot_id       # opaque ID, который видит workflow
  provider          # xmemory | cognee | mem0 | ...
  instance_ref      # instance / dataset / namespace провайдера
  access_policy
```

Например, `memory-binding-xmemory-prod` может указывать на один xmemory instance, а
`memory-binding-cognee-prod` — на dataset Cognee. Эти записи выбираются конфигурацией сервиса;
провайдер не обязан знать или поддерживать поле `snapshot_id`.

## Memory call

```text
memory_call
  request — memory_retrieve
  result — memory_retrieve_result | null
  error — invalid_request | memory_not_found | memory_mismatch | unavailable | timeout | null
```

Request и result определены в [`memory_retrieve`](../tools/memory_retrieve.md). Успешный вызов имеет
`error: null`; неуспешный — `result: null` и ненулевой `error`.

## Geocode call

```text
geocode_call
  tool — geocode_search | geocode_reverse
  request — geocode_search | geocode_reverse
  result — geocode_search_result | geocode_reverse_result | null
  error — invalid_request | rate_limited | unavailable | timeout | null
```

Request и result определены в [`geocode_search`](../tools/geocode_search.md) и
[`geocode_reverse`](../tools/geocode_reverse.md). Успешный вызов имеет `error: null`; неуспешный —
`result: null` и ненулевой `error`.

## Answer snapshot

```text
answer_snapshot
  request_id
  runner_config_id
  memory_snapshot_id | null  # ID memory binding; историческое имя поля
  status — located | ambiguous | insufficient_evidence
  location — location_candidate | null
  alternatives[] — location_candidate
  explanation
  limitations[]
  memory_calls[] — memory_call
  geocode_calls[] — geocode_call
```

`answer_snapshot` создаёт [слепая геолокация](locate.md) до любого доступа к ground truth.
После создания answer snapshot не изменяется. Это snapshot аудита ответа, не snapshot внешней
системы памяти.

| Status | `location` | `alternatives` |
|---|---|---|
| `located` | Обязателен. | Может быть пустым или содержать вторичные варианты. |
| `ambiguous` | Обязателен как top-1 для scoring. | Содержит минимум один существенный вариант. |
| `insufficient_evidence` | `null`. | Пустой массив. |

Публичные поля inference: `request_id`, `status`, `location`, `alternatives`, `explanation` и
`limitations`. `runner_config_id`, `memory_snapshot_id`, `memory_calls` и `geocode_calls` остаются
внутренними.
