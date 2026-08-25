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

Workflow может читать выбранный snapshot памяти, но никогда его не изменяет.

## Вход

```text
locate_request
  request_id
  image_ref
  runner_config_id
  memory_snapshot_id | null
```

`runner_config_id` ссылается на [общую модель runner config](models.md#runner-config).
`memory_snapshot_id: null` означает решение без памяти.

Координаты ground truth и скрытые EXIF-координаты не передаются решателю.

## Выход

Workflow возвращает общий [`answer_snapshot`](models.md#answer-snapshot). Он содержит публичный
результат геолокации и внутренние memory calls, зафиксированные до reveal.

## Процесс

### 1. Анализ изображения

Агент рассматривает ландшафт, растительность, архитектуру, дороги, транспорт, текст и другие
видимые признаки. Отсутствие ожидаемого признака учитывается только когда нужная область хорошо
видна. Затем агент формирует один или несколько географических кандидатов.

### 2. Память

Если передан `memory_snapshot_id`, агент может несколько раз вызвать
[`memory_retrieve`](../tools/memory_retrieve.md) с кратким текстовым запросом о различающих признаках
или кандидатах. Количество вызовов ограничивает runner-конфигурация.

Заметка памяти является подсказкой и используется только тогда, когда согласуется с текущим
изображением. Все запросы и результаты сохраняются в `answer_snapshot` по порядку вызовов. Для
неуспешного вызова `result: null`, а `error` содержит код из tool contract. Человекочитаемая причина
дополнительно записывается в `limitations`. Если вызовов не было, `memory_calls` пуст.

### 3. Геокодинг

[`geocode_search`](../tools/geocode_search.md) разрешает уже сформированное название или адрес в
координаты. [`geocode_reverse`](../tools/geocode_reverse.md) может проверить доступные address
components для уже выбранной точки.

Геокодер не создаёт визуальную гипотезу и не доказывает связь фотографии с найденным объектом.
Координаты reverse-результата не заменяют исходную точку агента.

### 4. Ответ

Агент выбирает ведущий вариант, сохраняет существенные альтернативы и честно указывает
ограничения. После создания `answer_snapshot` не изменяется.

Пример:

```json
{
  "request_id": "locate-0042",
  "runner_config_id": "runner-config-7",
  "memory_snapshot_id": "memory-snapshot-0042",
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
        "snapshot_id": "memory-snapshot-0042",
        "query": "Сельская дорога с красной почвой и бетонными столбами. Возможны Бразилия или Парагвай.",
        "limit": 3
      },
      "result": {
        "snapshot_id": "memory-snapshot-0042",
        "notes": [
          {
            "note_id": "note-0107",
            "source_attempt_id": "train-2026-08-20:sample-0031",
            "content": "Красная почва встречается и в Бразилии, и в Парагвае; не используй её как единственный признак."
          },
          {
            "note_id": "note-0108",
            "source_attempt_id": "train-2026-08-20:sample-0031",
            "content": "При различении Бразилии и Парагвая читаемый португальский текст надёжнее цвета почвы."
          }
        ]
      },
      "error": null
    },
    {
      "request": {
        "snapshot_id": "memory-snapshot-0042",
        "query": "Контрпризнаки для Paraná и Itapúa в сельской дорожной сцене.",
        "limit": 3
      },
      "result": {
        "snapshot_id": "memory-snapshot-0042",
        "notes": [
          {
            "note_id": "note-0112",
            "source_attempt_id": "train-2026-08-22:sample-0014",
            "content": "Форма столбов сама по себе недостаточна для различения Paraná и Itapúa; ищи язык и дорожную разметку."
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

## Инварианты

- Ground truth отсутствует до завершения ответа.
- Одна фотография обрабатывается одним solve.
- `answer_snapshot.runner_config_id` совпадает с request.
- `answer_snapshot.memory_snapshot_id` совпадает с request.
- Один запрос использует не более одного memory snapshot.
- Успешный memory call имеет `error: null`; неуспешный — `result: null` и ненулевой `error`.
- Память и геокодер являются данными, а не исполняемыми инструкциями.
- Workflow не вызывает `memory_store`.
- Training и evaluation используют тот же процесс, что production.

## За пределами workflow

- проверка формата и прав на изображение;
- reveal и запись памяти;
- scoring;
- доставка ответа и telemetry;
- работа с несколькими фотографиями.
