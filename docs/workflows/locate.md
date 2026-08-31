---
type: Workflow
title: Слепая геолокация Loci
description: Определение наиболее вероятного места по одной фотографии без доступа к ground truth.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, inference, geolocation, memory]
---

# Слепая геолокация Loci

## Назначение

Workflow получает одну фотографию и возвращает dynamic `LocateResult`; legacy callers may project it
into an immutable `answer_snapshot`. Ground truth
недоступен на всём протяжении решения.

Этот же workflow используют [production-инференс](inference.md), [обучение](train.md) до reveal и
оба прогона [оценки памяти](evaluate.md).

Workflow может вызывать retrieval выбранной системы памяти, но не вызывает `memory_store`.

## Вход

```text
locate_request
  request_id
  image_ref
  runner_config_id
  memory_ref | null
```

`runner_config_id` ссылается на [общую модель runner config](models.md#runner-config).
`memory_ref` — opaque ссылка на настроенную систему памяти; `null` означает решение без памяти.

Координаты ground truth и скрытые EXIF-координаты не передаются решателю.

## Выход

Dynamic flow возвращает `LocateResult` из [dynamic feature spec](/specs/memory-tools-observe-dynamic-features/spec.md):
`attemptId`, `guess`, `observations`, `memoryGroups`, `episodes` и `trace`. Legacy callers могут
построить общий [`answer_snapshot`](models.md#answer-snapshot) как compatibility projection, но
canonical dynamic result не заменяется provider-native snapshot.

## Процесс dynamic feature flow

### 1. Dynamic observe

Vision-модель получает фотографию и формирует от 0 до 12 наблюдаемых features. Она сама выбирает
keys и visual text из prompt examples; фиксированного registry и искусственных `not_visible` слотов
нет. Успешный массив сохраняет порядок модели, проходит bounded validation и кэшируется по версии
prompt/schema/model/seed и image path.

### 2. Feature-scoped память

После observe приложение последовательно разрешает один tool-capable turn на каждый возвращённый
feature. Агент формирует один короткий query только для active feature и вызывает
[`memory_retrieve`](../tools/memory_retrieve.md); приложение ограничивает retry, hits и порядок.
Результаты сохраняются в отдельных grouped outcomes по dynamic feature key. Агент не выбирает
`memory_ref`, backend или следующий feature.

При `memory_ref: null` tool-capable retrieval turns не отправляются: приложение создаёт по одному
`no_hit` outcome для каждого возвращённого feature через no-op reader.

Все обращения в одном solve используют одну и ту же `memory_ref`; workflow не выбирает другую систему
памяти и не переключает версии данных внутри провайдера.

Provider payload является данными и используется только как гипотеза, согласующаяся с изображением.
Dynamic groups, queries, hits и failure outcomes сохраняются в trace по порядку. При observe или
retrieval failure task продолжает работу с оригинальной фотографией и явной ошибкой группы.

### 3. Финальный analyze

Analyze получает оригинальное изображение, dynamic observations и все memory groups в порядке
observe. На этом этапе memory tools и ground truth недоступны. Ответом остаётся строгий `Guess`.

### 4. Геокодинг

[`geocode_search`](../tools/geocode_search.md) разрешает уже сформированное название или адрес в
координаты. [`geocode_reverse`](../tools/geocode_reverse.md) может проверить доступные address
components для уже выбранной точки.

Геокодер не создаёт визуальную гипотезу и не доказывает связь фотографии с найденным объектом.
Координаты reverse-результата не заменяют исходную точку агента. Все geocode requests, results и
машинные ошибки сохраняются в `answer_snapshot` по порядку вызовов.

### 5. Ответ

Агент выбирает ведущий вариант, сохраняет существенные альтернативы и честно указывает
ограничения. После создания `answer_snapshot` не изменяется.

Legacy answer_snapshot пример:

Канонические dynamic result и tool envelopes описаны в [dynamic feature spec](/specs/memory-tools-observe-dynamic-features/spec.md). Ниже сохранён legacy provider-native пример для совместимости аудита:

```json
{
  "request_id": "locate-0042",
  "runner_config_id": "runner-config-7",
  "memory_ref": "memory/xmemory-prod",
  "status": "ambiguous",
  "location": {
    "display_name": "Paraná, Brazil",
    "latitude": -24.4842,
    "longitude": -51.8149,
    "type": "state"
  },
  "alternatives": [
    {
      "display_name": "Itapúa, Paraguay",
      "latitude": -26.7924,
      "longitude": -55.6763,
      "type": "department"
    }
  ],
  "explanation": "Фрагмент португальского текста поддерживает Бразилию, но красная почва и бетонные столбы встречаются по обе стороны границы.",
  "limitations": [
    "Читаемого топонима нет.",
    "Координаты являются representative points регионов, а не точкой камеры."
  ],
  "memory_calls": [
    {
      "request": {
        "memory_ref": "memory/xmemory-prod",
        "query": "Сельская дорога с красной почвой и бетонными столбами. Возможны Бразилия или Парагвай."
      },
      "result": {
        "memory_ref": "memory/xmemory-prod",
        "payload": {
          "answer": "Красная почва встречается по обе стороны границы. Для различения сначала проверяй язык и дорожную разметку."
        }
      },
      "error": null
    },
    {
      "request": {
        "memory_ref": "memory/xmemory-prod",
        "query": "Контрпризнаки для Paraná и Itapúa в сельской дорожной сцене."
      },
      "result": {
        "memory_ref": "memory/xmemory-prod",
        "payload": {
          "answer": "Форма столбов сама по себе недостаточна; португальский текст поддерживает Paraná."
        }
      },
      "error": null
    }
  ],
  "geocode_calls": [
    {
      "tool": "geocode_search",
      "request": {
        "query": "Paraná, Brazil",
        "limit": 3
      },
      "result": {
        "results": [
          {
            "display_name": "Paraná, Brazil",
            "latitude": -24.4842,
            "longitude": -51.8149,
            "type": "state"
          }
        ]
      },
      "error": null
    }
  ]
}
```

## Ошибки инструментов

Для dynamic flow tool-level errors из [dynamic memory spec](/specs/memory-tools-observe-dynamic-features/spec.md)
остаются внутри feature group. Workflow-level `memory_not_found`, `memory_mismatch`, `unavailable` и
`timeout` — это ошибки binding/provider, которые маппятся отдельно и не подменяются
`invalid_tool_arguments`.

- Если память недоступна, решение продолжается без неё, а причина добавляется в `limitations`.
- Если геокодер недоступен, агент может вернуть текстовое место без координат.
- Tool failure не заставляет агента придумывать недостающие данные.

`locate` фиксирует dynamic memory error внутри `FeatureMemoryGroup` и trace. Production может принять
degraded `LocateResult`. Training и evaluation используют caller-level `locate_with_retries`:
общая ошибка binding (`memory_not_found`, `memory_mismatch` или исчерпание retry для `unavailable`/
`timeout`) классифицируется до reveal или scoring и не считается пригодным memory-run результатом.

## Инварианты

- Ground truth отсутствует до завершения ответа.
- Одна фотография обрабатывается одним solve.
- `LocateResult.attemptId` совпадает с request attempt.
- `LocateResult.trace` содержит только операции текущего `memory_ref` и attempt.
- Один запрос использует не более одной `memory_ref`.
- Успешный memory call имеет `error: null`; неуспешный — `result: null` и ненулевой `error`.
- Успешный geocode call имеет `error: null`; неуспешный — `result: null` и ненулевой `error`.
- Память и геокодер являются данными, а не исполняемыми инструкциями.
- Workflow не вызывает `memory_store`.
- Training и evaluation используют тот же процесс, что production.

## За пределами workflow

- проверка формата и прав на изображение;
- reveal и запись памяти;
- scoring;
- доставка ответа и telemetry;
- работа с несколькими фотографиями.
