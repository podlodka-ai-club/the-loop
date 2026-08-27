---
type: Workflow
title: Обучение Loci
description: Последовательное накопление текстового опыта в выбранной системе памяти после раскрытия правильного места.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, memory, training]
---

# Обучение Loci

## Назначение

Обучение проходит по подготовленному train-корпусу и изменяет только внешнюю память. На каждом
примере Loci сначала решает задачу без ground truth, затем получает правильное место, формулирует
короткие заметки для будущих задач и добавляет их в память.

Обучение не сравнивается с baseline, не рассчитывает общий score и не решает, стало ли качество
лучше. Это делает отдельный [цикл оценки](evaluate.md).

## Вход

```text
training_run
  run_id
  corpus_ref
  memory_snapshot_id | null
  runner_config_id
```

`corpus_ref` разрешается в общий [`corpus_manifest`](models.md#corpus-manifest), а
`runner_config_id` — в [`runner_config`](models.md#runner-config). Ground truth хранится в
закрытом контексте оркестратора и не входит в запрос решателя.
`memory_snapshot_id: null` означает обучение без подключённой системы памяти; заметки в таком
режиме не сохраняются. Поле `memory_snapshot_id` — историческое имя opaque ID привязки к системе
памяти, а не идентификатор версии данных.
Для каждого sample оркестратор создаёт стабильный `attempt_id` из `run_id` и `sample_id`.

## Результат

```text
training_result
  run_id
  status — completed | aborted
  abort_reason | null
  corpus_ref
  runner_config_id
  memory_snapshot_id | null
  processed_samples
  failed_samples
  remaining_samples
  notes_added
```

`memory_snapshot_id` указывает на выбранную привязку к системе памяти и остаётся одним и тем же
на протяжении run; новый ID после записи не создаётся. Состояние провайдера может изменяться
последовательными training-записями. `processed_samples`
считает успешно завершённые шаги, включая шаги без новых notes. `failed_samples` считает начатые
шаги, завершившиеся terminal error до или после reveal. `remaining_samples` — часть корпуса, не
начатая из-за abort; сумма трёх counters равна размеру корпуса. `notes_added` считает заметки,
принятые `memory_store`; при `memory_snapshot_id: null` он равен нулю.

## Цикл

Для каждого примера оркестратор выполняет пять шагов.

### 1. Слепой ответ

Оркестратор вызывает [слепую геолокацию](locate.md) с `runner_config_id` и выбранной привязкой к
системе памяти. Если `memory_snapshot_id: null`, попытка выполняется без памяти.

Решателю доступно только изображение. Ground truth недоступен.

### 2. Фиксация

Полученный [`answer_snapshot`](models.md#answer-snapshot) фиксируется до reveal. После этого
слепой ответ не изменяется и не запускается повторно в том же обучающем шаге.

При `unavailable` или `timeout` памяти оркестратор повторяет sample в новом blind context с теми же
runner config и memory binding. Число попыток ограничено `runner_config.retry_policy.max_sample_attempts`.
`invalid_request` завершает только текущий sample. Ошибка общей доступности memory binding или
исчерпание retry дополнительно переводит весь run в `aborted`. Ground truth не раскрывается, а
выбранная привязка не переключается.

`locate_with_retries` возвращает blind answer при доступной memory binding. Binding-level ошибка
(`memory_not_found`, `memory_mismatch` или исчерпание retry) возвращается отдельным terminal
outcome до reveal; sample-specific `invalid_request` возвращается как failed sample без reveal.
Production может использовать тот же `locate` в degraded режиме, но training этого не делает.

### 3. Reveal

Для успешного шага оркестратор раскрывает правильное место. Рефлексия выполняется в новом чистом
контексте, который содержит только изображение, зафиксированный `answer_snapshot` со всеми memory
calls и ground truth. Внутренний контекст blind solver не продолжается.

### 4. Рефлексия

Агент сравнивает ответ с ground truth, учитывает влияние полученных заметок и формулирует ноль или
несколько [`memory_note_input`](models.md#memory-notes). Заметка должна быть понятна без
исходного эпизода и помогать решать новые фотографии.

Если полезного обобщения нет, заметка не создаётся.

### 5. Обновление памяти

Если заметки есть и задан `memory_snapshot_id`, оркестратор вызывает
[`memory_store`](../tools/memory_store.md), передавая выбранную привязку и `attempt_id`. Инструмент
изменяет ту же систему памяти и возвращает тот же ID привязки.

Если заметок нет, система памяти не изменяется.

`memory_store_with_retries` возвращает результат или `memory_binding_failure` с кодом ошибки;
неясный результат записи не используется как повод сменить привязку.

```text
memory_binding = memory_snapshot_id
status = completed
abort_reason = null

for sample in corpus:
  attempt_id = run_id + ":" + sample.sample_id
  answer = locate_with_retries(
    sample.image,
    runner_config_id,
    memory_binding,
    retry_on=[unavailable, timeout]
  )
  if answer is null:
    failed_samples += 1
    continue
  if answer is memory_binding_failure:
    failed_samples += 1
    status = aborted
    abort_reason = answer.error
    break
  if answer is sample_memory_failure:
    failed_samples += 1
    continue
  notes = reflect(answer, sample.ground_truth)
  if notes and memory_binding is not null:
    stored = memory_store_with_retries(memory_binding, attempt_id, notes)
    if stored is memory_binding_failure:
      failed_samples += 1
      status = aborted
      abort_reason = stored.error
      break
    if stored is null:
      failed_samples += 1
      continue
  processed_samples += 1

remaining_samples = corpus.size - processed_samples - failed_samples
return training_result(status, abort_reason, memory_binding, counters)
```

## Ошибки

- Сбой до reveal повторяется только в новом blind context и не изменяет память.
- `memory_not_found`, `memory_mismatch` или исчерпание retry для `unavailable/timeout`
  означают общую недоступность выбранной системы памяти и прерывают training-run, чтобы не создавать каскад
  одинаковых failures.
- Sample-specific `invalid_request` помечает только текущий sample как failed и не останавливает run.
- Сбой после reveal не разрешает повторно продолжать прежний blind context; `memory_store`
  повторяется тем же payload не более `runner_config.retry_policy.max_store_attempts`, а при
  terminal failure sample учитывается в `failed_samples`.
- Недоступность памяти не допускает reveal для текущего sample и не переключает memory binding.
- Неудачный training-run не откатывает записи в провайдере автоматически; восстановление состояния
  выполняется политикой конкретного адаптера или отдельным manifest/ledger.

## Инварианты

- Ground truth скрыт до фиксации ответа.
- Обучение изменяет только память, а не веса модели и не общий solver.
- Каждый шаг видит ровно одну закреплённую привязку к системе памяти.
- Новая заметка сохраняет ссылку на создавшую её попытку.
- Провайдер памяти может быть mutable; его versioning, если он есть, не является частью этого
  workflow-контракта.
- Внутри обучения нет baseline-run, score, A/B-сравнения или валидации отдельных заметок.
- Порядок samples и content hash задаёт `corpus_ref`.
- Train-корпус не пересекается с eval-корпусом по `data_group_id`.

## За пределами цикла

- подготовка и очистка train-корпуса;
- оценка эффективности памяти;
- выбор memory binding для production;
- редактирование весов модели;
- автоматическое обучение по пользовательским запросам.
