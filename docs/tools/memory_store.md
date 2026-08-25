---
type: Tool Contract
title: memory_store
description: Контракт передачи валидированных учебных наблюдений во внешнюю память Loci.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, memory, validation, tools, agent-tools, contract]
---

# `memory_store`

## Назначение

Инструмент передаёт во внешнюю память знания, прошедшие
[межэпизодную валидацию](/workflows/train/validate.md). Он не принимает непроверенные гипотезы
непосредственно из одной обучающей попытки.

Подтверждение приёма означает только доставку. Оно не доказывает немедленную индексацию,
актуальность записи, её будущую извлекаемость или улучшение качества агента.

## Когда вызывается

Инструмент вызывается валидатором после решения `knowledge_validation.decision: validated`.

Он не вызывается:

- из [цикла обработки попытки](/workflows/train/attempt.md) для `learning_candidate`;
- для `rejected`, `quarantined` или `superseded` кандидата;
- если запуск валидации не сформировал ни одного нового валидированного наблюдения;
- из validation/test benchmark.

Вызов не зависит от доставки отдельных эпизодов в `episode_store`: происхождение всех записей уже
содержит устойчивые `source_attempt_ids`, а исходящие операции ведутся долговечным оркестратором.

## Вход

```text
memory_store
  schema_version          string, required
  idempotency_key         string, required
  validation_batch_id     string, required
  observations[]
    client_record_id      string, required
    content               learning_observation, required
```

### Требования к пакету

- пакет содержит хотя бы одно `learning_observation`;
- каждая запись имеет `epistemic_status: validated_association`;
- каждая запись содержит `knowledge_id`, `knowledge_version` и `validation_policy_version`;
- `source_attempt_ids` не пуст и ссылается только на train-эпизоды;
- `client_record_id` уникален внутри пакета и стабилен для версии знания;
- пакет не содержит `episode`, изображения, полный `answer_snapshot` или полные evaluation traces;
- `idempotency_key` стабилен для повторной отправки неизменяемого пакета;
- повтор с тем же ключом и содержимым не создаёт дубликаты;
- изменение содержимого создаёт новую версию знания и новый ключ;
- замена старого знания указывает `supersedes`, но не требует от агента удалить прежнюю запись.

Полная структура `learning_observation` определена в
[цикле валидации знаний](/workflows/train/validate.md).

### Рекомендуемые идентификаторы

```text
client_record_id
  {knowledge_id}:{knowledge_version}

idempotency_key
  {validation_batch_id}:memory:{schema_version}:{content_hash}
```

### Пример

```json
{
  "schema_version": "2",
  "idempotency_key": "validation-batch-0042:memory:2:sha256-abc123",
  "validation_batch_id": "validation-batch-0042",
  "observations": [
    {
      "client_record_id": "knowledge-ca-qc-pole:3",
      "content": {
        "knowledge_id": "knowledge-ca-qc-pole",
        "knowledge_version": "3",
        "created_at": "2026-08-25T12:30:00+03:00",
        "claim": {
          "prerequisites": [
            "Canada is already a plausible country",
            "the object is clearly recognized as a roadside pole"
          ],
          "cue": "the specified pole and bollard variant",
          "direction": "supports",
          "target_location": "Quebec, Canada",
          "geographic_level": "region",
          "comparison_set": ["Ontario, Canada"]
        },
        "applicability": {
          "source_domains": ["street_view"],
          "geographic_scope": "rural Quebec versus rural Ontario",
          "validity_window": null
        },
        "support": {
          "source_attempt_ids": [
            "attempt-2026-08-25-0042",
            "attempt-2026-08-25-0107",
            "attempt-2026-08-25-0219"
          ],
          "independent_positive_groups": 3,
          "independent_comparison_groups": 4,
          "counterexample_count": 1,
          "degraded_source_count": 1,
          "estimated_reliability": null
        },
        "known_exceptions": [],
        "validation_policy_version": "1",
        "epistemic_status": "validated_association",
        "supersedes": "knowledge-ca-qc-pole:2"
      }
    }
  ]
}
```

Пример показывает оболочку и основные поля; фактические административные идентификаторы и
свидетельства должны соответствовать результату валидации. `degraded_source_count` сохраняет
происхождение поддержки, но не означает, что валидатор принял зависимое от outage свидетельство.

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

`accepted` устанавливает `memory_delivery: submitted` для пакета. `partial` сохраняет состояние
отдельных записей и оставляет пакет в `pending` до разрешения всех результатов.

Инструмент не сообщает:

- стала ли запись немедленно доступна через `memory_retrieve`;
- как она объединена с существующими знаниями;
- какой вес назначен ей внутри памяти;
- будет ли она включена в следующий `memory_snapshot_id`;
- улучшает ли она ответы агента.

Последнее проверяется отдельным [циклом оценки памяти](/workflows/train/evaluate.md).

## Повторная отправка

- При `partial`, `rejected`, `unavailable` или `timeout` исходный пакет сохраняется без изменений.
- Повтор временной или неизвестной ошибки использует тот же `idempotency_key`.
- Уже принятые записи не должны дублироваться.
- Статус отслеживается по каждому `client_record_id`.
- Невалидная запись исправляется как новая `knowledge_version` с новым ключом и явным
  происхождением изменения.
- Постоянная ошибка переводит запись в `permanent_failure` и создаёт операторский сигнал; она не
  удерживает валидатор в бесконечном активном цикле.

## Ошибки

| Код | Значение | Действие оркестратора |
|---|---|---|
| `invalid_request` | Пакет или запись не соответствует контракту. | Не повторять неизменённый payload; исправить через новую версию. |
| `unvalidated_content` | Запись не имеет допустимого результата валидации. | Вернуть в карантин; не публиковать. |
| `invalid_provenance` | Происхождение отсутствует или содержит не-train эпизоды. | Отклонить и проверить validation trace. |
| `conflict` | Ключ уже использован с другим содержимым. | Сохранить конфликт; сформировать корректную новую версию и ключ. |
| `unavailable` | Память временно недоступна. | Повторить позже неизменённый пакет с тем же ключом. |
| `timeout` | Результат приёма неизвестен. | Повторить неизменённый пакет с тем же ключом. |

## Инварианты

- `learning_candidate` из одной попытки никогда не передаётся как валидированное знание.
- Все опубликованные записи имеют проверяемое происхождение из train-эпизодов.
- Validation/test не входят в поддержку знания.
- Исправление создаёт версию, а не молча переписывает запись.
- Приём не считается индексацией или доказанным улучшением.
- Агент не получает права активировать, удалить или изменить знание напрямую.
