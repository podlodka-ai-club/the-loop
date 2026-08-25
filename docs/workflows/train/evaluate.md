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
  evaluation_trigger_policy
  evaluation_budget
```

`candidate_memory_snapshot` создаётся [циклом валидации](validate.md). Он не становится рабочей
версией до завершения regression gate.

## Результат

```text
evaluation_report
  report_id
  benchmark_version
  stage_outcomes[]
  budget_usage
  run_matrix
  geolocation_metrics
  response_policy_metrics
  hint_metrics
  calibration_metrics
  memory_metrics
  cost_metrics
  slice_metrics
  regressions[]
  production_configuration | null
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

## Политика запуска и стоимость

### Trigger policy

```text
evaluation_trigger_policy
  policy_version
  minimum_new_knowledge
  minimum_changed_knowledge
  maximum_candidate_snapshot_age
  scheduled_full_benchmark_interval
  urgent_regression_trigger
  manual_trigger_allowed
```

Не каждый новый knowledge record запускает полный A/B/C benchmark. Срочная проверка допускается
для исправления harmful knowledge или критического slice, но причина и сокращённая матрица
фиксируются заранее.

### Evaluation budget

```text
evaluation_budget
  max_validation_samples
  max_test_samples
  max_condition_runs
  max_model_calls
  max_tokens
  max_cost
  max_duration_ms
  max_repetitions
```

Budget ограничивает один evaluation run. Исчерпание бюджета до обязательных gate переводит
результат в `inconclusive`, а не позволяет публиковать snapshot по частичным метрикам.

### Staged gate

```text
1. schema_and_snapshot_smoke
2. small_validation_screen — A/C или B/C
3. full_validation — обязательные arms и slices
4. calibration_fit_and_freeze
5. test_regression_gate
6. publication_bundle
```

Следующая стадия запускается только после прохождения предыдущей. Test не используется как дешёвый
screening и выполняется один раз для замороженного кандидата и policy.

## Состояния

```text
PLANNED
  → FROZEN
  → SMOKE_TESTED
  → VALIDATION_SCREENED
  → VALIDATION_COMPLETE
  → CALIBRATION_FROZEN
  → TESTED
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
| `SMOKE_TESTED` | Проверены схемы, snapshots и минимальный retrieval. |
| `VALIDATION_SCREENED` | Кандидат прошёл сокращённый validation screen. |
| `VALIDATION_COMPLETE` | Выполнена полная validation-матрица и обязательные slices. |
| `CALIBRATION_FROZEN` | Calibration policies проверены по sample policy и заморожены. |
| `TESTED` | Один раз выполнен замороженный test regression gate. |
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
  hint_cohort_assignments
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

### 2.1. Контекстные hints

Benchmark содержит заранее определённые cohorts:

```text
no_hint
independent_helpful_hint
independent_noisy_or_misleading_hint
```

Каждый `context_hint` имеет provenance, expected reliability и
`created_before_ground_truth_access: true`. Hint не строится перефразированием ground truth.
Распределение helpful/noisy hints должно соответствовать целевому production-сценарию либо
помечаться как отдельный stress test.

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
  calibration_sample_policy
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

Bp — active snapshot + production response policy
Cp — candidate snapshot + production response policy
R — registered production fallback, memory off + fallback calibration
```

В A/B/C используется `require_point_estimate: true`, чтобы сравнивать distance loss на каждом
примере. В Bp/Cp используется production-значение, обычно `false`, чтобы измерять selective
поведение и честный отказ от точности. Если active memory ещё нет, достаточно A/C/Cp. Все условия
запускаются изолированно.

`memory off` является controlled content ablation: модель, prompt, tools, budget и отсутствие
degraded flag совпадают с остальными arms, а memory content недоступен по design. Это не симуляция
production outage; outage проверяется отдельным fallback reliability test.

Arm R проверяет именно production outage behavior: `degraded: true`, fallback calibrator и
production response policy. Его нельзя использовать вместо A для оценки чистой ценности памяти.

```text
A.execution_mode — controlled_ablation
B/C/Bp/Cp.execution_mode — normal
R.execution_mode — production_fallback
```

Hint dimension применяется как минимум к active и candidate production arms:

```text
H0 — no_hint
H1 — independent_helpful_hint
H2 — independent_noisy_or_misleading_hint
```

Полный Cartesian product необязателен на каждой стадии, но test policy заранее указывает
обязательные memory × response × hint combinations.

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
  effective_sample_size
  parent_policy_id | null
  shrinkage_applied — boolean
```

До test policy и её cohort rules замораживаются. Test применяет её через общий solver, но не
изменяет mappings по результату. Publication активирует candidate memory snapshot и совместимую
calibration policy как одну production-конфигурацию.

```text
calibration_sample_policy
  policy_version
  minimum_global_n
  minimum_cohort_n
  minimum_positive_outcomes
  minimum_negative_outcomes
  minimum_coverage_events
  parent_cohort_order[]
  shrinkage_method
  unsupported_cohort_action — inherit_parent | merge | unavailable
```

Если cohort не достигает minimum effective sample size, его mapping shrink к parent/global policy
либо маркируется unavailable. Номинальное 95% coverage не публикуется как измеренное для cohort с
недостаточным числом coverage events. Test не меняет sample policy или shrinkage.

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
    execution_mode — normal | controlled_ablation | production_fallback
    memory_mode — off | snapshot
    memory_snapshot_id
    calibration_mode — evaluation
    require_point_estimate — true

→ immutable answer_snapshot
```

Название arm и наличие ground truth не передаются модели. В memory-off arm отсутствие retrieval
является контролируемой конфигурацией, а не отказом сервиса. Изменение общего solver требует
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
  located_rate
  ambiguous_rate
  insufficient_evidence_rate
  degraded_rate
  point_estimate_rate
  conditional_accuracy_when_located
  conditional_distance_when_located
  risk_coverage_curve
```

Средняя необрезанная дистанция не используется как единственный итог: её могут определять
несколько огромных ошибок. Медиана также не используется отдельно, потому что скрывает хвост.
Forced-point и production-policy метрики публикуются раздельно. Нельзя улучшить conditional
accuracy простым ростом отказов без отображения located rate и risk-coverage curve.

### 10.1. Hints и constraints

```text
hint_metrics
  cohort_counts
    no_hint
    independent_helpful_hint
    independent_noisy_or_misleading_hint
  helpful_hint_follow_rate
  helpful_hint_quality_delta
  helpful_hint_harm_rate
  misleading_hint_resistance_rate
  misleading_hint_quality_delta
  misleading_hint_override_rate
  constraint_violation_rate
  constraint_conflict_rate
  hint_calibration_delta
```

Метрики считаются попарно относительно H0 на тех же independent groups:

- `helpful_hint_follow_rate` — доля случаев, где H1 сдвинул candidate distribution в сторону
  корректного hint; следование само по себе не считается успехом без положительного quality delta;
- `helpful_hint_quality_delta` — изменение основной geolocation loss в H1 относительно H0;
- `helpful_hint_harm_rate` — доля полезных hints, после которых итоговая loss ухудшилась;
- `misleading_hint_resistance_rate` — доля H2, не ухудшивших выбранную loss и achieved precision;
- `misleading_hint_quality_delta` — изменение loss под шумным или ошибочным hint;
- `misleading_hint_override_rate` — доля случаев, где H2 перевесил более сильные visual evidence;
- `constraint_violation_rate` — ответ вне применимого hard constraint;
- `constraint_conflict_rate` — доля входов, где constraint и visual evidence существенно
  противоречат друг другу, независимо от выбранного ответа;
- `hint_calibration_delta` — изменение calibration error между H0, H1 и H2.

Нарушение constraint и сопротивляемость misleading hint входят в `hint_robustness_limits` и не
скрываются общей средней точностью.

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
- случаям с retrieval и без него;
- response policy и result status;
- hint cohort и provenance;
- degraded/fallback режиму.

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
  response_policy_limits
  hint_robustness_limits
  fallback_reliability_limits
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

Publication step регистрирует полный bundle:

```text
production_configuration
  configuration_id
  primary
    memory_mode — snapshot
    memory_snapshot_id
    calibration_policy_id
    execution_mode — normal
  fallback
    memory_mode — off
    calibration_policy_id | null
    execution_mode — production_fallback
  agent_version
  model_id
  prompt_version
  tool_contract_versions
  geocoder_provider
  geocoder_version
  response_policy_id
  publication_report_id
```

Fallback calibrator строится на memory-off validation arm и проходит reliability limits. Если
выборки недостаточно, fallback использует raw mode и production обязан показывать degraded status.

Активация атомарно переключает весь bundle. Предыдущая конфигурация не удаляется. Rollback также
возвращает primary и fallback вместе. После публикации запускается ограниченный мониторинг
рабочего распределения; пользовательские запросы сами по себе не становятся train-эпизодами без
отдельного разрешённого процесса обратной связи.

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
- Memory-off arm является ablation, а не outage fallback.
- Test не создаёт feedback, кандидаты или активные знания.
- Candidate и baseline сравниваются на одинаковых независимых группах.
- Изменение модели или промпта требует повторного baseline.
- Ошибки инструментов входят в оценку.
- Общая метрика не скрывает критические slice-регрессии.
- Утечка делает отчёт недействительным.
- Публикация использует версионированную policy.
- Недостаточный calibration cohort наследует parent/global policy либо остаётся unavailable.
- Primary и fallback публикуются и откатываются атомарно.

## Критерии завершения

Цикл завершён, когда:

1. входы и конфигурация имеют хэши и версии;
2. выполнены все обязательные условия run matrix;
3. пройдены staged validation gates в пределах budget;
4. calibration cohorts удовлетворяют sample policy либо имеют явный fallback;
5. рассчитаны попарные, response-policy, hint-, slice-, calibration- и cost-метрики;
6. выполнена проверка утечки;
7. сохранены неопределённость эффекта и регрессии;
8. принято решение по заранее заданной policy;
9. primary/fallback bundle опубликован или отклонён атомарно;
10. диагностические пробелы переданы следующему циклу отбора.

## За пределами цикла

- создание учебных гипотез;
- изменение содержимого знаний во время benchmark;
- выбор порогов по test;
- обучение весов модели;
- оценка продукта по неразмеченной пользовательской обратной связи.
