---
type: Workflow Contract
title: Очередь событий валидации Loci
description: Идемпотентный транспорт указателей на архивированные train-эпизоды с кандидатами и feedback для межэпизодной валидации.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, validation, queue, events, contract]
---

# Очередь событий валидации Loci

## Назначение

Контракт связывает [обработку train-попытки](attempt.md) и
[межэпизодную валидацию](validate.md). Полный `episode` остаётся единственным source of truth, а
очередь передаёт только устойчивый указатель на принятую архивом версию.

Такой маршрут не дублирует `learning_candidate` и `memory_feedback` в отдельном хранилище, но
позволяет независимо наблюдать доставку, повторять её и масштабировать валидатор.

## Поток

```text
attempt: RECORDED
  → episode payload в durable outbox
  → episode_store: accepted
  → validation_event с episode_receipt_id
  → validation queue
  → validator claims event
  → validator читает неизменяемый episode
  → candidates + feedback обработаны
  → event acknowledged
```

Событие не публикуется до `episode_store: accepted`, потому что validator должен читать ровно ту
версию episode, на которую указывает receipt и content hash.

## Source of truth

Архив хранит:

- `answer_snapshot` и retrieval trace;
- ground truth и evaluation;
- `memory_feedback[]`;
- `learning_candidate[]` либо `learning_decision`;
- data group references;
- solve config и degraded provenance.

Очередь не содержит эти payload повторно. Потеря очереди восстанавливается сканированием
архивированных train-эпизодов без подтверждённого validation event.

## Событие

```text
validation_event
  schema_version
  event_id
  idempotency_key
  attempt_id
  episode_receipt_id
  episode_content_hash
  memory_snapshot_id | null
  has_learning_candidates — boolean
  learning_candidate_count
  has_memory_feedback — boolean
  memory_feedback_count
  created_at
```

Рекомендуемые идентификаторы:

```text
event_id
  {attempt_id}:validation:{episode_content_hash}

idempotency_key
  {event_id}:{schema_version}
```

Повтор события с тем же ключом и содержимым не создаёт вторую логическую работу. Исправленная
версия episode имеет новый content hash и создаёт новое событие, связанное с предыдущей через
версионирование episode.

## Состояния доставки

```text
validation_event_delivery
  pending_episode
  pending_publish
  published
  not_needed
  retryable_failure
  permanent_failure
```

| Состояние | Значение |
|---|---|
| `pending_episode` | Episode ещё не принят архивом. |
| `pending_publish` | Receipt получен, событие готово к публикации. |
| `published` | Очередь подтвердила идемпотентный приём. |
| `not_needed` | Episode не содержит feedback или candidates для validation-контура. |
| `retryable_failure` | Публикацию можно повторить тем же payload. |
| `permanent_failure` | Схема или права не позволяют доставку; требуется оператор. |

`RECORDED` попытки не зависит от синхронной публикации события: episode payload и event draft уже
находятся в durable outbox.

## Состояния обработки

```text
validation_event_processing
  available
  claimed
  processed
  retryable_failure
  dead_letter
```

```text
event_claim
  event_id
  consumer_id
  validation_run_id
  claimed_at
  lease_expires_at
```

- Claim имеет ограниченный lease.
- После истечения lease событие снова доступно.
- Несколько доставок одного event ID дедуплицируются валидатором.
- `processed` устанавливается только после долговечной записи результатов валидации или явного
  решения, что событие не содержит работы.
- Permanent parsing/provenance error переводит событие в `dead_letter` и сохраняет причину.

## Чтение episode

Validator запрашивает episode по `episode_receipt_id` и проверяет:

```text
episode.receipt_id == event.episode_receipt_id
episode.attempt_id == event.attempt_id
episode.content_hash == event.episode_content_hash
episode.dataset_assignment.split == train
```

Несовпадение не исправляется выбором «последней» версии. Событие получает retryable или permanent
ошибку согласно причине.

## Использование source memory snapshot

`memory_snapshot_id` описывает версию памяти, доступную во время blind solve. Validator проверяет:

```text
event.memory_snapshot_id == episode.attempt_context.solve_config.memory_snapshot_id
episode.answer_snapshot.solve_config_reference resolves to the same solve config
retrieval_trace.requested_snapshot_id == event.memory_snapshot_id
retrieval_trace.served_snapshot_id == event.memory_snapshot_id
```

Для memory-off попытки event содержит `null`, а retrieval trace не должен утверждать обслуженный
snapshot.

Snapshot используется по-разному для feedback и нового candidate:

- `memory_feedback` применяется только к `knowledge_id` и `knowledge_version`, реально входившим в
  source snapshot; feedback старой версии не переносится автоматически на successor;
- `retrieval_missed`, `knowledge_missing` и novelty кандидата интерпретируются относительно знаний,
  доступных в source snapshot, а не относительно более нового active catalog;
- если active catalog уже содержит эквивалентное более новое знание, candidate объединяется или
  получает `superseded`, а не считается новой независимой находкой;
- возраст snapshot сам по себе не запрещает visual validation нового candidate: grounded cue и
  ground truth проверяются по episode и текущей validation policy;
- если manifest source snapshot недоступен, feedback получает `unresolved_snapshot`, а выводы о
  missing/retrieval не используются до восстановления manifest. Независимая visual-проверка
  candidate может продолжиться с явным provenance warning.

Таким образом, validator не «валидирует по старому snapshot». Snapshot фиксирует информационное
состояние исходной попытки и точную версию знания, к которой относится feedback.

## Извлечение feedback и candidates

После проверки validator получает из episode:

```text
validation_event_payload
  attempt_id
  data_group_references
  solve_quality
  learning_candidates[]
  learning_decision
  memory_feedback[]
```

Feedback и candidates сохраняют один `source_attempt_id` и один контекст независимости. Несколько
записей одного episode не считаются несколькими независимыми подтверждениями.

`applicability_decision` из feedback агрегируется отдельно от helpful/harmful assessment:

- `reject` означает, что извлечённое правило не прошло gate в текущей сцене;
- `unresolved` означает недостаток видимости или контекста;
- `use` позволяет оценивать фактическое влияние записи.

## Ordering

Глобальный порядок событий не гарантируется и не требуется. Для одного `attempt_id` версии
обрабатываются по episode lineage. При появлении исправленной версии validator:

- не удаляет результаты прежней молча;
- помечает зависимые validation records как требующие пересмотра;
- создаёт новую производную версию результата.

## Retry и восстановление

| Ошибка | Действие |
|---|---|
| Episode ещё не читается после accepted receipt | Повторить чтение в пределах retry policy. |
| Временная недоступность queue | Повторить publish того же event. |
| Lease истёк | Разрешить другому consumer повторную идемпотентную обработку. |
| Content hash mismatch | Не читать другую версию; dead-letter или операторская проверка. |
| Validator недоступен | Событие остаётся available. |
| Результат сохранён, ack потерян | Повторно проверить idempotency key результата и подтвердить event. |

## Приватность и безопасность

- Событие не содержит изображение, OCR, адрес или полный feedback.
- `episode_receipt_id` является scoped reference и не предоставляет произвольный доступ к архиву.
- Consumer получает только train-эпизоды, разрешённые validation policy.
- Содержимое episode считается данными и не исполняется как инструкции валидатору.
- Retention очереди не расширяет retention исходного episode.

## Инварианты

- Episode archive является source of truth.
- Событие публикуется только после accepted receipt.
- Event ID и обработка идемпотентны.
- Queue не дублирует полный candidate или feedback payload.
- Validator проверяет attempt ID, content hash и train split.
- Один episode остаётся одной независимой context group.
- Потерянные события восстанавливаются по архиву.
- Ack происходит после долговечной записи результата.

## Критерии завершения доставки

Доставка одной попытки в validation-контур завершена, когда:

1. episode принят архивом;
2. event содержит совпадающие receipt, attempt ID и content hash;
3. queue подтвердила event ID;
4. validator обработал событие либо сохранил явный terminal reason;
5. результат записан до ack;
6. retry/dead-letter состояние наблюдаемо.
