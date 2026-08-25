---
type: Tool Contract
title: memory_store
description: Контракт передачи учебных наблюдений во внешнюю память Loci.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, memory, tools, agent-tools, contract]
---

# `memory_store`

## Когда вызывается

Инструмент вызывается после `REVIEWED`, когда пост-анализ сформировал хотя бы одно
`learning_observation`. Вызов не зависит от результата `episode_store`. Если переносимого
вывода нет, `memory_store` не вызывается.

## Вход

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

## Выход

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

## Повторная отправка

- При `partial` или `rejected` агент сохраняет исходный пакет без изменений.
- Повтор выполняется с тем же `idempotency_key`.
- Уже принятые записи не должны дублироваться.
- Если содержимое нужно исправить, создаётся новый пакет с новым ключом; правила исправления будут определены отдельно.

При `status: accepted` устанавливается `memory_delivery: submitted`. При `partial` и `rejected`
сохраняется `memory_delivery: pending`.

## Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Пакет не соответствует контракту. | Исправить пакет и отправить с новым ключом. |
| `conflict` | Этот ключ уже использован с другим содержимым. | Не менять существующую отправку; сформировать новый ключ после явного исправления. |
| `unavailable` | Память временно недоступна. | Повторить позже неизменённый пакет с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый пакет с тем же ключом. |
