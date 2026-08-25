---
type: Workflow
title: Оценка памяти Loci
description: Сравнение score инференса без памяти и с выбранным memory snapshot на одном независимом корпусе.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, evaluation, benchmark, memory]
---

# Оценка памяти Loci

## Назначение

Оценка отвечает на один вопрос: меняет ли включённая память качество Loci относительно того же
инференса без памяти.

Для этого один и тот же eval-корпус прогоняется два раза:

```text
memory off              → baseline_score
selected memory snapshot → memory_score
```

Обучение во время оценки не выполняется, а память не изменяется.

## Вход

```text
evaluation_run
  run_id
  corpus_ref
  memory_snapshot_id
  runner_config
  scoring_policy_id
```

Eval-корпус содержит изображения и ground truth, но ground truth доступен только scorer после
фиксации каждого ответа. Корпус не используется в [обучении](train.md) и не пересекается с ним.

`runner_config` фиксирует модель, prompt, preprocessing, инструменты и budget. В двух прогонах
совпадает вся runner-конфигурация, а `locate_request` отличается только `memory_snapshot_id`.

## Результат

```text
evaluation_report
  run_id
  corpus_ref
  memory_snapshot_id
  runner_config_hash
  scoring_policy_id
  sample_count
  baseline_score
  memory_score
  delta
```

Scoring policy приводит результат к направлению «больше — лучше»:

```text
delta = memory_score - baseline_score
```

Положительный `delta` означает улучшение относительно инференса без памяти. Workflow возвращает
измерение и не принимает решение о публикации snapshot.

## Прогон 1. Baseline

Каждый пример проходит общий [цикл геолокации](locate.md) с:

```text
memory_snapshot_id: null
```

После фиксации ответа scorer получает ground truth и рассчитывает score по единой policy.
Выключенная память является условием эксперимента, а не ошибкой.

## Прогон 2. Память

Тот же корпус проходит тот же solver с:

```text
memory_snapshot_id: evaluation_run.memory_snapshot_id
```

Snapshot закреплён на весь прогон. После фиксации ответов применяется та же scoring policy.

## Условия сравнения

- Используется один и тот же набор примеров.
- Model, prompt, preprocessing, инструменты, budget и scoring policy совпадают.
- Ground truth отсутствует во входе solver в обоих прогонах.
- Прогоны изолированы и не передают друг другу состояние.
- Timeout и ошибки учитываются одинаково.
- При недетерминированном инференсе используется один и тот же seed.

## Ошибки

- Если один из прогонов завершён не полностью, итоговый report не создаётся.
- Если память недоступна, memory-run считается неуспешным, а не подменяется режимом `memory off`.
- Если обслужен другой snapshot, memory-run считается невалидным.
- Обнаруженное пересечение train- и eval-корпусов делает сравнение недействительным.

## Инварианты

- Оценка состоит ровно из baseline-run и memory-run.
- Внутри оценки память не записывается и не обучается.
- Единственный исследуемый фактор — наличие выбранного snapshot.
- Score обоих прогонов рассчитывается одной функцией на одном корпусе.
- Отдельного сравнения с текущей production-памятью нет.
- Отчёт не содержит автоматического решения `publish` или `reject`.

## За пределами цикла

- создание заметок памяти;
- подбор train-примеров;
- настройка scoring policy по результату текущего eval-корпуса;
- выбор и активация production snapshot.
