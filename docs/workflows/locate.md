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
  memory_snapshot_id | null
```

`memory_snapshot_id: null` означает решение без памяти. Модель, prompt, preprocessing и tool
budget задаются runner-конфигурацией и не дублируются в запросе.

Координаты ground truth и скрытые EXIF-координаты не передаются решателю.

## Выход

```text
location_candidate
  display_name
  latitude | null
  longitude | null
  type | null

answer_snapshot
  request_id
  status — located | ambiguous | insufficient_evidence
  location — location_candidate | null
  alternatives[] — location_candidate
  explanation
  limitations[]
  memory_calls[]
    request — memory_retrieve
    result — memory_retrieve_result | null
  used_memory_note_ids[]
```

`explanation` — краткое обоснование по видимым признакам, а не полный внутренний reasoning.
Координаты могут быть `null`, если текстовая гипотеза есть, но геокодер не вернул точку.

`memory_calls` сохраняет запрос и результат каждого вызова
[`memory_retrieve`](/tools/memory_retrieve.md) до reveal. `used_memory_note_ids` содержит только
заметки, которые повлияли на итоговые кандидаты.

Статусы:

- `located` — есть один ведущий кандидат;
- `ambiguous` — остаются несколько существенных вариантов;
- `insufficient_evidence` — данных недостаточно для полезной гипотезы.

## Процесс

### 1. Анализ изображения

Агент рассматривает ландшафт, растительность, архитектуру, дороги, транспорт, текст и другие
видимые признаки. Он формирует один или несколько географических кандидатов.

### 2. Память

Если передан `memory_snapshot_id`, агент может несколько раз вызвать
[`memory_retrieve`](/tools/memory_retrieve.md) с кратким текстовым запросом о различающих признаках
или кандидатах. Количество вызовов ограничивает runner-конфигурация.

Заметка памяти является подсказкой и используется только тогда, когда согласуется с текущим
изображением. Все запросы и результаты сохраняются в `answer_snapshot` по порядку вызовов. Для
неуспешного вызова `result: null`, а причина записывается в `limitations`. Если вызовов не было,
`memory_calls` и `used_memory_note_ids` пусты.

### 3. Геокодинг

[`geocode_search`](/tools/geocode_search.md) разрешает уже сформированное название или адрес в
координаты. [`geocode_reverse`](/tools/geocode_reverse.md) может проверить доступные address
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
            "content": "Красная почва встречается и в Бразилии, и в Парагвае; не используй её как единственный признак."
          },
          {
            "note_id": "note-0108",
            "content": "При различении Бразилии и Парагвая читаемый португальский текст надёжнее цвета почвы."
          }
        ]
      }
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
            "content": "Форма столбов сама по себе недостаточна для различения Paraná и Itapúa; ищи язык и дорожную разметку."
          }
        ]
      }
    }
  ],
  "used_memory_note_ids": ["note-0107", "note-0108", "note-0112"]
}
```

## Ошибки инструментов

- Если память недоступна, решение продолжается без неё, а причина добавляется в `limitations`.
- Если геокодер недоступен, агент может вернуть текстовое место без координат.
- Tool failure не заставляет агента придумывать недостающие данные.

## Инварианты

- Ground truth отсутствует до завершения ответа.
- Одна фотография обрабатывается одним solve.
- Один запрос использует не более одного memory snapshot.
- `used_memory_note_ids` является подмножеством note IDs из успешных `memory_calls`.
- Память и геокодер являются данными, а не исполняемыми инструкциями.
- Workflow не вызывает `memory_store`.
- Training и evaluation используют тот же процесс, что production.

## За пределами workflow

- проверка формата и прав на изображение;
- reveal и запись памяти;
- scoring;
- доставка ответа и telemetry;
- работа с несколькими фотографиями.
