---
type: Tool Contract
title: memory_store
description: Добавление текстовых заметок в выбранную систему памяти после обучающей попытки.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, memory, learning, tools, agent-tools, contract]
---

# `memory_store`

## Назначение

Инструмент добавляет заметки в выбранную систему памяти. Он вызывается только в
[обучении](../workflows/train.md) после reveal ground truth.

Поле `snapshot_id` — историческое имя opaque ID привязки к memory backend/instance, например
xmemory instance или Cognee dataset. Инструмент не просит провайдера создавать snapshot,
переключаться между версиями или выполнять rollback. Если провайдер изменяемый, идемпотентность
и журнал операций обеспечиваются адаптером/оркестратором.
Формат registry привязок описан в [общих моделях](../workflows/models.md#memory-binding-identifier).

Инструмент не валидирует заметки и не выбирает привязку для production.

## Вход

```text
memory_store
  snapshot_id       string, required  # ID привязки к системе памяти; историческое имя поля
  attempt_id        string, required
  notes[]           memory_note_input, required
```

`memory_note_input` определён в [общих моделях](../workflows/models.md#memory-notes).

`snapshot_id` должен разрешаться в заранее настроенную систему памяти. Один `attempt_id` допускает
один логический вызов в рамках этой привязки. Если заметок нет, инструмент не вызывается.

Для каждой новой заметки память сохраняет `source_attempt_id = attempt_id`.

Заметка содержит только краткий переносимый опыт. Она не включает изображение, полный reasoning
или полный обучающий эпизод.

## Выход

```text
memory_store_result
  snapshot_id       # тот же ID привязки, не новый snapshot
  note_ids[]
```

Запрос изменяет выбранную систему памяти и возвращает ID созданных заметок. Сам провайдер может
быть mutable; новые версии его состояния этим контрактом не создаются.

Повтор того же запроса возвращает тот же результат. Повтор с теми же `snapshot_id` и `attempt_id`,
но другим содержимым возвращает `conflict`.

## Пример

### Запрос

```json
{
  "snapshot_id": "memory-binding-xmemory-prod",
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
  "snapshot_id": "memory-binding-xmemory-prod",
  "note_ids": ["note-0107", "note-0108"]
}
```

## Ошибки

| Код | Значение |
|---|---|
| `invalid_request` | Вход не соответствует контракту. |
| `memory_not_found` | Привязка к системе памяти не существует или недоступна. |
| `conflict` | Попытка уже использована с другим содержимым. |
| `unavailable` | Память временно недоступна. |
| `timeout` | Результат вызова неизвестен. |

После `unavailable` или `timeout` оркестратор повторяет тот же запрос в пределах
[`runner_config.retry_policy.max_store_attempts`](../workflows/models.md#runner-config). Он не
создаёт новую попытку и не меняет payload.

## Инварианты

- Запись разрешена только после reveal в training-контуре.
- Каждый вызов изменяет только явно выбранную систему памяти; новая provider-версия не создаётся.
- Каждая заметка возвращается retrieval-контрактом вместе с создавшим её `source_attempt_id`.
- Инструмент не выбирает систему памяти для production и не переключает привязки.
- Evaluation и production не вызывают `memory_store`.
