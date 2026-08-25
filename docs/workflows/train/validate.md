---
type: Workflow
title: Цикл валидации знаний Loci
description: Межэпизодная проверка учебных гипотез, поиск контрпримеров и подготовка валидированных наблюдений для памяти.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, learning, validation, memory, knowledge]
---

# Цикл валидации знаний Loci

## Назначение

Цикл превращает непроверенные `learning_candidate` из отдельных
[обучающих попыток](attempt.md) в знания, которые можно предложить рабочей памяти. Он не принимает
совпадение признака и ground truth в одной сцене за доказанную географическую закономерность.

Валидация отвечает на вопросы:

- действительно ли признак различает целевое место и основные альтернативы;
- при каких предусловиях он применим;
- встречается ли он в других доменах и регионах;
- есть ли независимые подтверждения и контрпримеры;
- не объясняется ли результат дубликатами, одной кампанией съёмки или другим коррелирующим
  признаком;
- следует ли опубликовать, отклонить, ослабить или заменить знание.

## Входы

```text
validation_input
  validation_events[]
  episode_reader
  active_knowledge_catalog
  validation_policy
  data_group_registry
  trigger_context
```

События соответствуют [контракту validation queue](events.md). Валидатор получает archive receipt,
читает неизменяемый train-эпизод и только после проверки content hash извлекает candidates и
feedback. Validation/test-эпизоды не могут поддерживать или опровергать конкретное знание, даже
если доступны аналитическому контуру.

## Результаты

```text
knowledge_validation[]
  решение и полный набор оснований

learning_observation[]
  только валидированные знания для memory_store

validation_requests[]
  запросы циклу отбора на недостающие положительные примеры или контрпримеры

validation_run_report
  run context, budget usage, event outcomes и агрегированные решения
```

## Субъекты валидации

Валидация состоит из двух обязательных и одного опционального слоя.

### Детерминированный координатор

- проверяет event, receipt, content hash и train split;
- дедуплицирует попытки и evidence groups;
- канонизирует административные идентификаторы;
- применяет thresholds, expiry и decision policy;
- сохраняет версии, provenance и outbox;
- не делает visual-суждений по изображению.

### Visual evidence verifier

- проверяет присутствие или отсутствие cue на исходных изображениях;
- сравнивает target и comparison scenes;
- проверяет memory-guided и post-reveal observations;
- фиксирует competing explanations;
- не считает собственные повторные запуски независимыми evidence groups.

Verifier может быть моделью или контролируемым agent workflow. Он не должен неявно наследовать
ground-truth подсказки в prompt помимо данных, необходимых конкретному validation task.

Предпочтительный порядок:

```text
1. blind cue verification — image + canonical cue, без target location
2. deterministic join — verified cue + закрытый ground truth
3. contrastive aggregation по independent groups
```

Если verifier получает target location, это сохраняется как `ground_truth_exposed: true`, а такое
решение требует более строгой policy или независимой повторной проверки. Совпадение нескольких
запусков одной model/prompt версии не считается независимостью geographic evidence.

### Human reviewer

Опционально применяется для правил с высоким ожидаемым влиянием, спорной visual-разметки,
чувствительных данных и конфликтов нескольких verifier runs.

## Запуск валидатора

### Trigger policy

```text
validation_trigger_policy
  policy_version
  scheduled_interval
  minimum_pending_events
  maximum_queue_age
  urgent_priority_threshold
  minimum_candidate_group_size
  manual_trigger_allowed
```

Запуск происходит при выполнении хотя бы одного разрешённого trigger. Пустой периодический запуск
допустим для проверки queue health, но не создаёт snapshot без новых validation results.

### Run context

```text
validator_run_context
  validation_run_id
  trigger
  deterministic_validator_version
  visual_verifier
    verifier_type — model | agent | human | hybrid
    validator_model_id | null
    prompt_version | null
    image_preprocessing_version | null
    decoding_config | null
    ground_truth_exposure_policy
  validation_policy_version
  archive_snapshot_id
  active_knowledge_catalog_version
  randomization_config
  budget
    max_events
    max_candidates
    max_episodes
    max_images
    max_model_calls
    max_tokens
    max_duration_ms
  created_at
```

Любое изменение verifier model, prompt, preprocessing или policy создаёт новый run context. Старые
validation decisions не переписываются; при необходимости они получают статус `revalidation_required`.

### Состояния запуска

```text
TRIGGERED
  → CLAIMING
  → LOADING_EPISODES
  → VALIDATING
  → RECORDING_RESULTS
  → ACKNOWLEDGING_EVENTS
  → COMPLETE
```

При исчерпании budget необработанные события возвращаются в `available`. Частично обработанный
candidate сохраняет checkpoint либо полностью повторяется идемпотентно согласно policy; неполный
результат не получает `validated`.

## Состояния кандидата

```text
PROPOSED
  → QUARANTINED
      ├→ VALIDATED
      ├→ REJECTED
      ├→ SUPERSEDED
      └→ QUARANTINED
```

| Состояние | Значение |
|---|---|
| `PROPOSED` | Гипотеза создана одной попыткой и ещё не канонизирована. |
| `QUARANTINED` | Гипотеза доступна валидатору, но не пользовательскому retrieval. |
| `VALIDATED` | Выполнена политика проверки; можно создать `learning_observation`. |
| `REJECTED` | Данные опровергают вывод либо он не имеет переносимой ценности. |
| `SUPERSEDED` | Вывод заменён более точной версией или включён в объединённое знание. |

Недостаток данных не является причиной искусственно выбирать `validated` или `rejected`.
Кандидат может оставаться в карантине и сформировать запрос на следующий набор примеров.

## Фаза 1. Admission и канонизация

### 1. Проверка происхождения

Кандидат допускается к валидации, если:

- validation event успешно claimed и соответствует [контракту очереди](events.md);
- archive receipt, attempt ID и episode content hash совпадают;
- его `source_attempt_id` существует в архиве;
- эпизод относится к `split: train`;
- ground truth имеет допустимый `label_status` и точность;
- слепой `answer_snapshot` был зафиксирован до reveal;
- cue ссылается на наблюдение и видимую область изображения;
- отсутствуют нерешённые нарушения usage policy;
- схема и политика создания кандидата известны.

Нарушение происхождения переводит кандидата в `REJECTED` с причиной `invalid_provenance`.

Для degraded attempt дополнительно проверяется:

```text
source_solve_quality
  result_status
  degraded
  degraded_reasons[]
  unavailable_tools[]
  depends_on_degraded_component
  dependency_explanation | null
```

- `ground_truth_issue` отклоняет candidate;
- зависимость от отказавшего компонента оставляет candidate в карантине до независимого evidence;
- outage, не связанный с grounded cue и ground truth, не отклоняет candidate автоматически;
- degraded episode не может быть единственным независимым подтверждением переносимого правила.

### 2. Атомарность

Один кандидат должен описывать одну связь:

```text
при prerequisites наблюдение cue
  → supports | weakens
  → target относительно comparison_set
```

Составная формулировка разбивается, если её части можно независимо подтвердить или опровергнуть.
Например, вывод о форме столба и вывод о цвете почвы не хранятся одним правилом только потому, что
они встретились в одной фотографии.

### 3. Канонизация

Валидатор нормализует:

- категорию и формулировку cue без потери исходного текста;
- административные идентификаторы цели и конкурентов;
- географический уровень;
- источник изображения, платформу и кампанию;
- временные ограничения;
- известные предусловия и исключения.

Канонизация создаёт новую производную запись и не переписывает исходный кандидат.

## Фаза 2. Группировка и независимость

### 4. Поиск похожих гипотез

Кандидаты группируются по:

- смыслу cue;
- `prerequisites`;
- направлению влияния;
- целевому географическому уровню;
- `comparison_set`;
- домену и времени съёмки.

Совпадение текста не обязательно означает одно знание, а разные формулировки могут описывать один
визуальный признак. Решение о слиянии сохраняет ссылки на все исходные варианты.

### 5. Группы независимых свидетельств

Поддержка считается по независимым группам, а не по числу фотографий:

```text
evidence_group
  near_duplicate_cluster_id
  location_cluster_id
  capture_session_id
  campaign_id | null
```

- несколько crop одного изображения дают одну группу;
- соседние кадры одной панорамы дают одну группу;
- повторная загрузка фотографии не увеличивает поддержку;
- сцены одной точки и кампании не доказывают переносимость на другие места;
- одинаковая ошибка нескольких запусков одной модели не является независимым экспертным
  подтверждением.

### 6. Тип свидетельства

```text
evidence_role
  positive_target
  negative_target
  positive_comparison
  negative_comparison
  counterexample
  ambiguous
```

Присутствие cue в целевом месте — только `positive_target`. Различающая способность требует
данных из `comparison_set` и проверки мест, где cue встречается без target.

### 6.1. Visual verification record

Каждая проверка изображения создаёт воспроизводимую запись:

```text
visual_verification
  verification_id
  validation_run_id
  source_attempt_id
  image_ref
  cue
  expected_role
  observed — present | absent | uncertain
  image_region | null
  recognition_confidence
  verifier_run_index
  verifier_model_id | null
  prompt_version | null
  ground_truth_exposed — boolean
  decided_at
```

Несколько verifier runs одного изображения помогают оценить устойчивость разметки, но не
увеличивают число независимых geographic evidence groups. `uncertain` не превращается в
отрицательный пример.

## Фаза 3. Контрастная проверка

### 7. Проверка предусловий

Валидатор проверяет, что правило не потеряло условия применения. Например:

```text
страна уже вероятна: Бразилия
+ объект действительно является инфраструктурным столбом
+ source_domain совместим
→ вариант столба поддерживает конкретный штат
```

Правило «зелёный столб означает штат» без этих условий считается чрезмерно широким.

### 8. Основные конкуренты

Для каждого target должен существовать `comparison_set`. Он включает:

- альтернативы из исходной попытки;
- географически или визуально похожие места;
- места, где такой cue известен как исключение;
- более частый базовый класс, который может объяснять наблюдение.

Если конкуренты неизвестны, валидатор оставляет кандидата в карантине и создаёт
`validation_request`.

### 9. Домены и время

Физический признак и артефакт источника проверяются раздельно:

```text
physical_world
  может переноситься между платформами при дополнительной проверке

capture_artifact
  ограничивается платформой, кампанией и временным окном
```

Street View, пользовательские фотографии, панорамы, dashcam и screenshots не смешиваются без
явного доказательства переносимости. Для камерной меты обязательны `validity_window` либо статус
неизвестной актуальности.

### 10. Конкурирующие объяснения

Валидатор сохраняет возможные confounders:

```text
competing_explanation
  description
  associated_observation_ids[]
  evidence_for
  evidence_against
  resolution — unresolved | weakened | preferred
```

Например, региональная точность могла возникнуть не из формы столба, а из рельефа, типа дороги или
узнаваемой кампании съёмки. Неразрешённый confounder уменьшает область утверждения либо оставляет
кандидата в карантине.

## Фаза 4. Политика решения

### 11. Версионированная политика

```text
validation_policy
  policy_version
  rule_class
  minimum_independent_positive_groups
  minimum_comparison_groups
  minimum_non_degraded_positive_groups
  maximum_counterexample_rate
  required_source_domains[]
  expiry_policy
  confidence_method
  degraded_evidence_policy
  visual_verification_policy
  human_review_policy
```

Порог зависит от класса знания:

- проверенный читаемый топоним;
- стабильный инфраструктурный стандарт;
- природный или архитектурный признак;
- корреляционная региональная мета;
- артефакт конкретной кампании съёмки.

Пороги настраиваются только по validation-данным. Test не используется для их выбора.

### 12. Результат проверки

```text
knowledge_validation
  candidate_knowledge_id
  validation_run_id
  validator_run_context_hash
  canonical_claim
  validation_policy_version
  source_attempt_ids[]
  independent_positive_groups
  independent_comparison_groups
  counterexample_attempt_ids[]
  visual_verification_ids[]
  degraded_source_attempt_ids[]
  competing_explanations[]
  estimated_reliability | null
  validated_scope
  known_exceptions[]
  validity_window | null
  decision — validated | rejected | superseded | quarantined
  reason
  decided_at
```

`estimated_reliability` появляется только при достаточном количестве независимых данных. Число,
придуманное агентом по одному эпизоду, не считается измеренной надёжностью.

### 13. Feedback по существующему знанию

Feedback из попыток агрегируется отдельно:

```text
memory_feedback_summary
  knowledge_reference
  independent_context_groups
  retrieved_count
  applicability_used_count
  applicability_rejected_count
  applicability_unresolved_count
  helpful_count
  harmful_count
  neutral_count
  unverifiable_count
  observed_failure_modes[]
  recommendation — retain | narrow_scope | revalidate | supersede
```

Applicability агрегируется до outcome assessment: запись, отклонённая gate, не считается `neutral`
или `harmful`, пока она не была применена. Один `harmful` не удаляет запись. Повторяющийся вред в
независимых контекстах может инициировать новую валидацию, сужение области или заменяющую версию.

## Фаза 5. Публикация валидированного знания

### 14. Структура наблюдения

Только `decision: validated` создаёт:

```text
learning_observation
  knowledge_id
  knowledge_version
  created_at
  claim
    prerequisites[]
    cue
    direction — supports | weakens
    target_location
    geographic_level
    comparison_set[]
  applicability
    source_domains[]
    geographic_scope
    validity_window | null
  support
    source_attempt_ids[]
    independent_positive_groups
    independent_comparison_groups
    counterexample_count
    degraded_source_count
    estimated_reliability | null
  known_exceptions[]
  validation_policy_version
  epistemic_status — validated_association
  supersedes | null
```

Даже валидированная запись остаётся свидетельством. Во время инференса агент обязан проверить
`prerequisites`, cue, домен и исключения по текущей фотографии.

### 15. Идемпотентная доставка

Наблюдение передаётся через [`memory_store`](/tools/memory_store.md). Идемпотентность определяется
`knowledge_id`, `knowledge_version` и хэшем содержимого:

```text
{knowledge_id}:{knowledge_version}:{content_hash}
```

Исправление создаёт новую версию с `supersedes`. Старая версия не переписывается молча. Статусы:

```text
memory_delivery
  pending
  submitted
  retryable_failure
  permanent_failure
```

`submitted` подтверждает приём, но не немедленную индексацию и не полезность записи.

### 16. Кандидат версии памяти

Принятые знания собираются в неизменяемый snapshot-кандидат:

```text
memory_snapshot
  snapshot_id
  parent_snapshot_id
  knowledge_versions[]
  index_version
  created_at
  publication_status — candidate
```

Snapshot не становится активным до прохождения [цикла оценки](evaluate.md).

## Запросы на дополнительные данные

Если вывод нельзя проверить, создаётся:

```text
validation_request
  request_id
  candidate_knowledge_ids[]
  requested_evidence
    target_locations[]
    comparison_locations[]
    source_domains[]
    time_ranges[]
    cue_presence — required | absent | either
  priority
  reason
```

Запрос поступает в [цикл отбора примеров](select.md). Он не гарантирует, что нужные данные
существуют или могут быть законно получены.

## Инварианты

- Только train-эпизоды являются свидетельствами знания.
- Validation/test не участвуют в support и counterexample counts.
- Одна независимая группа учитывается не более одного раза в одной роли.
- Исходные кандидаты и эпизоды не переписываются.
- Слияние сохраняет происхождение всех исходных гипотез.
- Наблюдаемый факт сцены не равен географической закономерности.
- Валидированное правило содержит предусловия, comparison set и область применимости.
- Артефакты съёмки имеют доменное и временное ограничение.
- Недостаток данных оставляет гипотезу в карантине.
- Feedback не является прямой командой изменить знание.
- Validator runtime, verifier и budget имеют версии.
- Degraded provenance учитывается до решения.
- Visual verifier runs одного изображения не считаются независимыми geographic groups.
- Публикация записи идемпотентна и версионирована.
- Новая версия памяти не активируется без контрольной оценки.

## Критерии завершения цикла

Один запуск валидации завершён, когда:

1. каждый взятый кандидат получил проверенное происхождение;
2. дубликаты и зависимые группы учтены явно;
3. проведена контрастная проверка или создан запрос на недостающие данные;
4. сохранён `knowledge_validation` с решением и причиной;
5. для `validated` сформирована версионированная запись;
6. доставки находятся в долговечном outbox;
7. при наличии новых знаний сформирован snapshot-кандидат для benchmark;
8. обработанные validation events подтверждены только после записи результатов;
9. необработанные из-за budget события возвращены в очередь без потери lease semantics.

Цикл может закончиться без новых знаний. Это корректный результат, если ни одна гипотеза не
прошла политику проверки.

## За пределами цикла

- слепое решение отдельных фотографий;
- выбор исходной партии примеров;
- принятие решения о публикации snapshot;
- внутренняя реализация индекса и ранжирования памяти;
- доказательство причинной, а не корреляционной природы признака;
- обучение визуального распознавателя.
