---
type: Tool Contract
title: Инструменты памяти и эпизодов Loci
description: Контракты извлечения и сохранения памяти, а также отдельного архивирования обучающих эпизодов.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, memory, tools, contract]
---

# Инструменты памяти и эпизодов Loci

## Назначение

Память для Loci — чёрный ящик. Агент может запросить релевантные записи и передать новые учебные
наблюдения, но не управляет индексом, объединением, актуальностью и жизненным циклом знаний.
Полные обучающие эпизоды сохраняются отдельным инструментом и не попадают в память агента.

Минимальный интерфейс состоит из трёх инструментов:

| Инструмент | Назначение |
|---|---|
| `memory_retrieve` | Извлечь записи, которые память считает релевантными текущему запросу. |
| `memory_store` | Передать учебные наблюдения во внешнюю память. |
| `episode_store` | Сохранить полный обучающий эпизод в отдельном аналитическом архиве. |

Интерфейс памяти намеренно не содержит `update`, `delete`, `list` или команды изменения веса
знания. `episode_store` не является частью памяти и не влияет на результаты `memory_retrieve`.

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
    kind        learning_observation | unknown
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
  предполагает структуру `learning_observation`.
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

Инструмент вызывается после `REVIEWED`, когда пост-анализ сформировал хотя бы одно
`learning_observation`. Вызов не зависит от результата `episode_store`. Если переносимого
вывода нет, `memory_store` не вызывается.

### Вход

```text
memory_store
  schema_version          string, required
  idempotency_key         string, required
  observations[]
    client_record_id      string, required
    content               object, required
```

Требования к пакету:

- содержит хотя бы одно `learning_observation`;
- не содержит `episode`, изображения, полный `answer_snapshot` или `evaluation`;
- все наблюдения относятся к одному `attempt_id`;
- `client_record_id` уникален внутри пакета;
- `idempotency_key` стабилен для повторных отправок этого пакета;
- повтор с тем же ключом и тем же содержимым не создаёт дубликаты.

Для `learning_observation.epistemic_status` допустимы только `observed` и `inferred`. Поле
описывает природу текущего утверждения и не является командой изменить глобальный статус знания.

Рекомендуемый ключ:

```text
{attempt_id}:memory:{schema_version}
```

Сокращённый пример ниже показывает оболочку пакета и намеренно опускает часть вложенных полей.
Он не определяет обязательность полей записей; полные структуры приведены в `train.md`.

```json
{
  "schema_version": "1",
  "idempotency_key": "attempt-2026-08-25-0042:memory:1",
  "observations": [
    {
      "client_record_id": "attempt-2026-08-25-0042:learning:1",
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

Полная структура `learning_observation` определена в
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

При `status: accepted` устанавливается `memory_delivery: submitted`. При `partial` и `rejected`
сохраняется `memory_delivery: pending`.

### Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Пакет не соответствует контракту. | Исправить пакет и отправить с новым ключом. |
| `conflict` | Этот ключ уже использован с другим содержимым. | Не менять существующую отправку; сформировать новый ключ после явного исправления. |
| `unavailable` | Память временно недоступна. | Повторить позже неизменённый пакет с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый пакет с тем же ключом. |

## `episode_store`

### Назначение

Инструмент сохраняет полный обучающий эпизод для аудита, расчёта метрик и последующего анализа
процесса обучения. Это отдельное аналитическое хранилище: сохранённый эпизод не становится
памятью агента и не может быть получен через `memory_retrieve`.

### Когда вызывается

Инструмент вызывается после состояния `REVIEWED`. Он независим от `memory_store` и может быть
вызван до или после него. Эпизод сохраняется всегда, даже если пост-анализ не сформировал ни
одного учебного наблюдения.

### Вход

```text
episode_store
  schema_version          string, required
  idempotency_key         string, required
  episode                 object, required
```

Требования:

- `episode` соответствует полной структуре из [обучающего процесса](/workflow/train.md);
- `attempt_id` совпадает с попыткой текущего цикла;
- повтор с тем же ключом и тем же содержимым не создаёт второй эпизод;
- эпизод не передаётся в `memory_store` автоматически.

Рекомендуемый ключ:

```text
{attempt_id}:episode:{schema_version}
```

Сокращённый пример:

```json
{
  "schema_version": "1",
  "idempotency_key": "attempt-2026-08-25-0042:episode:1",
  "episode": {
    "attempt_id": "attempt-2026-08-25-0042",
    "image_ref": "image-0042",
    "created_at": "2026-08-25T12:01:00+03:00",
    "answer_snapshot": {},
    "ground_truth": {},
    "evaluation": {},
    "post_analysis": {}
  }
}
```

### Выход

```text
episode_store_result
  receipt_id             string
  status                 accepted | rejected
  error_code             string | null
```

`accepted` подтверждает приём эпизода аналитическим хранилищем и устанавливает
`episode_delivery: archived`. Контракт не требует, чтобы агент мог прочитать эпизод обратно.

### Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Эпизод не соответствует контракту. | Исправить данные и отправить с новым ключом. |
| `conflict` | Ключ уже использован с другим содержимым. | Не менять прежнюю отправку; создать новый ключ после явного исправления. |
| `unavailable` | Архив временно недоступен. | Повторить позже неизменённый эпизод с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый эпизод с тем же ключом. |

При ошибке сохраняется `episode_delivery: pending`. Это не блокирует независимый вызов `memory_store`.

## Общие ограничения

- Агент не получает гарантию немедленной согласованности: только что сохранённая запись может не появиться в следующем извлечении.
- Агент не использует `memory_retrieve` для проверки результата `memory_store`.
- `episode_store` и память независимы: архивирование эпизода не делает его доступным для извлечения.
- Ошибка `episode_store` не блокирует `memory_store`, а ошибка памяти не блокирует архивирование эпизода.
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
  ├→ episode_store(episode) → episode_delivery: archived
  └→ memory_store(learning observations, if any) → memory_delivery: submitted
  → COMPLETE
```

Если учебных наблюдений нет, устанавливается `memory_delivery: not_needed`. Цикл завершается,
когда эпизод принят архивом, а `memory_delivery` равно `submitted` или `not_needed`.
