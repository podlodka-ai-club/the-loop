---
type: Workflow
title: Цикл обработки обучающей попытки Loci
description: Запуск общего слепого решателя на train-примере, reveal ground truth, оценка, post-analysis и сохранение кандидатов на обучение.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, attempt, memory, geolocation]
---

# Цикл обработки обучающей попытки Loci

## Назначение

Workflow обрабатывает один train-пример. До reveal он вызывает общий
[слепой цикл геолокации](../locate.md), используемый production и benchmark. После фиксации
`answer_snapshot` оркестратор раскрывает ground truth, рассчитывает метрики, выполняет grounded
review и сохраняет кандидаты для [валидации знаний](validate.md).

Попытка сама по себе не изменяет рабочую память и не доказывает обучение. Один эпизод создаёт
непроверенную гипотезу; валидированное знание возникает только в межэпизодном цикле.

## Вход

```text
training_sample
  image_ref
  data_identity
    image_sha256
    perceptual_hash
    near_duplicate_cluster_id
    location_cluster_id
    capture_session_id | null
    campaign_id | null
  dataset_assignment
    dataset_id
    split — train
    split_policy_version
  source_metadata
    source_domain
    source_domain_confidence
    capture_platform | null
    captured_at | null
    image_orientation | null
  task_context
    user_constraints[]
    user_hints[]
    target_precision
    metadata_policy
  ground_truth_envelope
  usage_policy
```

Пример уже выбран [циклом отбора](select.md), отнесён к `split: train` и проверен на пересечение с
validation/test. Ground truth находится только в закрытом контексте оркестратора.

## Результат

```text
episode
  неизменяемая история solve, reveal, evaluation и review

memory_feedback[]
  контекстная оценка извлечённых записей

learning_candidate[]
  атомарные непроверенные гипотезы для карантина валидатора
```

## Ответственность

### Общий решатель

- выполняет все слепые наблюдения и географическое рассуждение;
- использует закреплённый snapshot памяти;
- применяет общий для production/train/evaluate контракт кандидатов и неопределённости;
- не получает ground truth и не пишет во внешние хранилища;
- возвращает неизменяемый `answer_snapshot`.

### Обучающий агент после reveal

- повторно рассматривает изображение и слепой snapshot;
- классифицирует ошибку;
- оценивает влияние каждого извлечённого знания;
- предлагает только визуально обоснованные учебные гипотезы.

### Обучающий оркестратор

- проверяет train-происхождение примера;
- скрывает ground truth до долговечной фиксации snapshot;
- закрепляет solve-конфигурацию;
- рассчитывает детерминированные метрики;
- ведёт состояния и durable outbox;
- не позволяет повторить blind solve после reveal.

## Состояния

```text
RECEIVED
  → STARTED
  → SOLVING
  → ANSWERED
  → REVEALED
  → EVALUATED
  → REVIEWED
  → RECORDED
```

| Состояние | Результат |
|---|---|
| `RECEIVED` | Получен подготовленный train-пример. |
| `STARTED` | Проверены условия и создан контекст попытки. |
| `SOLVING` | Общий blind solver обрабатывает фотографию без ground truth. |
| `ANSWERED` | Полученный `answer_snapshot` долговечно и неизменяемо сохранён. |
| `REVEALED` | Ground truth раскрыт и нормализован. |
| `EVALUATED` | Оркестратор рассчитал метрики. |
| `REVIEWED` | Сформированы post-analysis, feedback и кандидаты. |
| `RECORDED` | Эпизод и исходящие операции сохранены в durable outbox. |

До `ANSWERED` пример может перейти в `EXCLUDED`, если обнаружены повреждение, нарушение usage
policy, утечка истины или недопустимый ground truth. После `ANSWERED` проблема сохраняется как
`ground_truth_issue`; эпизод архивируется, но кандидаты не поступают в валидацию.

Доставки имеют отдельные состояния:

```text
episode_delivery — pending | archived | retryable_failure | permanent_failure
validation_event_delivery — pending_episode | pending_publish | published | not_needed | retryable_failure | permanent_failure
```

## Фаза 1. Admission и контекст

### 1. Проверка предусловий

Оркестратор проверяет:

- `dataset_assignment.split` равен `train`;
- split и group IDs назначены до просмотра результата;
- изображение соответствует `image_sha256`;
- ground truth отсутствует в имени файла, доступных метаданных, user context и инструкциях;
- `label_status` и `accuracy_radius_m` допускают оценку нужного уровня;
- usage policy разрешает обработку и архивирование;
- пример не был ранее обработан с тем же idempotency key.

### 2. Контекст попытки

```text
attempt_context
  attempt_id
  image_ref
  image_sha256
  created_at
  ground_truth_status — hidden
  solve_config
  dataset_assignment_reference
  usage_policy_reference
```

`attempt_id` используется как `locate_request.request_id` и связывает snapshot, reveal,
evaluation, review и исходящие записи.

### 3. Solve config

```text
solve_config
  caller — train
  agent_version
  model_id
  prompt_version
  decoding_config
  image_preprocessing_version
  tool_contract_versions
  execution_mode — normal
  initial_degraded_reasons[]
  memory_mode — off | snapshot
  memory_snapshot_id | null
  geocoder_provider
  geocoder_version
  calibration_policy_id | null
  calibration_mode — published | evaluation | raw
  require_point_estimate — true
  inference_budget
```

Обычная train-попытка использует ту же опубликованную конфигурацию, что production. Специальный
эксперимент может закрепить другую конфигурацию, но она явно сохраняется и не смешивается с
обычными learning curves.

## Фаза 2. Слепой solve

### 4. Locate request

```text
locate_request
  request_id — attempt_id
  image_ref
  request_context
    source_domain
    source_domain_confidence
    capture_platform
    captured_at
    image_orientation
    user_constraints — training_sample.task_context.user_constraints
    user_hints — training_sample.task_context.user_hints
    target_precision — training_sample.task_context.target_precision
    metadata_policy — training_sample.task_context.metadata_policy
  solve_config
```

Закрытые ground truth, dataset assignment и group IDs не входят в запрос решателя.

### 5. Выполнение

Оркестратор запускает [общий blind solver](../locate.md). Он отвечает за:

- структурированные visual observations;
- pre-memory belief;
- решение о retrieval и закреплённый memory snapshot;
- applicability gate и memory-guided reinspection;
- финальное candidate distribution;
- геокодинг и conflict handling;
- raw/calibrated confidence;
- achieved precision, uncertainty и result status.

Train не имеет отдельной версии этих шагов. Изменение blind flow выполняется в `locate.md` и
одновременно применяется production и benchmark.

### 6. Фиксация ответа

Полученный `answer_snapshot` сохраняется append-only вместе с `content_hash`. Только успешная
долговечная запись переводит попытку в `ANSWERED` и разрешает reveal.

Если процесс падает до `ANSWERED`, blind solve можно повторить только при гарантии, что ground truth
не раскрывался агентскому контексту. После reveal snapshot никогда не создаётся повторно.

## Фаза 3. Reveal и оценка

### 7. Ground truth

После `ANSWERED` оркестратор раскрывает:

```text
ground_truth
  coordinates
    latitude
    longitude
  accuracy_radius_m
  country
  country_code
  region
  region_code
  locality
  precision
  source
  verification_method
  label_status — verified | approximate | disputed | invalid
  geocoder_reference
```

Истинные координаты нормализуются через [`geocode_reverse`](/tools/geocode_reverse.md) тем же
provider и версией административных данных, что закреплены в solve config. Результат нормализации
не изменяет исходный snapshot.

`disputed` и `invalid` запрещают формирование кандидатов. `approximate` допускает только уровни,
совместимые с `accuracy_radius_m`.

### 8. Детерминированная evaluation

Оркестратор рассчитывает:

```text
evaluation
  raw_distance_km
  label_adjusted_distance_km
  country_correct
  region_correct
  locality_correct
  truth_in_top_1
  truth_in_top_3
  confidence_outcomes
    country
    region
    locality
  uncertainty_outcomes[]
    coverage
    radius_km
    inside
  result_status
  achieved_precision
  latency_ms
  tool_calls
  retrieved_items
```

`label_adjusted_distance_km` учитывает `accuracy_radius_m` и не может быть меньше нуля. Исходная
дистанция также сохраняется. Агрегированные calibration и learning metrics принадлежат
[циклу оценки памяти](evaluate.md).

## Фаза 4. Grounded review

### 9. Пост-анализ

Агент повторно рассматривает изображение, `answer_snapshot` и ground truth:

1. Какие blind и memory-guided observations были распознаны корректно?
2. Какие объекты были распознаны неверно?
3. Какие признаки получили слишком большой или слишком малый вес?
4. Какие видимые признаки были пропущены до answer?
5. Была ли истина среди кандидатов и на каком этапе она потерялась?
6. Какие memory items помогли, навредили или не повлияли?
7. Какое минимальное изменение belief улучшило бы ответ?
8. Что локально для этой сцены, а что является проверяемой переносимой гипотезой?

Новый визуальный признак использует общую `observation` schema из
[слепого решателя](../locate.md) с `observed_stage: post_reveal`. Он содержит `image_region` и
`recognition_confidence`; без привязки к конкретной области не может поддерживать учебную гипотезу.

Новый запрос к рабочей памяти после reveal запрещён. Межэпизодное сравнение происходит в
валидаторе и не переписывает попытку.

### 10. Таксономия ошибки

```text
error_type
  input_context
  perception_missed
  perception_misrecognized
  knowledge_missing
  retrieval_missed
  retrieval_harmful
  applicability_error
  evidence_weighting
  candidate_generation
  candidate_selection
  geocoding
  calibration
  ground_truth_issue
  none
```

Ошибки восприятия отдельно помечаются как потенциально не исправимые одной текстовой памятью.
Связанные image regions пригодны для будущего визуального dataset.

### 11. Feedback памяти

Для каждого элемента `answer_snapshot.retrieval_trace.items` формируется:

```text
memory_feedback
  reference
  knowledge_id | null
  knowledge_version | null
  query_id
  retrieved_rank
  applicability_decision — use | reject | unresolved
  used — boolean
  assessment — helpful | harmful | neutral | unverifiable
  affected_candidate_ids[]
  aligned_observation_ids[]
  explanation
  assessment_confidence
```

`helpful` и `harmful` относятся только к текущему контексту и не являются командами активировать
или удалить знание. Feedback агрегируется по независимым попыткам.

### 12. Learning candidates

Один кандидат содержит одну проверяемую связь:

```text
learning_candidate
  candidate_knowledge_id
  source_attempt_id
  created_at
  claim
    prerequisites[]
    cue
    direction — supports | weakens
    target_location
    geographic_level — country | region | locality | point
    comparison_set[]
  evidence
    observation_ids[]
    actual_location
    initial_interpretation
    actual_outcome
  source_scope
    source_domain
    capture_platform | null
    campaign_id | null
    captured_at | null
  source_solve_quality
    result_status
    degraded — boolean
    degraded_reasons[]
    unavailable_tools[]
    depends_on_degraded_component — boolean
    dependency_explanation | null
  applicability_notes
  known_exceptions[]
  epistemic_status — observed_scene_fact | inferred_association
  validation_status — proposed
  initial_support
    independent_positive_groups — 1
    independent_negative_groups — 0
```

Один эпизод позволяет сказать только «cue согласуется с ground truth в этой сцене». Он не
подтверждает измеренную надёжность правила.

`degraded: true` не запрещает кандидата автоматически. Кандидат допустим, если grounded visual cue
и ground truth не зависят от отказавшего компонента. Если вывод возник из отсутствия памяти,
неразрешённого geocoding или несовместимой calibration, зависимость фиксируется явно и кандидат не
может пройти admission валидатора без дополнительного независимого подтверждения.

`ground_truth_issue` полностью блокирует доставку кандидата независимо от остальных полей.

Хорошая гипотеза имеет форму:

```text
при prerequisites P наблюдение C повышает или понижает вероятность T относительно S
```

Если переносимого grounded-вывода нет:

```text
learning_decision
  status — not_proposed
  reason
```

## Фаза 5. Episode и доставка

### 13. Episode

```text
episode
  schema_version
  attempt_id
  data_identity
  dataset_assignment
  attempt_context
  answer_snapshot
  solve_quality
    result_status
    degraded
    degraded_reasons[]
    unavailable_tools[]
  ground_truth
  evaluation
  post_analysis
    error_types[]
    correct_observations[]
    misrecognized_observations[]
    missed_observations[]
    evidence_weighting_review
    minimal_counterfactual
  memory_feedback[]
  learning_candidates[]
  learning_decision
  state_history[]
  created_at
  recorded_at
```

Закрытые dataset/group поля доступны аналитическому контуру, но не решателю и рабочей памяти.

### 14. Durable outbox

До сетевых вызовов оркестратор атомарно сохраняет:

- неизменяемый episode;
- payload для `episode_store`;
- draft `validation_event`, содержащий только указатель на будущий archive receipt;
- content hashes, delivery states и retry policy.

После этого попытка переходит в `RECORDED`. Сбой больше не требует вызова модели.

### 15. Архивирование

Эпизод передаётся через [`episode_store`](/tools/episode_store.md) с ключом:

```text
{attempt_id}:episode:{schema_version}:{content_hash}
```

Временная ошибка повторяет тот же payload. Исправление создаёт новую версию со связью
`supersedes`; принятый эпизод не переписывается.

### 16. Событие валидации

После `episode_store: accepted` оркестратор дополняет event draft значениями
`episode_receipt_id` и `episode_content_hash`, затем публикует его по
[контракту очереди валидации](events.md).

Если episode не содержит ни feedback, ни learning candidates, event не публикуется и delivery
получает `not_needed`.

- Episode archive является source of truth для feedback и candidates.
- Queue содержит только идемпотентный указатель на принятую версию episode.
- Learning candidate становится доступным только карантину [валидатора](validate.md).
- Feedback и candidates одного episode сохраняют одну context group.
- Текущий `memory_store` не принимает candidate из одной попытки.
- Потерянное событие восстанавливается по архиву.

## Сбои и восстановление

| Момент | Восстановление |
|---|---|
| До `ANSWERED`, truth не раскрывался | Допустим новый solve с тем же закреплённым config. |
| После `ANSWERED` | Продолжить с сохранённого snapshot. |
| После reveal | Никогда не повторять blind solve. |
| Ошибка нормализации ground truth | Сохранить административные поля неизвестными или повторить orchestration-call. |
| После review, до outbox | Восстановить delivery из сохранённых результатов без изменения snapshot. |
| После outbox | Повторять только идемпотентную доставку. |
| Episode принят, event не опубликован | Повторить publish указателя с тем же event ID. |
| Постоянная ошибка схемы | Создать новую версию payload с `supersedes`. |

## Инварианты

- Blind часть выполняется общим solver из `locate.md`.
- Ground truth отсутствует во всём locate request и model context до `ANSWERED`.
- Solve config закреплён до blind run.
- Ответ сохраняется до reveal и после него не изменяется.
- Split и group IDs назначены до запуска.
- Все memory items и applicability decisions сохраняются в snapshot.
- Post-reveal observation пространственно привязан к изображению.
- Новый memory retrieval после reveal запрещён.
- Одна попытка создаёт hypothesis, а не validated knowledge.
- Degraded provenance переносится в каждый candidate.
- Метрики рассчитываются оркестратором.
- Episode не доступен через production memory retrieval.
- Validation queue передаёт ссылку на episode, а не дублирует payload.
- Tool acceptance не считается доказанным обучением.
- Сбой доставки не повторяет solve раскрытого примера.

## Критерии завершения

Попытка достигает `RECORDED`, когда существуют:

1. неизменяемый общий `answer_snapshot` и его hash;
2. ground truth с происхождением и точностью;
3. детерминированная evaluation;
4. grounded post-analysis и error taxonomy;
5. feedback по всем извлечённым memory items;
6. `learning_candidate[]` либо `learning_decision: not_proposed`;
7. неизменяемый episode;
8. durable outbox с episode payload и validation event draft.

Следующие состояния принадлежат другим циклам:

```text
learning_candidate
  → validation
  → validated learning_observation
  → candidate memory snapshot
  → benchmark
  → publish | reject | rollback
```

## За пределами цикла

- реализация blind reasoning, определённая в `locate.md`;
- межэпизодная валидация;
- публикация и откат памяти;
- выбор следующей партии;
- production delivery;
- изменение весов модели;
- обучение visual encoder или detector.
