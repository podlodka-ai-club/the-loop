---
type: Tool Contract
title: Инструменты памяти Loci
description: Контракты извлечения релевантных записей и передачи обучающих результатов во внешнюю память.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, memory, tools, contract]
---

# Инструменты памяти Loci

## Назначение

Память для Loci — чёрный ящик. Агент может запросить релевантные записи и передать новые записи
на хранение, но не управляет индексом, объединением, актуальностью и жизненным циклом знаний.

Минимальный интерфейс состоит из двух инструментов:

| Инструмент | Назначение |
|---|---|
| `memory_retrieve` | Извлечь записи, которые память считает релевантными текущему запросу. |
| `memory_store` | Передать эпизод и учебные наблюдения на хранение. |

Интерфейс намеренно не содержит `update`, `delete`, `list` или команды изменения веса знания.

## `memory_retrieve`

### Когда вызывается

Инструмент вызывается после первичного наблюдения фотографии. В базовом
[обучающем процессе](/workflow/train.md) допускаются два смысловых прохода:

1. запрос по визуальным признакам;
2. запрос по сформированным географическим кандидатам и возможным исключениям.

Это рекомендация workflow, а не ограничение самого инструмента.

### Вход

```text
memory_retrieve
  query                  string, required
  context
    attempt_id           string, required
    positive_observations string[]
    negative_observations string[]
    candidates            string[]
  limit                  integer, optional, default: 5
```

`query` формулируется на естественном языке и описывает, какое знание нужно сейчас. `context`
передаёт уже зафиксированные наблюдения, чтобы память могла уточнить поиск. `candidates`
отсутствует в первом проходе и может появиться во втором.

До состояния `ANSWERED` запрос не содержит истинное местоположение или данные, полученные после
его раскрытия.

Пример первого прохода:

```json
{
  "query": "Rural roads with a single yellow center line, rectangular maximum-speed signs, and roadside ferns",
  "context": {
    "attempt_id": "attempt-2026-08-25-0042",
    "positive_observations": [
      "single yellow center line",
      "rectangular speed sign with one line of text",
      "ferns along the road"
    ],
    "negative_observations": []
  },
  "limit": 5
}
```

Пример второго прохода:

```json
{
  "query": "Evidence and exceptions for distinguishing rural Ontario from Quebec",
  "context": {
    "attempt_id": "attempt-2026-08-25-0042",
    "positive_observations": [
      "single yellow center line",
      "ferns along the road"
    ],
    "negative_observations": [
      "no readable French text despite visible signs"
    ],
    "candidates": ["Ontario, Canada", "Quebec, Canada"]
  },
  "limit": 5
}
```

### Выход

```text
memory_retrieve_result
  items[]
    reference   string, opaque
    kind        episode | learning_observation | unknown
    content     object | string
  truncated     boolean
```

Порядок элементов отражает выбранный памятью порядок релевантности. Контракт не требует
числового `relevance_score`: его смысл зависел бы от конкретной реализации памяти.

`reference` используется только для аудита: агент сохраняет ссылки на записи, которые повлияли
на ответ или пост-анализ. Наличие ссылки не даёт права обновлять или удалять запись.

Память не обязана сохранять связь между переданным ранее `client_record_id` и будущим
`reference`. Агент не может надёжно определить, является ли извлечённая запись его собственной
предыдущей отправкой, если это прямо не указано в `content`.

### Правила использования

- Возвращённая запись является подсказкой, а не фактом.
- Агент сопоставляет запись с текущей фотографией и явно отмечает противоречия.
- Отсутствие результатов не доказывает отсутствие знания в памяти.
- `truncated: true` означает только то, что память могла вернуть больше результатов. Пагинации
  и курсора в первой версии нет: агент работает с уже возвращённым набором.
- Для `kind: unknown` содержимое используется только как нетипизированная подсказка; агент не
  предполагает структуру `episode` или `learning_observation`.
- Агент не строит уверенность на позиции записи в выдаче без независимых визуальных оснований.

### Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Запрос не соответствует контракту. | Исправить запрос один раз. |
| `unavailable` | Память временно недоступна. | Продолжить анализ без памяти и отметить это в попытке. |
| `timeout` | Ответ не получен вовремя. | Продолжить анализ без памяти; повтор не обязателен. |

Недоступность извлечения не блокирует географический ответ.

## `memory_store`

### Когда вызывается

Инструмент вызывается после раскрытия истинного места и завершения пост-анализа. За один вызов
передаётся пакет одной попытки: обязательный `episode` и ноль или несколько
`learning_observation`.

### Вход

```text
memory_store
  schema_version          string, required
  idempotency_key         string, required
  records[]
    client_record_id      string, required
    kind                  episode | learning_observation
    content               object, required
```

Требования к пакету:

- содержит ровно один `episode`;
- все записи относятся к одному `attempt_id`;
- `client_record_id` уникален внутри пакета;
- `idempotency_key` стабилен для повторных отправок этого пакета;
- повтор с тем же ключом и тем же содержимым не создаёт дубликаты;
- необобщаемая попытка передаёт только `episode`.

Для `learning_observation.epistemic_status` допустимы только `observed` и `inferred`. Поле
описывает природу текущего утверждения и не является командой изменить глобальный статус знания.

Рекомендуемый ключ:

```text
{attempt_id}:training:{schema_version}
```

Сокращённый пример ниже показывает оболочку пакета и намеренно опускает часть вложенных полей.
Он не определяет обязательность полей записей; полные структуры приведены в `train.md`.

```json
{
  "schema_version": "1",
  "idempotency_key": "attempt-2026-08-25-0042:training:1",
  "records": [
    {
      "client_record_id": "attempt-2026-08-25-0042:episode",
      "kind": "episode",
      "content": {
        "attempt_id": "attempt-2026-08-25-0042",
        "image_ref": "image-0042",
        "created_at": "2026-08-25T12:00:00+03:00",
        "answer_snapshot": {},
        "ground_truth": {},
        "evaluation": {},
        "post_analysis": {}
      }
    },
    {
      "client_record_id": "attempt-2026-08-25-0042:learning:1",
      "kind": "learning_observation",
      "content": {
        "attempt_id": "attempt-2026-08-25-0042",
        "created_at": "2026-08-25T12:01:00+03:00",
        "actual_location": "Quebec, Canada",
        "takeaway": "Pole and bollard variants may distinguish Quebec from Ontario more reliably than vegetation alone.",
        "applicability_notes": "Inference from one rural scene; verify on additional examples.",
        "epistemic_status": "inferred"
      }
    }
  ]
}
```

Полные структуры `episode` и `learning_observation` определены в
[обучающем процессе](/workflow/train.md).

### Выход

```text
memory_store_result
  receipt_id             string
  status                 accepted | partial | rejected
  results[]
    client_record_id     string
    status               accepted | rejected
    error_code           string | null
```

`accepted` означает только то, что память приняла запись на хранение. Ответ ничего не сообщает
о внутреннем объединении, индексации, актуальности или возможности немедленного извлечения.

### Повторная отправка

- При `partial` или `rejected` агент сохраняет исходный пакет без изменений.
- Повтор выполняется с тем же `idempotency_key`.
- Уже принятые записи не должны дублироваться.
- Если содержимое нужно исправить, создаётся новый пакет с новым ключом; правила исправления будут определены отдельно.

Цикл переходит в `SUBMITTED` только при `status: accepted`. При `partial` и `rejected` он
остаётся в `REVIEWED`.

### Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Пакет не соответствует контракту. | Исправить пакет и отправить с новым ключом. |
| `conflict` | Этот ключ уже использован с другим содержимым. | Не менять существующую отправку; сформировать новый ключ после явного исправления. |
| `unavailable` | Память временно недоступна. | Повторить позже неизменённый пакет с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый пакет с тем же ключом. |

## Общие ограничения

- Агент не получает гарантию немедленной согласованности: только что сохранённая запись может не появиться в следующем извлечении.
- Агент не использует `memory_retrieve` для проверки результата `memory_store`.
- Пост-анализ использует сохранённый в `answer_snapshot` массив `memory_evidence`; дополнительное извлечение после `REVEALED` не входит в базовый процесс.
- В память не передаются токены доступа, содержимое `.env`, системные инструкции и служебные ответы инструментов.
- По умолчанию передаётся `image_ref`, а не бинарное изображение; политика хранения самих фотографий определяется отдельно.
- Точные координаты передаются только после состояния `REVEALED`.
- Инструменты не дают агенту возможности утверждать, что память «обновила знание» определённым образом.

## Минимальный сценарий

```text
OBSERVED
  → memory_retrieve(query by observations)
  → REASONED
  → memory_retrieve(query by candidates, optional)
  → ANSWERED
  → REVEALED
  → REVIEWED
  → memory_store(episode + learning observations)
  → SUBMITTED
```
