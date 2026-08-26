---
type: Workflow
title: Обучение Loci
description: Последовательное накопление текстового опыта в версионированной памяти после раскрытия правильного места.
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
  base_memory_snapshot_id | null
  runner_config_id
```

`corpus_ref` разрешается в общий [`corpus_manifest`](models.md#corpus-manifest), а
`runner_config_id` — в [`runner_config`](models.md#runner-config). Ground truth хранится в
закрытом контексте оркестратора и не входит в запрос решателя.
`base_memory_snapshot_id: null` означает начало с пустой памяти.
Для каждого sample оркестратор создаёт стабильный `attempt_id` из `run_id` и `sample_id`.

## Результат

```text
training_result
  run_id
  status — completed | aborted
  abort_reason | null
  corpus_ref
  runner_config_id
  base_memory_snapshot_id | null
  memory_snapshot_id | null
  processed_samples
  failed_samples
  remaining_samples
  notes_added
```

`memory_snapshot_id` указывает на память после последнего успешного шага. Каждый snapshot
неизменяем, поэтому предыдущую версию всегда можно использовать повторно. `processed_samples`
считает успешно завершённые шаги, включая шаги без новых notes. `failed_samples` считает начатые
шаги, завершившиеся terminal error до или после reveal. `remaining_samples` — часть корпуса, не
начатая из-за abort; сумма трёх counters равна размеру корпуса.

## Цикл

Для каждого примера оркестратор выполняет пять шагов.

### 1. Слепой ответ

Оркестратор вызывает [слепую геолокацию](locate.md) с `runner_config_id` и текущим snapshot
памяти. Если `base_memory_snapshot_id: null`, первая попытка выполняется без памяти.

Решателю доступно только изображение. Ground truth недоступен.

### 2. Фиксация

Полученный [`answer_snapshot`](models.md#answer-snapshot) фиксируется до reveal. После этого
слепой ответ не изменяется и не запускается повторно в том же обучающем шаге.

При `unavailable` или `timeout` памяти оркестратор повторяет sample в новом blind context с теми же
runner config и snapshot. Число попыток ограничено `runner_config.retry_policy.max_sample_attempts`.
`invalid_request` завершает только текущий sample. Ошибка общей доступности snapshot или исчерпание
retry дополнительно переводит весь run в `aborted`. Ground truth не раскрывается, а текущий snapshot
не меняется.

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

Если заметки есть, оркестратор вызывает [`memory_store`](../tools/memory_store.md), передавая текущий
snapshot и `attempt_id`. Инструмент возвращает новый immutable snapshot, который используется на
следующем примере.

Если заметок нет, текущий snapshot не меняется.

```text
current_snapshot = base_memory_snapshot_id
status = completed
abort_reason = null

for sample in corpus:
  attempt_id = run_id + ":" + sample.sample_id
  answer = locate_with_retries(
    sample.image,
    runner_config_id,
    current_snapshot,
    retry_on=[unavailable, timeout]
  )
  if answer is null:
    failed_samples += 1
    continue
  if answer has shared_memory_failure:
    failed_samples += 1
    status = aborted
    abort_reason = answer.memory_error
    break
  if any(call.error for call in answer.memory_calls):
    failed_samples += 1
    continue
  notes = reflect(answer, sample.ground_truth)
  if notes:
    stored = memory_store_with_retries(current_snapshot, attempt_id, notes)
    if stored has shared_memory_failure:
      failed_samples += 1
      status = aborted
      abort_reason = stored.error
      break
    if stored is null:
      failed_samples += 1
      continue
    current_snapshot = stored.snapshot_id
  processed_samples += 1

remaining_samples = corpus.size - processed_samples - failed_samples
return training_result(status, abort_reason, current_snapshot, counters)
```

## Ошибки

- Сбой до reveal повторяется только в новом blind context и не изменяет память.
- `snapshot_not_found`, `snapshot_mismatch` или исчерпание retry для `unavailable/timeout`
  означают общую недоступность текущей памяти и прерывают training-run, чтобы не создавать каскад
  одинаковых failures.
- Sample-specific `invalid_request` помечает только текущий sample как failed и не останавливает run.
- Сбой после reveal не разрешает повторно продолжать прежний blind context; `memory_store`
  повторяется тем же payload не более `runner_config.retry_policy.max_store_attempts`, а при
  terminal failure sample учитывается в `failed_samples`.
- Недоступность памяти не допускает reveal для текущего sample и не изменяет snapshot.
- Неудачный training-run можно отбросить целиком, вернувшись к `base_memory_snapshot_id`.

## Инварианты

- Ground truth скрыт до фиксации ответа.
- Обучение изменяет только память, а не веса модели и не общий solver.
- Каждый шаг видит ровно один закреплённый snapshot.
- Новая заметка сохраняет ссылку на создавшую её попытку.
- Snapshot создаётся append-only; его базовая версия не переписывается.
- Внутри обучения нет baseline-run, score, A/B-сравнения или валидации отдельных заметок.
- Порядок samples и content hash задаёт `corpus_ref`.
- Train-корпус не пересекается с eval-корпусом по `data_group_id`.

## За пределами цикла

- подготовка и очистка train-корпуса;
- оценка эффективности памяти;
- выбор snapshot для production;
- редактирование весов модели;
- автоматическое обучение по пользовательским запросам.
