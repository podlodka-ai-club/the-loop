---
type: Workflow
title: Цикл оценки памяти Loci
description: Воспроизводимое сравнение версий памяти на замороженном benchmark и принятие решения о публикации или откате.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, evaluation, benchmark, memory]
---

# Цикл оценки памяти Loci

## Назначение

Цикл определяет, улучшает ли кандидат версии памяти работу Loci. Он сравнивает условия с памятью
и без неё на одном замороженном наборе фотографий при одинаковых модели, промпте, инструментах и
вычислительном бюджете.

Оценка отделяет факты:

- запись была принята памятью;
- запись была извлечена;
- запись изменила ответ;
- изменение ответа улучшило итоговую геолокацию;
- эффект переносится на независимые места и источники изображений.

Только последнее сравнение позволяет утверждать, что система обучилась лучше решать задачу.

## Входы

```text
evaluation_input
  candidate_memory_snapshot
  active_memory_snapshot | null
  benchmark
  evaluation_config
  publication_policy
```

`candidate_memory_snapshot` создаётся [циклом валидации](validate.md). Он не становится рабочей
версией до завершения regression gate.

## Результат

```text
evaluation_report
  report_id
  benchmark_version
  run_matrix
  geolocation_metrics
  calibration_metrics
  memory_metrics
  cost_metrics
  slice_metrics
  regressions[]
  decision — publish | reject | rollback | inconclusive
  created_at
```

## Принципы

- Benchmark заморожен до запуска сравнения.
- Test не изменяет память, политики, промпты и выбор примеров.
- Условия сравнения отличаются только исследуемым фактором.
- Каждый ответ фиксируется до доступа к ground truth.
- Результаты считаются попарно на одних и тех же примерах.
- Общая метрика дополняется разрезами и хвостом распределения ошибок.
- Статистическая неопределённость эффекта сохраняется вместе с точечной оценкой.
- Публикация памяти обратима.

## Состояния

```text
PLANNED
  → FROZEN
  → RUNNING
  → ANALYZED
  → DECIDED
      ├→ PUBLISHED
      ├→ REJECTED
      ├→ ROLLED_BACK
      └→ INCONCLUSIVE
```

| Состояние | Результат |
|---|---|
| `PLANNED` | Выбраны snapshot, benchmark, условия и метрики. |
| `FROZEN` | Хэши всех входов зафиксированы до запуска. |
| `RUNNING` | Выполняются изолированные слепые прогоны. |
| `ANALYZED` | Рассчитаны общие, попарные и slice-метрики. |
| `DECIDED` | Применена версия publication policy. |
| `PUBLISHED` | Кандидат назначен активной версией памяти. |
| `REJECTED` | Кандидат не прошёл gate и не публикуется. |
| `ROLLED_BACK` | Активная версия заменена ранее принятой. |
| `INCONCLUSIVE` | Данных недостаточно или сравнение признано некорректным. |

## Фаза 1. Подготовка benchmark

### 1. Состав

```text
benchmark
  benchmark_id
  benchmark_version
  sample_ids[]
  group_ids[]
  split — validation | test
  source_distribution
  geography_distribution
  scene_distribution
  request_context_policy_version
  created_at
  content_hash
```

В benchmark не входят:

- near-duplicate train-изображений;
- соседние кадры train-панорам;
- те же `location_cluster_id` и `capture_session_id`;
- примеры, использованные при создании или подтверждении оцениваемых знаний;
- изображения с недостоверным или недостаточно точным ground truth.

Validation benchmark разрешено использовать для выбора порогов и предварительной диагностики.
Test benchmark используется только для итогового решения и не должен многократно направлять
ручную или автоматическую настройку.

### 2. Репрезентативность

Набор стратифицируется по:

- стране и крупному региону;
- типу источника изображения;
- городским, сельским и природным сценам;
- наличию текста, дорог, архитектуры и узнаваемых объектов;
- сложности и ожидаемому географическому уровню;
- качеству, разрешению и времени съёмки.

Одновременно полезен отдельный challenge set из редких и трудных случаев. Его метрики не
смешиваются с оценкой репрезентативного пользовательского распределения.

### 3. Защита benchmark

- Ground truth доступен только оценочному оркестратору.
- Агент не выполняет учебный post-analysis на test.
- Test-эпизоды не создают `learning_candidate` или `memory_feedback`.
- Их данные не поступают в [валидацию знаний](validate.md) и
  [отбор train-примеров](select.md).
- Любое раскрытие или изменение состава создаёт новую версию benchmark.

## Фаза 2. Фиксация конфигурации

### 4. Evaluation config

```text
evaluation_config
  config_id
  agent_version
  model_id
  prompt_version
  decoding_config
  image_preprocessing_version
  tool_contract_versions
  geocoder_provider
  geocoder_version
  inference_budget
  calibration_policy_by_condition
  require_point_estimate — true
  randomization_policy
  repetitions
  metric_definitions_version
```

Если меняется любой из этих параметров, сравнение с предыдущим отчётом помечается как непарное
либо выполняется заново для всех условий.

Calibration policy привязана к model, prompt, memory snapshot и metric definitions. Несовместимая
policy не переносится на новую конфигурацию только ради сохранения прежних confidence.

### 5. Матрица условий

Минимальная матрица:

```text
A — memory off
B — active memory snapshot
C — candidate memory snapshot
```

Если активной памяти ещё нет, достаточно `A` и `C`. Все условия запускаются изолированно: ответ
одного условия не попадает в контекст другого.

При диагностике добавляются абляции:

```text
D — только проверенные physical-world знания
E — без capture-artifact знаний
F — только feature retrieval pass
G — candidate snapshot без новых знаний конкретного класса
```

Абляции помогают найти причину эффекта, но не заменяют основное сравнение candidate против active
и memory off.

### 6. Порядок и повторения

- Порядок условий рандомизируется по примеру.
- При недетерминированной модели выполняется заданное число повторений.
- Сохраняются seed или доступный идентификатор генерации.
- Timeout и ошибки инструментов учитываются как часть результата, а не молча исключаются.
- Для каждого условия фиксируется точный `memory_snapshot_id`.

### 6.1. Калибровка условий

На validation каждый condition сначала возвращает raw confidence и uncertainty. По ним создаётся
версионированная calibration policy:

```text
calibration_policy
  policy_id
  model_id
  prompt_version
  memory_snapshot_id | null
  source_cohorts
  confidence_mapping
  uncertainty_adjustment
  metric_definitions_version
  fitted_on_validation_version
```

До test policy и её cohort rules замораживаются. Test применяет её через общий solver, но не
изменяет mappings по результату. Publication активирует candidate memory snapshot и совместимую
calibration policy как одну production-конфигурацию.

## Фаза 3. Выполнение

### 7. Слепой прогон

Каждый benchmark-пример проходит общий [слепой цикл геолокации](../locate.md), тот же самый, что
используют production-инференс и train-попытка:

```text
locate_request
  request_id
  image_ref
  request_context
  solve_config
    caller — validation | test | shadow
    memory_mode — off | snapshot
    memory_snapshot_id
    calibration_mode — evaluation
    require_point_estimate — true

→ immutable answer_snapshot
```

Для `memory off` инструмент памяти недоступен. Уверенность не должна автоматически снижаться
только из-за знания агентом названия экспериментального условия; это техническая конфигурация,
а не часть пользовательского задания.

Название условия и наличие ground truth не передаются модели. Изменение общего solver требует
повторного запуска всех сравниваемых условий, а не только candidate snapshot.

### 8. Оценка

После фиксации ответа оркестратор раскрывает ground truth только оценочному контуру и рассчитывает
те же детерминированные поля, что и для train-попытки. Test не продолжает grounded review.

### 9. Trace

Для воспроизводимости сохраняются:

- все наблюдения и кандидаты;
- полные безопасные retrieval traces;
- latency и tool failures;
- версии и хэши входов;
- итоговый ответ и uncertainty;
- детерминированная evaluation;
- идентификатор условия и повтора.

## Фаза 4. Метрики

### 10. Геолокация

```text
geolocation_metrics
  country_accuracy
  region_accuracy
  locality_accuracy
  top_1_accuracy
  top_3_accuracy
  distance_median
  distance_p75
  distance_p90
  distance_p95
  catastrophic_error_rates
  bounded_or_log_distance_loss
```

Средняя необрезанная дистанция не используется как единственный итог: её могут определять
несколько огромных ошибок. Медиана также не используется отдельно, потому что скрывает хвост.

### 11. Калибровка

```text
calibration_metrics
  brier_by_level
  reliability_bins
  uncertainty_coverage_50
  uncertainty_coverage_80
  uncertainty_coverage_95
  mean_radius_by_coverage
  selective_accuracy
```

Покрытие оценивается вместе с размером круга. Огромный радиус не считается хорошим прогнозом
только потому, что содержит истину.

### 12. Эффект памяти

```text
memory_metrics
  retrieval_success_rate
  retrieved_items_per_attempt
  used_item_rate
  candidate_change_rate
  selected_location_change_rate
  helpful_change_rate
  harmful_change_rate
  paired_quality_delta
```

На test нет постфактум `memory_feedback`, поэтому helpful/harmful определяется детерминированным
парным сравнением результата условий, а не самооценкой агента.

Примеры:

- память помогла, если изменила ответ и уменьшила заданную loss;
- память навредила, если изменила ответ и увеличила loss;
- memory-neutral не означает, что retrieval был нерелевантен: агент мог сохранить тот же ответ,
  но изменить калибровку или обоснование.

### 13. Стоимость и надёжность

```text
cost_metrics
  latency_p50
  latency_p95
  tokens
  memory_calls
  geocoder_calls
  timeout_rate
  tool_error_rate
```

Улучшение точности должно оцениваться вместе с дополнительной задержкой и стоимостью.

### 14. Разрезы

Метрики рассчитываются как минимум по:

- географии;
- source domain и campaign;
- типу сцены;
- сложности;
- наличию текста;
- классу знания;
- уровню уверенности;
- случаям с retrieval и без него.

Macro-агрегация не позволяет нескольким частым странам скрыть регрессию на остальных. Для малых
разрезов указывается широкая неопределённость, а не делается сильный вывод.

## Фаза 5. Статистический анализ

### 15. Парные различия

Основной эффект считается на одном и том же наборе примеров:

```text
delta_candidate_vs_active
delta_candidate_vs_memory_off
```

Для каждой основной метрики сохраняются точечная оценка, доверительный или совместимый с принятой
методологией интервал и число независимых групп.

### 16. Learning curve

Качество строится по:

- числу валидированных знаний;
- числу независимых train-групп;
- классам добавленных знаний;
- версиям памяти.

Количество сохранённых эпизодов отдельно не считается объёмом полезного обучения.

### 17. Проверка утечки

Перед решением повторно проверяются:

- пересечение image/perceptual hashes;
- пересечение location и capture groups;
- попадание benchmark attempt IDs в provenance знаний;
- появление ground truth в retrieval content;
- изменение benchmark после `FROZEN`;
- использование test в выборе порогов.

Обнаруженная утечка переводит отчёт в `inconclusive`, независимо от показанных метрик.

## Фаза 6. Regression gate

### 18. Publication policy

```text
publication_policy
  policy_version
  primary_metrics[]
  minimum_improvement
  maximum_allowed_regressions
  catastrophic_error_limit
  calibration_limit
  latency_limit
  required_slices[]
  uncertainty_rule
```

Порог задаётся до анализа test. Он может разрешать небольшую нейтральную общую разницу, если
версия закрывает важный заранее определённый пробел без регрессий в критических группах.

### 19. Решение

```text
evaluation_decision
  candidate_snapshot_id
  baseline_snapshot_id | null
  decision — publish | reject | rollback | inconclusive
  reasons[]
  regressions[]
  approved_by
  decided_at
```

- `publish` назначает candidate активной версией;
- `reject` сохраняет snapshot для анализа, но не активирует;
- `rollback` возвращает ранее опубликованную версию;
- `inconclusive` требует исправить эксперимент или увеличить данные без интерпретации результата
  как успеха или провала.

### 20. Публикация и откат

Активация выполняется атомарным переключением `active_memory_snapshot_id` и совместимого
`calibration_policy_id`. Предыдущая пара не удаляется. После публикации запускается ограниченный
мониторинг рабочего распределения; он может инициировать rollback, но пользовательские запросы
сами по себе не становятся train-эпизодами без отдельного разрешённого процесса обратной связи.

## Связь со следующим отбором

Отчёт создаёт диагностические сигналы:

```text
evaluation_gap
  slice
  error_type
  affected_knowledge_ids[]
  desired_examples
  priority
```

Они передаются в [цикл отбора](select.md). Test сообщает только агрегированные пробелы; его
конкретные примеры не копируются в train и не становятся шаблонами для подгонки.

## Инварианты

- Benchmark и конфигурация фиксируются до запусков.
- Ground truth скрыт до каждого answer snapshot.
- Условия выполняются изолированно.
- Test не создаёт feedback, кандидаты или активные знания.
- Candidate и baseline сравниваются на одинаковых независимых группах.
- Изменение модели или промпта требует повторного baseline.
- Ошибки инструментов входят в оценку.
- Общая метрика не скрывает критические slice-регрессии.
- Утечка делает отчёт недействительным.
- Публикация использует версионированную policy.
- Предыдущая активная версия остаётся доступной для rollback.

## Критерии завершения

Цикл завершён, когда:

1. входы и конфигурация имеют хэши и версии;
2. выполнены все обязательные условия run matrix;
3. рассчитаны попарные, slice-, calibration- и cost-метрики;
4. выполнена проверка утечки;
5. сохранены неопределённость эффекта и регрессии;
6. принято решение по заранее заданной policy;
7. публикация или откат выполнены атомарно либо явно не требуются;
8. диагностические пробелы переданы следующему циклу отбора.

## За пределами цикла

- создание учебных гипотез;
- изменение содержимого знаний во время benchmark;
- выбор порогов по test;
- обучение весов модели;
- оценка продукта по неразмеченной пользовательской обратной связи.
