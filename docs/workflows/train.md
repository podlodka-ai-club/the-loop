---
type: Workflow
title: Обучение Loci
description: Последовательная передача обучающих эпизодов во внешнюю память после раскрытия правильного места.
timestamp: 2026-08-27T00:00:00+03:00
tags: [loci, workflow, learning, memory, training]
---

# Обучение Loci

## Назначение

Обучение проходит по подготовленному train-корпусу и изменяет только внешнюю память. На каждом
примере Loci сначала решает задачу без ground truth, затем получает правильное место, выполняет
рефлексию и передаёт её текст в выбранную систему памяти.

Система памяти сама решает, как извлечь, связать, консолидировать или сохранить опыт. Loci не
требует создания атомарных заметок и не управляет внутренними memory objects.

Обучение не сравнивается с baseline, не рассчитывает общий score и не решает, стало ли качество
лучше. Это делает отдельный [цикл оценки](evaluate.md).

## Вход

```text
training_run
  run_id
  corpus_ref
  memory_ref | null
  runner_config_id
```

`corpus_ref` разрешается в общий [`corpus_manifest`](models.md#corpus-manifest), а
`runner_config_id` — в [`runner_config`](models.md#runner-config). Ground truth хранится в
закрытом контексте оркестратора и не входит в запрос решателя.

`memory_ref: null` означает обучение без подключённой памяти; рефлексия может выполняться, но её
результат не сохраняется.

## Результат

```text
training_result
  run_id
  status — completed | aborted
  abort_reason | null
  corpus_ref
  runner_config_id
  memory_ref | null
  processed_samples
  failed_samples
  remaining_samples
  experiences_submitted
```

`memory_ref` остаётся одной и той же на протяжении run. `processed_samples` считает успешно
завершённые шаги, включая шаги без полезной рефлексии или запуск без памяти. `failed_samples`
считает начатые шаги, завершившиеся terminal error до или после reveal. `remaining_samples` — часть
корпуса, не начатая из-за abort; сумма трёх counters равна размеру корпуса.
`experiences_submitted` считает успешные вызовы `memory_store`; при `memory_ref: null` он равен нулю.

## Цикл

Для каждого примера оркестратор выполняет пять шагов.

### 1. Слепой ответ

Оркестратор вызывает [слепую геолокацию](locate.md) с `runner_config_id` и выбранной `memory_ref`.
Если `memory_ref: null`, попытка выполняется без памяти.

Решателю доступно только изображение. Ground truth недоступен.

### 2. Фиксация

Полученный [`answer_snapshot`](models.md#answer-snapshot) фиксируется до reveal. После этого
слепой ответ не изменяется и не запускается повторно в том же обучающем шаге.

При `unavailable` или `timeout` памяти оркестратор повторяет sample в новом blind context с теми же
runner config и `memory_ref`. Число попыток ограничено
`runner_config.retry_policy.max_sample_attempts`. `invalid_request` завершает только текущий
sample. Ошибка общей доступности памяти или исчерпание retry переводит весь run в `aborted`.
Ground truth не раскрывается, а выбранная память не переключается.

`locate_with_retries` возвращает blind answer при доступной памяти. Общая ошибка
(`memory_not_found`, `memory_mismatch` или исчерпание retry) возвращается отдельным terminal outcome
до reveal; sample-specific `invalid_request` возвращается как failed sample без reveal. Production
может использовать тот же `locate` в degraded режиме, но training этого не делает.

### 3. Reveal

Для успешного шага оркестратор раскрывает правильное место. Рефлексия выполняется в новом чистом
контексте, который содержит только изображение, зафиксированный `answer_snapshot` со всеми memory
calls и ground truth. Внутренний контекст blind solver не продолжается.

### 4. Рефлексия

Агент сравнивает ответ с ground truth, учитывает влияние результата памяти и формирует `content`
для [`memory_store`](../tools/memory_store.md): самостоятельную произвольную прозу, предпочтительно
в Markdown.

Желаемая структура описывает наблюдаемые признаки, слепой ответ и альтернативы, правильное место,
разбор успеха или ошибки и переносимый опыт. Это prompt-конвенция, а не JSON schema: разделы можно
объединять, переставлять, дополнять или пропускать.

Если эпизод не даёт полезного материала для будущих задач, `content` не создаётся.

### 5. Обновление памяти

Если `content` создан и задана `memory_ref`, оркестратор вызывает `memory_store`. Инструмент
передаёт текст выбранному provider и возвращает его нативный payload. Loci не проверяет, какие
внутренние memories созданы и когда завершатся фоновые extraction или consolidation.

Если `content` отсутствует, система памяти не вызывается.

```text
memory = memory_ref
status = completed
abort_reason = null

for sample in corpus:
  answer = locate_with_retries(
    sample.image,
    runner_config_id,
    memory,
    retry_on=[unavailable, timeout]
  )
  if answer is null:
    failed_samples += 1
    continue
  if answer is memory_failure:
    failed_samples += 1
    status = aborted
    abort_reason = answer.error
    break
  if answer is sample_memory_failure:
    failed_samples += 1
    continue
  content = reflect(answer, sample.ground_truth)
  if content and memory is not null:
    stored = memory_store(memory, content)
    if stored is null:
      failed_samples += 1
      continue
    experiences_submitted += 1
  processed_samples += 1

remaining_samples = corpus.size - processed_samples - failed_samples
return training_result(status, abort_reason, memory, counters)
```

## Ошибки

- Сбой до reveal повторяется только в новом blind context и не изменяет память со стороны Loci.
- `memory_not_found`, `memory_mismatch` или исчерпание retry для retrieval означают общую
  недоступность выбранной памяти и прерывают training-run.
- Sample-specific `invalid_request` retrieval помечает только текущий sample как failed.
- После reveal общий оркестратор не повторяет `memory_store` при `timeout`: провайдер мог принять
  content, а контракт не требует идемпотентности.
- Terminal failure `memory_store` помечает текущий sample как failed; выбранная память не
  переключается и уже принятые provider updates не откатываются.

## Инварианты

- Ground truth скрыт до фиксации ответа.
- Обучение изменяет только память, а не веса модели и не общий solver.
- Каждый шаг использует не более одной закреплённой `memory_ref`.
- Loci передаёт один текстовый training experience и не управляет внутренней моделью памяти.
- Внутри обучения нет baseline-run, score, A/B-сравнения или валидации отдельных memory objects.
- Порядок samples и content hash задаёт `corpus_ref`.
- Train-корпус не пересекается с eval-корпусом по `data_group_id`.

## За пределами цикла

- подготовка и очистка train-корпуса;
- оценка эффективности памяти;
- выбор `memory_ref` для production;
- редактирование весов модели;
- автоматическое обучение по пользовательским запросам.
