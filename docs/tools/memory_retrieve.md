---
type: Tool Contract
title: memory_retrieve
description: Контракт извлечения релевантных наблюдений из внешней памяти Loci.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, memory, tools, agent-tools, contract]
---

# `memory_retrieve`

## Когда вызывается

Инструмент вызывается после первичного наблюдения фотографии. В базовом
[обучающем процессе](/workflow/train.md) допускаются два смысловых прохода:

1. запрос по визуальным признакам;
2. запрос по сформированным географическим кандидатам и возможным исключениям.

Это рекомендация workflow, а не ограничение самого инструмента.

## Вход

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

## Выход

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

## Правила использования

- Возвращённая запись является подсказкой, а не фактом.
- Агент сопоставляет запись с текущей фотографией и явно отмечает противоречия.
- Отсутствие результатов не доказывает отсутствие знания в памяти.
- `truncated: true` означает только то, что память могла вернуть больше результатов. Пагинации
  и курсора в первой версии нет: агент работает с уже возвращённым набором.
- Для `kind: unknown` содержимое используется только как нетипизированная подсказка; агент не
  предполагает структуру `learning_observation`.
- Агент не строит уверенность на позиции записи в выдаче без независимых визуальных оснований.

## Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Запрос не соответствует контракту. | Исправить запрос один раз. |
| `unavailable` | Память временно недоступна. | Продолжить анализ без памяти и отметить это в попытке. |
| `timeout` | Ответ не получен вовремя. | Продолжить анализ без памяти; повтор не обязателен. |

Недоступность извлечения не блокирует географический ответ.
