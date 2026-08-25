---
type: Tool Contract
title: memory_store
description: Добавление текстовых заметок к memory snapshot после обучающей попытки.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, memory, learning, tools, agent-tools, contract]
---

# `memory_store`

## Назначение

Инструмент добавляет заметки к существующему snapshot и возвращает новый immutable snapshot. Он
вызывается только в [обучении](/workflows/train.md) после reveal ground truth.

Инструмент не валидирует заметки и не активирует snapshot в production.

## Вход

```text
memory_store
  base_snapshot_id  string | null, required
  attempt_id        string, required
  notes[]
    content         string, required
```

`base_snapshot_id: null` создаёт первую версию памяти. Один `attempt_id` допускает один логический
вызов относительно одной базовой версии. Если заметок нет, инструмент не вызывается.

Заметка содержит только краткий переносимый опыт. Она не включает изображение, полный reasoning
или полный обучающий эпизод.

## Выход

```text
memory_store_result
  snapshot_id
  note_ids[]
```

Новый snapshot содержит все записи базовой версии и новые заметки. Базовый snapshot не изменяется.

Повтор того же запроса возвращает тот же результат. Повтор с теми же `base_snapshot_id` и
`attempt_id`, но другим содержимым возвращает `conflict`.

## Пример

### Запрос

```json
{
  "base_snapshot_id": "memory-snapshot-0041",
  "attempt_id": "train-2026-08-25:sample-0042",
  "notes": [
    {
      "content": "Красная почва встречается и в Бразилии, и в Парагвае; не используй её как единственный признак. Сопоставляй форму столбов и дорожную разметку."
    },
    {
      "content": "При различении Бразилии и Парагвая читаемый португальский текст надёжнее цвета почвы."
    }
  ]
}
```

### Ответ

```json
{
  "snapshot_id": "memory-snapshot-0042",
  "note_ids": ["note-0107", "note-0108"]
}
```

## Ошибки

| Код | Значение |
|---|---|
| `invalid_request` | Вход не соответствует контракту. |
| `snapshot_not_found` | Базовый snapshot не существует. |
| `conflict` | Попытка уже использована с другим содержимым. |
| `unavailable` | Память временно недоступна. |
| `timeout` | Результат вызова неизвестен. |

После `unavailable` или `timeout` оркестратор повторяет тот же запрос. Он не создаёт новую попытку
и не меняет payload.

## Инварианты

- Запись разрешена только после reveal в training-контуре.
- Каждый вызов создаёт новую версию и не меняет базовую.
- Источником заметок является ровно одна обучающая попытка.
- Инструмент не выбирает active production snapshot.
- Evaluation и production не вызывают `memory_store`.
