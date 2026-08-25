---
type: Workflow
title: Цикл обработки обучающей попытки Loci
description: Слепой анализ одной фотографии, фиксация ответа, оценка по ground truth, пост-анализ и сохранение кандидатов на обучение.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, attempt, memory, geolocation]
---

# Цикл обработки обучающей попытки Loci

## Назначение

Этот workflow описывает обработку **одного** обучающего примера: от получения фотографии до
архивирования воспроизводимого эпизода. Он сохраняет границу между слепым ответом и ground truth,
измеряет влияние памяти и формирует кандидаты на переносимое знание.

Попытка сама по себе не изменяет рабочую память и не доказывает, что агент обучился. Кандидаты из
нескольких попыток проверяются в отдельном [цикле валидации знаний](validate.md), а влияние новой
версии памяти — в [цикле оценки](evaluate.md).

## Вход и результат

### Вход

Оркестратор получает подготовленный обучающий пример:

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
  ground_truth_envelope
  usage_policy
```

Пример уже выбран [циклом отбора](select.md), отнесён к `split: train` и проверен на
пересечение с validation/test. Ground truth находится в закрытом контексте оркестратора.

### Результат

```text
episode
  неизменяемая история попытки

memory_feedback[]
  оценка ранее извлечённых записей в контексте этой попытки

learning_candidate[]
  атомарные непроверенные гипотезы для межэпизодной валидации
```

`learning_candidate` не становится доступным пользовательскому инференсу напрямую.

## Ответственность

### Агент Loci

- анализирует изображение;
- фиксирует наблюдения и кандидатов;
- использует внешнюю память как подсказку;
- формирует слепой ответ;
- после reveal выполняет grounded review;
- предлагает учебные гипотезы и оценивает влияние памяти.

### Обучающий оркестратор

- скрывает ground truth до фиксации ответа;
- хранит закрытые идентификаторы выборки и групп;
- фиксирует версии модели, промпта, инструментов и памяти;
- рассчитывает детерминированные метрики;
- ведёт состояния и долговечный журнал исходящих операций;
- не позволяет повторно создать слепой ответ после reveal.

## Допущения

- На вход поступает одна фотография без надёжных координат в доступных агенту метаданных.
- Ground truth имеет известные происхождение и точность.
- Одна попытка последовательно выполняется одним агентом.
- Извлечённые записи памяти являются подсказками, а не доказанными фактами.
- Внутреннее устройство памяти скрыто от агента.
- Архив эпизодов логически отделён от рабочей памяти.
- Расстояния и административные совпадения рассчитывает оркестратор, а не языковая модель.
- Весы базовой мультимодальной модели в рамках попытки не изменяются.

## Общая схема

```text
подготовленный train-пример
    → инициализация версии попытки
    → слепые наблюдения
    → предварительные гипотезы
    → извлечение релевантного опыта
    → итоговые гипотезы
    → неизменяемый answer_snapshot
    ───────── граница ground truth ─────────
    → раскрытие и нормализация истины
    → детерминированная оценка
    → grounded review
    → memory_feedback[]
    → learning_candidate[] | not_proposed
    → долговечный episode и outbox
    → архив эпизодов
    → контур валидации знаний
```

## Состояния попытки

```text
RECEIVED
  → STARTED
  → OBSERVED
  → REASONED
  → ANSWERED
  → REVEALED
  → EVALUATED
  → REVIEWED
  → RECORDED
```

| Состояние | Результат |
|---|---|
| `RECEIVED` | Получен подготовленный train-пример. |
| `STARTED` | Создан контекст попытки; ground truth скрыт. |
| `OBSERVED` | Сохранены слепые наблюдения и их привязка к изображению. |
| `REASONED` | Выполнены разрешённые обращения к памяти и сформированы кандидаты. |
| `ANSWERED` | Ответ и trace сохранены неизменяемым снимком. |
| `REVEALED` | Ground truth раскрыт и нормализован. |
| `EVALUATED` | Оркестратор рассчитал метрики попытки. |
| `REVIEWED` | Выполнен пост-анализ, сформированы feedback и учебные кандидаты. |
| `RECORDED` | Эпизод и исходящие операции долговечно сохранены. |

Из любого состояния до `ANSWERED` пример может перейти в `EXCLUDED`, если обнаружены повреждение,
нарушение правил использования, утечка истины или недопустимая неоднозначность ground truth.
Если проблема обнаружена после `ANSWERED`, попытка всё равно архивируется, но получает
`ground_truth_issue` и не передаёт кандидаты в валидацию.

Доставка отделена от обработки агента:

```text
episode_delivery — pending | archived | retryable_failure | permanent_failure
feedback_delivery — pending | submitted | not_needed | retryable_failure | permanent_failure
candidate_delivery — pending | submitted | not_needed | retryable_failure | permanent_failure
```

## Фаза 0. Повторная проверка и инициализация

### 0. Проверка предусловий

Перед запуском оркестратор убеждается, что:

- `dataset_assignment.split` равен `train`;
- идентификаторы групп были назначены до просмотра результата;
- изображение соответствует сохранённому `image_sha256`;
- ground truth не присутствует в агентском контексте, имени файла, доступных метаданных или
  тексте задания;
- `label_status` допускает обучение на требуемом географическом уровне;
- использование и хранение изображения разрешены `usage_policy`.

### 1. Создание попытки

До анализа создаётся воспроизводимый контекст:

```text
run_context
  attempt_id
  image_ref
  image_sha256
  created_at
  agent_version
  model_id
  prompt_version
  decoding_config
  image_preprocessing_version
  tool_contract_versions
  memory_snapshot_id
  geocoder_provider
  geocoder_version
  validation_policy_version
  inference_budget
    max_duration_ms
    max_tool_calls
    max_memory_items
```

`attempt_id` связывает ответ, вызовы инструментов, reveal, evaluation, post-analysis и все
исходящие записи. `image_ref` указывает на неизменяемое исходное изображение или его устойчивый
идентификатор.

Закрытые `ground_truth_envelope`, `dataset_assignment` и идентификаторы групп не передаются агенту.
Оркестратор фиксирует `ground_truth_status: hidden`.

## Фаза 1. Слепой анализ

### 2. Первичное наблюдение

Агент сначала фиксирует только то, что действительно видно:

- ландшафт, рельеф, климат, погоду и освещение;
- растительность, почву и воду;
- архитектуру, материалы и характер застройки;
- дороги, сторону движения, разметку, знаки и инженерную инфраструктуру;
- транспорт и номерные знаки;
- язык, письменность, OCR и читаемые названия;
- явно видимые культурные объекты без предположений о чувствительных свойствах людей;
- геометрию сцены и направление ориентиров, если они обоснованы;
- свойства изображения и артефакты источника съёмки.

Каждое наблюдение получает отдельный идентификатор:

```text
observation
  observation_id
  category
  text
  polarity — positive | negative
  visibility — clear | partial | weak
  recognition_confidence — number, от 0 до 1
  image_region
    x
    y
    width
    height
  origin — physical_world | capture_artifact | embedded_text
  observed_stage — blind
```

Координаты `image_region` нормализованы от `0` до `1`; для признака всей сцены поле может быть
`null`. OCR хранит различимый текст отдельно от его исправления и географической интерпретации.

Наблюдение отделяется от гипотезы. Например, «одиночная жёлтая линия по центру» — наблюдение, а
«Северная Америка» — интерпретация.

Отрицательное наблюдение допустимо только при достаточной видимости области, где ожидаемый объект
должен был бы находиться. `recognition_confidence` отражает распознавание объекта, а не силу его
географической связи.

Дополнительно агент может сохранить первое целостное впечатление:

```text
scene_impression
  text
  confidence
  observed_stage — blind
```

`scene_impression` хранится отдельно от наблюдаемых фактов.

### 3. Предварительные гипотезы до памяти

До первого вызова памяти сохраняется краткий belief state:

```text
pre_memory_belief
  candidates[]
  selected_location
  confidence_by_level
  spatial_uncertainty
  unresolved_questions[]
```

Он не является ответом и может меняться. Снимок нужен для диагностики того, как retrieval повлиял
на кандидатов. Строгую причинную оценку памяти выполняет отдельный shadow-run в
[цикле оценки](evaluate.md).

### 4. Извлечение памяти

Через [`memory_retrieve`](/tools/memory_retrieve.md) допускаются два смысловых прохода:

1. поиск знаний по наиболее различающим видимым признакам;
2. поиск исключений и контрпримеров для появившихся кандидатов.

Второй запрос должен искать не только подтверждения, но и причины отказаться от ведущей
гипотезы. Содержимое памяти и OCR рассматривается как недоверенные данные, а не инструкции агенту.

Каждый вызов сохраняется полностью в безопасной форме:

```text
retrieval_trace
  query_id
  pass — feature | candidate_counterevidence
  requested_at
  request
  response_status — success | unavailable | timeout | invalid_request
  memory_snapshot_id
  items[]
    reference
    rank
    kind
    content_snapshot
    content_hash
  truncated
  duration_ms
```

Секреты и служебные данные редактируются до архивирования. В trace входят все возвращённые записи,
а не только те, которые агент позднее назвал полезными.

Для повлиявших записей дополнительно фиксируется:

```text
memory_evidence
  reference
  aligned_observation_ids[]
  summary
  influence
    candidate_id
    direction — supports | weakens
    strength — weak | medium | strong
```

`summary` и `influence` создаются до reveal и после него не переписываются. Позиция записи в выдаче
не считается доказательством её правильности.

Недоступность памяти не блокирует попытку. Ошибка записывается в `retrieval_trace`, а агент
продолжает анализ самостоятельно.

### 5. Формирование итоговых гипотез

Агент формирует не более трёх взаимоисключающих кандидатов. Страна и вложенный в неё регион не
могут одновременно считаться двумя независимыми вариантами.

```text
candidate
  candidate_id
  location
    coordinates
    country
    region
    locality
    geographic_level — country | region | locality | point
  probability_mass — number, от 0 до 1
  evidence_for[]
    observation_id | memory_reference
  evidence_against[]
    observation_id | memory_reference
  unresolved_questions[]
```

Сумма вероятностей кандидатов и остатка равна `1`:

```text
candidate_distribution
  candidates[]
  other_probability
```

После сравнения выбирается одна точечная оценка:

```text
selected_location
  coordinates
    latitude
    longitude
  country
  region
  locality
  selection_objective — maximum_probability | minimum_expected_distance | identified_point
```

Координаты записываются в WGS84 и остаются обязательными для сопоставимости метрик. Если агент
уверен только в стране или регионе, точка представляет его лучшую операционную ставку, а не
имитацию точного знания.

`geocode_search` разрешает уже сформированный топоним или адрес, а `geocode_reverse` проверяет
административную принадлежность выбранной точки. Геокодер не определяет связь фотографии с местом
и сам по себе не повышает уверенность.

Уверенность задаётся как совместная вероятность правильности выбранной административной цепочки:

```text
confidence_by_level
  country   — number, от 0 до 1
  region    — number, от 0 до 1 | null
  locality  — number, от 0 до 1 | null
```

При наличии уровней выполняется:

```text
country >= region >= locality
```

Пространственная неопределённость задаётся на фиксированных уровнях покрытия:

```text
spatial_uncertainty
  circles[]
    coverage — 0.50 | 0.80 | 0.95
    radius_km
```

Радиусы не убывают с ростом `coverage`. Фиксированные уровни позволяют оценивать одновременно
калибровку и размер заявленной области.

### 6. Фиксация ответа

До раскрытия истины оркестратор сохраняет append-only снимок:

```text
answer_snapshot
  attempt_id
  image_ref
  run_context
  observations[]
  scene_impression | null
  pre_memory_belief
  retrieval_trace[]
  candidates[]
  other_probability
  selected_location
  confidence_by_level
  spatial_uncertainty
  memory_evidence[]
  reasoning_summary
  answered_at
  content_hash
```

`reasoning_summary` является кратким структурированным обоснованием. Скрытый внутренний ход мысли
модели не сохраняется; фактическая последовательность восстанавливается по состояниям, данным и
вызовам инструментов.

Только успешная долговечная запись `answer_snapshot` переводит попытку в `ANSWERED`. После сбоя
слепой ответ не создаётся повторно в контексте, который уже видел истину.

## Фаза 2. Reveal и оценка

### 7. Раскрытие ground truth

После `ANSWERED` оркестратор передаёт агенту допустимую часть истины:

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
поставщиком и версией административных данных, которые применялись к выбранной точке. Если
нормализация недоступна, соответствующие поля остаются неизвестными и не выводятся из ответа.

`disputed` и `invalid` запрещают формирование учебных кандидатов. `approximate` допускает только
те административные и пространственные выводы, которые совместимы с `accuracy_radius_m`.

### 8. Детерминированная оценка

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
  latency_ms
  tool_calls
  retrieved_items
```

`label_adjusted_distance_km` учитывает `accuracy_radius_m` и не может быть меньше нуля. Исходная
дистанция также сохраняется, чтобы позднее можно было изменить политику меток без потери данных.

Brier score, reliability diagram и learning curve рассчитываются на множестве эпизодов в
[цикле оценки](evaluate.md), а не выводятся из одной попытки.

## Фаза 3. Grounded review

### 9. Пост-анализ

Агент повторно рассматривает исходное изображение с известным местом и отвечает:

1. Какие слепые наблюдения были распознаны корректно?
2. Какие объекты были распознаны неверно?
3. Какие признаки получили слишком большой или слишком малый вес?
4. Какие видимые признаки были пропущены?
5. Была ли истина среди кандидатов и на каком этапе она потерялась?
6. Какие записи памяти помогли, навредили или не повлияли на решение?
7. Какое минимальное изменение решения улучшило бы ответ?
8. Какой вывод локален для сцены, а какой является проверяемой переносимой гипотезой?

Новый визуальный признак должен содержать `image_region`, `recognition_confidence` и
`observed_stage: post_reveal`. Если его нельзя связать с конкретной областью изображения, он не
может быть основанием учебной гипотезы.

Новый запрос к рабочей памяти во время review не выполняется. Сравнение с другими эпизодами
происходит позднее и не меняет исходную попытку.

### 10. Таксономия ошибки

Пост-анализ указывает одну основную и при необходимости дополнительные причины:

```text
error_type
  perception_missed
  perception_misrecognized
  knowledge_missing
  retrieval_missed
  retrieval_harmful
  evidence_weighting
  candidate_generation
  candidate_selection
  geocoding
  calibration
  ground_truth_issue
  none
```

`none` допустим для качественного ответа. Успешная попытка всё равно может дать полезный feedback
или переносимую гипотезу.

Ошибки `perception_missed` и `perception_misrecognized` отдельно помечаются как потенциально не
исправимые одной текстовой памятью. Связанные фрагменты сохраняются для будущего визуального
датасета.

### 11. Feedback по памяти

Для каждой записи из `retrieval_trace.items` формируется:

```text
memory_feedback
  reference
  query_id
  retrieved_rank
  used — boolean
  assessment — helpful | harmful | neutral | unverifiable
  affected_candidate_ids[]
  aligned_observation_ids[]
  explanation
  assessment_confidence
```

`helpful` означает полезность только в текущем контексте. `harmful` не является командой удалить
запись. Память или валидатор объединяет feedback по множеству независимых попыток и самостоятельно
решает вопрос актуальности знания.

### 12. Учебные кандидаты

Каждый `learning_candidate` содержит один атомарный проверяемый вывод:

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
  applicability_notes
  known_exceptions[]
  epistemic_status — observed_scene_fact | inferred_association
  validation_status — proposed
  initial_support
    independent_positive_groups — 1
    independent_negative_groups — 0
```

`observed_scene_fact` относится только к факту текущей сцены. Географическая переносимость почти
всегда является `inferred_association`.

Вместо «признак подтверждён» используется «признак согласуется с ground truth в этом эпизоде».
Одна попытка не получает измеренную надёжность и не объявляет правило универсальным.

Хорошая гипотеза имеет форму:

```text
при предусловиях P наблюдение C повышает или понижает вероятность T относительно S
```

а не:

```text
наблюдение C однозначно означает место T
```

Если переносимого и визуально обоснованного вывода нет, сохраняется:

```text
learning_decision
  status — not_proposed
  reason
```

Причина обязательна, чтобы отличать осознанное решение от пропущенного шага.

## Фаза 4. Долговечная запись и доставка

### 13. Формирование эпизода

```text
episode
  schema_version
  attempt_id
  data_identity
  dataset_assignment
  run_context
  answer_snapshot
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

Закрытые `data_identity` и `dataset_assignment` доступны аналитическому контуру, но не передаются
агенту или рабочей памяти.

### 14. Durable outbox

До сетевых вызовов оркестратор атомарно сохраняет:

- неизменяемый `episode`;
- payload для `episode_store`;
- payload feedback памяти;
- payload кандидатов для валидатора;
- идентификаторы и хэши содержимого;
- состояния доставки и политику повторов.

После этого попытка переходит в `RECORDED`. Сбой не требует повторного анализа изображения и не
может создать другой слепой ответ.

### 15. Архивирование

Эпизод отправляется через [`episode_store`](/tools/episode_store.md) с версией схемы и стабильным
идемпотентным ключом:

```text
{attempt_id}:episode:{schema_version}:{content_hash}
```

Временная ошибка повторяет тот же payload и ключ. Постоянная ошибка переводит доставку в
`permanent_failure`, сохраняет диагностику и создаёт операторский сигнал; она не удерживает агента
в бесконечном активном цикле.

### 16. Передача feedback и кандидатов

`memory_feedback` и `learning_candidate` доставляются независимо от архива:

- feedback описывает использование уже существующих записей;
- кандидат поступает только в карантин валидатора;
- ни один из них не является командой изменить активную память;
- все отправки идемпотентны;
- полный или частичный отказ не считается успешной доставкой;
- повтор использует неизменяемый payload и тот же ключ.

Текущий `memory_store` не используется для непосредственной публикации кандидата из одной
попытки. В рабочую память через него попадает только результат [валидации](validate.md).

## Сбои и восстановление

| Момент сбоя | Восстановление |
|---|---|
| До `ANSWERED` | Повторить слепую попытку только если ground truth ещё не раскрывался процессу агента. |
| После фиксации `ANSWERED` | Продолжить с сохранённого снимка; не генерировать ответ повторно. |
| Во время нормализации истины | Сохранить административные поля неизвестными или повторить вызов оркестратором. |
| После `REVIEWED`, до outbox | Повторно сформировать delivery из сохранённого post-analysis без изменения ответа. |
| После outbox | Повторять только соответствующую идемпотентную доставку. |
| Постоянная ошибка схемы | Создать новую версию payload со связью `supersedes`; старую запись не переписывать. |

## Инварианты

- Ground truth недоступен до долговечной фиксации `answer_snapshot`.
- Попытка обрабатывает только пример с `split: train`.
- Идентификаторы групп и split назначены до запуска агента.
- Исходный ответ, pre-memory belief и retrieval trace после reveal не изменяются.
- Модель, промпт, инструменты, память и политика имеют версии.
- Наблюдение отделено от интерпретации и географического вывода.
- Отрицательное наблюдение требует достаточной видимости.
- Постфактум-признак ссылается на конкретную область изображения.
- Все возвращённые записи памяти сохраняются в архивном trace.
- Feedback памяти не является командой изменить запись.
- Одна попытка создаёт гипотезу, а не валидированное правило.
- Физические признаки отделены от артефактов источника съёмки.
- Метрики рассчитываются оркестратором.
- Эпизод отделён от рабочей памяти и не извлекается через `memory_retrieve`.
- `accepted` означает приём данных, а не доказанное обучение.
- Сбой доставки не требует повторного слепого анализа раскрытого примера.

## Критерии завершения

Попытка достигает `RECORDED`, когда существуют:

1. неизменяемый слепой `answer_snapshot` и его хэш;
2. ground truth с происхождением и точностью;
3. рассчитанный оркестратором `evaluation`;
4. grounded post-analysis и таксономия ошибки;
5. feedback по всем извлечённым записям памяти;
6. `learning_candidate[]` либо явный `learning_decision: not_proposed`;
7. неизменяемый `episode`;
8. долговечный outbox для независимых доставок.

Завершённая попытка ещё не означает улучшение агента. Следующие состояния принадлежат другим
циклам:

```text
learning_candidate
  → [валидация](validate.md)
  → validated learning_observation
  → новая версия памяти
  → [контрольная оценка](evaluate.md)
  → publish | rollback
```

## За пределами цикла

- межэпизодное объединение и проверка учебных гипотез;
- публикация и откат версии памяти;
- выбор следующей партии обучающих примеров;
- изменение весов мультимодальной модели;
- обучение визуального encoder или detector;
- обработка нескольких фотографий одного места;
- запрос дополнительных изображений или внешних источников.
