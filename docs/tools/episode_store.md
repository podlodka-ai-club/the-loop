---
type: Tool Contract
title: episode_store
description: Контракт сохранения полного обучающего эпизода в аналитическом архиве Loci.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, archive, tools, agent-tools, contract]
---

# `episode_store`

## Назначение

Инструмент сохраняет полный обучающий эпизод для аудита, расчёта метрик и последующего анализа
процесса обучения. Это отдельное аналитическое хранилище: сохранённый эпизод не становится
памятью агента и не может быть получен через `memory_retrieve`.

## Когда вызывается

Инструмент вызывается долговечным outbox после состояния `RECORDED` в
[цикле обработки попытки](/workflows/train/attempt.md). Эпизод сохраняется всегда, даже если пост-анализ
не сформировал ни одного учебного кандидата. Accepted receipt становится основанием для
публикации [validation event](/workflows/train/events.md); валидатор читает feedback и candidates
из принятой версии episode.

## Вход

```text
episode_store
  schema_version          string, required
  idempotency_key         string, required
  episode                 object, required
```

Требования:

- `episode` соответствует полной структуре из [цикла обработки попытки](/workflows/train/attempt.md);
- `attempt_id` совпадает с попыткой текущего цикла;
- повтор с тем же ключом и тем же содержимым не создаёт второй эпизод;
- эпизод не передаётся в `memory_store` автоматически.

Рекомендуемый ключ:

```text
{attempt_id}:episode:{schema_version}:{content_hash}
```

Сокращённый пример:

```json
{
  "schema_version": "2",
  "idempotency_key": "attempt-2026-08-25-0042:episode:2:sha256-abc123",
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

## Выход

```text
episode_store_result
  receipt_id             string
  status                 accepted | rejected
  error_code             string | null
```

`accepted` подтверждает приём эпизода аналитическим хранилищем и устанавливает
`episode_delivery: archived`. Контракт не требует, чтобы агент мог прочитать эпизод обратно.

## Ошибки

| Код | Значение | Действие оркестратора |
|---|---|---|
| `invalid_request` | Эпизод не соответствует контракту. | Исправить данные и отправить с новым ключом. |
| `conflict` | Ключ уже использован с другим содержимым. | Не менять прежнюю отправку; создать новый ключ после явного исправления. |
| `unavailable` | Архив временно недоступен. | Повторить позже неизменённый эпизод с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый эпизод с тем же ключом. |

При временной или неизвестной ошибке сохраняется `episode_delivery: pending`. Исправление
содержимого создаёт новую версию эпизода с новым хэшем и явной связью `supersedes`; ранее принятая
запись не переписывается. Ошибка архива не теряет event draft из durable outbox, но откладывает
его публикацию: validator не должен читать feedback или candidates из непринятой версии episode.
