---
type: Workflow
title: Слепая геолокация Loci
description: Определение наиболее вероятного места по одной фотографии без доступа к ground truth.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, inference, geolocation, memory]
---

# Слепая геолокация Loci

## Назначение

Workflow получает одну фотографию и возвращает неизменяемый `answer_snapshot`. Ground truth
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

Workflow возвращает общий [`answer_snapshot`](models.md#answer-snapshot). Он содержит публичный
результат геолокации и внутренние memory/geocode calls, зафиксированные до reveal.

## Процесс

### 1. Анализ изображения

Агент рассматривает ландшафт, растительность, архитектуру, дороги, транспорт, текст и другие
видимые признаки. Отсутствие ожидаемого признака учитывается только когда нужная область хорошо
видна. Затем агент формирует один или несколько географических кандидатов.

### 2. Память

Если передана `memory_ref`, агент может несколько раз вызвать
[`memory_retrieve`](../tools/memory_retrieve.md) с кратким текстовым запросом о различающих признаках
или кандидатах. Количество вызовов ограничивает runner-конфигурация.

Все обращения в одном solve используют одну и ту же `memory_ref`; workflow не выбирает другую систему
памяти и не переключает версии данных внутри провайдера.

Provider-native payload является подсказкой и используется только тогда, когда согласуется с
текущим изображением. Все запросы и результаты сохраняются в `answer_snapshot` по порядку вызовов. Для
неуспешного вызова `result: null`, а `error` содержит код из tool contract. Человекочитаемая причина
дополнительно записывается в `limitations`. Если вызовов не было, `memory_calls` пуст.

### 3. Геокодинг

[`geocode_search`](../tools/geocode_search.md) разрешает уже сформированное название или адрес в
координаты. [`geocode_reverse`](../tools/geocode_reverse.md) может проверить доступные address
components для уже выбранной точки.

Геокодер не создаёт визуальную гипотезу и не доказывает связь фотографии с найденным объектом.
Координаты reverse-результата не заменяют исходную точку агента. Все geocode requests, results и
машинные ошибки сохраняются в `answer_snapshot` по порядку вызовов.

### 4. Ответ

Агент выбирает ведущий вариант, сохраняет существенные альтернативы и честно указывает
ограничения. После создания `answer_snapshot` не изменяется.

Пример:

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

- Если память недоступна, решение продолжается без неё, а причина добавляется в `limitations`.
- Если геокодер недоступен, агент может вернуть текстовое место без координат.
- Tool failure не заставляет агента придумывать недостающие данные.

`locate` фиксирует memory error внутри `answer_snapshot` и сам не решает, допустим ли degraded
ответ для вызывающего workflow. Production может принять такой ответ с `limitations`. Training и
evaluation используют caller-level `locate_with_retries`: общая ошибка памяти (`memory_not_found`,
`memory_mismatch` или исчерпание retry для `unavailable`/`timeout`) классифицируется до reveal или
scoring и не считается пригодным memory-run результатом.

## Инварианты

- Ground truth отсутствует до завершения ответа.
- Одна фотография обрабатывается одним solve.
- `answer_snapshot.runner_config_id` совпадает с request.
- `answer_snapshot.memory_ref` совпадает с request.
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
