---
type: Workflow
title: Оценка памяти Loci
description: Сравнение геодезической ошибки без памяти и с выбранным memory snapshot на одном независимом корпусе.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, evaluation, benchmark, memory]
---

# Оценка памяти Loci

## Назначение

Оценка измеряет общий эффект включения памяти: retrieval-механизма вместе с содержимым выбранного
snapshot. Обучение во время оценки не выполняется.

Один и тот же eval-корпус проходит два раза:

```text
memory_snapshot_id: null      → baseline_mean_distance_km
memory_snapshot_id: selected  → memory_mean_distance_km
```

## Вход

```text
evaluation_run
  run_id
  corpus_ref
  memory_snapshot_id
  runner_config_id
  scoring_policy_id — geodesic-v1
```

`corpus_ref` разрешается в общий [`corpus_manifest`](models.md#corpus-manifest). Ни один
`data_group_id` eval-корпуса не может присутствовать в train-корпусе.

`runner_config_id` ссылается на один [`runner_config`](models.md#runner-config) для обоих
прогонов.

## Результат

```text
evaluation_report
  run_id
  corpus_ref
  memory_snapshot_id
  runner_config_id
  scoring_policy_id
  baseline_run_id
  memory_run_id
  sample_count
  sample_results[]
    sample_id
    baseline_request_id
    memory_request_id
    baseline_distance_km
    memory_distance_km
  baseline_mean_distance_km
  memory_mean_distance_km
  delta_km
```

Score рассчитывается по [контракту `geodesic-v1`](scoring.md):

```text
delta_km = baseline_mean_distance_km - memory_mean_distance_km
```

Положительный `delta_km` означает уменьшение средней ошибки.

## Прогон 1. Без памяти

Каждый sample вызывает [слепую геолокацию](locate.md) с:

```text
request_id: {baseline_run_id}:{sample_id}
runner_config_id: evaluation_run.runner_config_id
memory_snapshot_id: null
```

Ground truth передаётся scorer только после фиксации ответа. `memory_calls` каждого ответа должен
быть пуст.

## Прогон 2. С памятью

Тот же sample вызывает тот же workflow с:

```text
request_id: {memory_run_id}:{sample_id}
runner_config_id: evaluation_run.runner_config_id
memory_snapshot_id: evaluation_run.memory_snapshot_id
```

Snapshot закреплён на весь прогон. Ground truth раскрывается только scorer после ответа.

## Проверка memory-run

Memory-run действителен, если:

- каждый выполненный memory call имеет `error: null`;
- каждый result возвращает запрошенный `snapshot_id`;
- runner config и eval-корпус не менялись между прогонами.

Ошибка памяти не превращается в результат без памяти. При нарушении этих условий memory-run
завершается без `evaluation_report`.

Обычный solver timeout или отсутствие координат не удаляет sample: он получает фиксированный
штраф из scoring contract.

## Ограничения

Один evaluation-run даёт точечную оценку на конкретном корпусе. Одинаковый runner config и seed,
если он поддерживается, не гарантируют полной детерминированности внешней модели.

Workflow не принимает автоматического решения о публикации. После просмотра отчёта оператор может
вручную назначить snapshot активным в production-конфигурации.

## Инварианты

- Оценка состоит ровно из baseline-run и memory-run.
- Память не изменяется в обоих прогонах.
- Каждый sample присутствует в обоих arms и получает score.
- Единственное различие locate requests — `memory_snapshot_id`.
- Ground truth недоступен решателю.
- Train и eval не пересекаются по `data_group_id`.

## За пределами workflow

- создание memory notes;
- автоматический promotion или rollback snapshot;
- статистическая значимость нескольких повторов;
- настройка scoring policy по текущему eval-корпусу.
