---
type: Workflow
title: Production-инференс Loci
description: Приём пользовательской фотографии, запуск общего слепого решателя, формирование ответа и надёжная доставка без изменения памяти.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, inference, production, delivery, geolocation]
---

# Production-инференс Loci

## Назначение

Production-инференс принимает пользовательский запрос, проверяет допустимость входа, запускает
общий [слепой цикл геолокации](locate.md), преобразует внутренний `answer_snapshot` в понятный
ответ и надёжно доставляет результат.

Географическое рассуждение не дублируется в этом документе. Тот же решатель используется в
обучающих попытках и benchmark, поэтому опубликованная версия памяти проверяется на том поведении,
которое получает пользователь.

Production-инференс:

- не получает ground truth;
- не вызывает `memory_store` или `episode_store`;
- не превращает пользовательский запрос в учебный эпизод;
- не изменяет извлечённые записи;
- не сохраняет полный reasoning или изображение без отдельного основания;
- может хранить готовый результат и privacy-safe operational telemetry для доставки и диагностики.

## Вход

```text
inference_request
  request_id
  idempotency_key
  image_ref
  user_context
    constraints[]
    hints[]
    target_precision — country | region | locality | point
    response_language | null
  source_metadata
    declared_source_domain | null
    source_domain_confidence | null
    capture_platform | null
    captured_at | null
    image_orientation | null
  metadata_policy
  delivery_context
```

`constraints` — явно известные границы задачи. `hints` — ненадёжные сведения пользователя. Они не
смешиваются с визуальными наблюдениями. Повтор с тем же `idempotency_key` и тем же содержимым не
создаёт второй независимый запрос.

## Результат

```text
inference_response
  request_id
  status — located | ambiguous | insufficient_evidence
  degraded — boolean
  most_likely_location
  achieved_precision
  confidence
  uncertainty
  alternatives[]
  evidence_summary
  limitations[]
  next_best_input | null
```

`confidence` содержит значения по доступным административным уровням и `calibration_status`.
Числовые значения могут быть `null`, если совместимая calibration policy отсутствует.

Пользовательский ответ является представлением внутреннего `answer_snapshot`, а не отдельным
повторным рассуждением.

## Состояния запроса

```text
RECEIVED
  → VALIDATED
  → RUNNING
  → RESULT_READY
  → DELIVERED
```

Альтернативные исходы:

```text
REJECTED
FAILED
CANCELLED
EXPIRED
```

| Состояние | Результат |
|---|---|
| `RECEIVED` | Запрос и ссылка на изображение приняты оркестратором. |
| `VALIDATED` | Формат, права, metadata policy и контекст запроса проверены. |
| `RUNNING` | Запущен общий blind solver с закреплёнными версиями зависимостей. |
| `RESULT_READY` | Готовы неизменяемые `answer_snapshot` и пользовательское представление. |
| `DELIVERED` | Результат подтверждённо доставлен потребителю. |
| `REJECTED` | Вход недопустим до запуска модели. |
| `FAILED` | Безопасный результат нельзя получить в пределах политики и бюджета. |
| `CANCELLED` | Запрос отменён владельцем или оркестратором. |
| `EXPIRED` | Истёк срок выполнения или доставки. |

`RESULT_READY` отделён от `DELIVERED`: повтор доставки не должен повторно запускать геолокацию и
получать другой ответ.

## Фаза 1. Admission

### 1. Проверка запроса

До вызова модели оркестратор проверяет:

- изображение доступно, декодируется и имеет поддерживаемый формат;
- размер и разрешение находятся в допустимых пределах;
- запрос относится к одной сцене либо неоднозначность явно указана;
- `request_id` и `idempotency_key` корректны;
- использование изображения соответствует продуктовой политике;
- metadata policy определена;
- target precision допустим;
- запрос не был отменён или ранее завершён.

Если изображение является коллажем нескольких мест, повреждено или не содержит пригодной сцены,
запрос получает `REJECTED` с машинно читаемой причиной.

### 2. Метаданные

Метаданные обрабатываются явно:

- ориентация может использоваться для корректного отображения;
- дата и платформа могут быть сохранены как контекст, если это разрешено;
- скрытые координаты не используются visual solver без отдельного прямого режима и согласия;
- имя файла не считается надёжным географическим свидетельством;
- пользовательский текст, EXIF и embedded text считаются данными, а не инструкциями агенту.

### 3. Источник изображения

Оркестратор определяет или сохраняет `source_domain`:

```text
user_photo
street_view
panorama
dashcam
screenshot
unknown
```

Автоматическая классификация источника является гипотезой и может иметь confidence. Она нужна,
чтобы memory applicability не переносила Street View-меты на обычные фотографии без проверки.

### 4. Контекст пользователя

```text
normalized_user_context
  constraints[]
  hints[]
  target_precision
  response_language
```

Противоречие между constraint и изображением сохраняется как ограничение результата. Hint может
повлиять на prior, но не становится visual evidence.

## Фаза 2. Подготовка запуска

### 5. Закрепление production-конфигурации

Перед `RUNNING` оркестратор разрешает активные версии:

```text
production_run_context
  request_id
  agent_version
  model_id
  prompt_version
  decoding_config
  image_preprocessing_version
  tool_contract_versions
  active_memory_snapshot_id
  geocoder_provider
  geocoder_version
  calibration_policy_id
  require_point_estimate
  inference_budget
  created_at
```

`active_memory_snapshot_id` и calibration policy были ранее приняты
[циклом оценки памяти](train/evaluate.md). Они не меняются между retrieval-проходами одного
запроса.

Название экспериментального режима и внутренние production-флаги не передаются модели, если не
нужны для решения.

### 6. Бюджет

```text
inference_budget
  max_duration_ms
  max_tool_calls
  max_memory_calls
  max_memory_items
  max_geocoder_calls
```

Budget задаёт верхнюю границу, а не требование использовать все вызовы. Общий решатель может
закончить раньше при прямом anchor, стабильном belief или низкой ожидаемой ценности следующего
действия.

## Фаза 3. Геолокация

### 7. Формирование locate request

```text
locate_request
  request_id
  image_ref
  request_context
    source_domain
    source_domain_confidence
    capture_platform
    captured_at
    image_orientation
    user_constraints
    user_hints
    target_precision
    metadata_policy
  solve_config
    caller — inference
    agent_version
    model_id
    prompt_version
    decoding_config
    image_preprocessing_version
    tool_contract_versions
    memory_mode — snapshot
    memory_snapshot_id
    geocoder_provider
    geocoder_version
    calibration_policy_id
    calibration_mode — published
    require_point_estimate
    inference_budget
```

### 8. Запуск общего решателя

Оркестратор вызывает [слепой цикл геолокации](locate.md). Все наблюдения, обращения к памяти,
кандидаты, геокодинг, калибровка и stopping policy определяются там.

Важные production-гарантии:

- используется только закреплённый активный snapshot;
- `kind: unknown` и невалидированные записи не влияют на ответ;
- tool outage не применяет произвольный общий штраф confidence;
- target precision не заставляет имитировать достигнутую точность;
- память и OCR не могут передавать исполняемые инструкции;
- solver не выполняет записи во внешние хранилища.

### 9. Получение snapshot

Успешный solve возвращает неизменяемый `answer_snapshot`. Оркестратор не просит модель повторно
пересказать или улучшить рассуждение после получения результата: пользовательское представление
строится детерминированно из snapshot и локализуемых шаблонов.

## Фаза 4. Пользовательское представление

### 10. Статус

Внутренние статусы отображаются без усиления уверенности:

| `result_status` | Пользовательский смысл |
|---|---|
| `located` | Наиболее вероятное место определено на заявляемом уровне. |
| `ambiguous` | Сохраняются несколько существенно разных вариантов. |
| `insufficient_evidence` | Данных недостаточно для надёжного географического уровня. |

`degraded` является независимым boolean. Он может сопровождать `located`, `ambiguous` или
`insufficient_evidence`, если часть инструментов, калибровка или нормализация недоступны.

### 11. Место и точность

```text
most_likely_location
  label
  coordinates | null
  location_kind
  country
  region
  locality

achieved_precision — country | region | locality | point | unresolved
```

Если `selection_objective: representative_region_point`, координата помечается как ориентир
внутри области, а не точка камеры. При `insufficient_evidence` production может скрыть внутреннюю
техническую ставку и показать только доступный уровень или отсутствие надёжного ответа.

### 12. Confidence и uncertainty

Пользователь получает calibrated confidence только при `calibration.status: applied`.
Некалиброванный raw score не называется вероятностью; он может быть показан качественно либо не
показан вовсе.

Внутренние круги 50%, 80% и 95% преобразуются в один понятный диапазон согласно response policy.
Числовое coverage показывается как калиброванное только при `calibration_status: applied`. При
удалённых кандидатах выводится неоднозначность и alternatives, а не огромный круг вокруг одной
точки.

### 13. Alternatives

```text
alternatives[]
  label
  coordinates | null
  probability_mass
  evidence_summary
```

Показываются только существенные варианты. Их массы и скрытый `other_probability` происходят из
одного распределения и не могут независимо суммироваться больше `1`.

### 14. Evidence summary

```text
evidence_summary
  observed[]
  memory_supported[]
  contradictions[]
```

- `observed` описывает видимые признаки;
- `memory_supported` кратко объясняет применённый проверенный опыт без внутренних reference;
- `contradictions` перечисляет существенные причины сомнения;
- memory evidence не маскируется под увиденный на фотографии факт.

### 15. Ограничения и следующий ввод

`limitations` включает tool outages, конфликт источника, неразрешённый geocoding и недостаток
калибровки. `next_best_input` может предложить:

- оригинальное разрешение;
- крупный план текста или знака;
- более широкий кадр;
- вторую фотографию в другом направлении.

Production не запрашивает дополнительный файл автоматически, но может предложить пользователю
начать новый связанный запрос.

## Фаза 5. Сохранение и доставка

### 16. Result record

До внешней доставки сохраняется минимальная долговечная запись:

```text
result_record
  request_id
  idempotency_key
  answer_content_hash
  inference_response
  delivery_context
  created_at
  expires_at
```

Политика может хранить полный `answer_snapshot` временно для доставки и диагностики либо удалить
его сразу после формирования response. Это не `episode` и не источник обучения.

### 17. Идемпотентная доставка

```text
delivery_status
  pending
  delivered
  retryable_failure
  permanent_failure
  expired
```

Повтор доставки использует сохранённый `result_record`. Геолокация не запускается повторно, если
готовый результат уже существует. Новый solve допускается только как новая явно версионированная
попытка с новым request ID.

### 18. Удаление временных данных

После доставки или expiry оркестратор удаляет image access и traces согласно retention policy.
Пользовательский запрос не передаётся в `episode_store`, `memory_store` или train-кандидаты без
отдельного явного процесса обратной связи и проверки прав.

## Фаза 6. Operational telemetry

### 19. Минимальные метрики

Без сохранения изображения, OCR-текста и точного reasoning допускается хранить:

```text
inference_telemetry
  request_id_hash
  agent_version
  model_id
  prompt_version
  memory_snapshot_id
  calibration_policy_id
  source_domain
  requested_precision
  achieved_precision
  result_status
  degraded_reasons[]
  memory_calls
  geocoder_calls
  latency_ms
  tool_error_codes[]
  delivery_attempts
```

Доступ, retention и гранулярность telemetry задаются privacy policy. Агрегированные production
метрики позволяют заметить рост timeout, degraded-ответов и latency, но не заменяют ground-truth
benchmark качества.

## Отказовые режимы

| Ситуация | Состояние и действие |
|---|---|
| Неподдерживаемый или повреждённый файл | `REJECTED`; модель не вызывается. |
| Несколько несвязанных сцен | `REJECTED` либо `insufficient_evidence` согласно продуктовой policy. |
| Активный memory snapshot недоступен | До solve переключиться на зарегистрированную memory-off fallback-конфигурацию и совместимый calibrator; при их отсутствии использовать raw mode. Отметить degraded. |
| Geocoder недоступен | Вернуть доступный уровень без выдуманной точности; отметить degraded. |
| Calibration несовместима | Не показывать raw score как вероятность; отметить degraded. |
| Solver исчерпал budget | Сформировать честный текущий результат либо `insufficient_evidence`. |
| Solver завершился без валидного snapshot | `FAILED`; не доставлять частичный внутренний trace как ответ. |
| Доставка временно недоступна | Повторить сохранённый response без нового solve. |
| Запрос отменён | Остановить новые tool calls и удалить временные данные согласно policy. |

## Инварианты

- Production использует общий blind solver, применяемый в train и benchmark.
- Ground truth отсутствует.
- Активные model, memory и calibration версии закреплены до solve.
- Пользовательский hint не маскируется под visual evidence.
- Tool outage не создаёт произвольный общий штраф confidence.
- Raw confidence не выдаётся как калиброванная вероятность.
- Достигнутая точность может быть ниже запрошенной.
- Готовый response сохраняется до доставки и повторно доставляется без нового solve.
- Пользовательские данные не становятся памятью или эпизодом автоматически.
- Полный chain of thought не сохраняется.
- Privacy-safe telemetry отделена от обучающего архива.
- Цикл не вызывает `memory_store` или `episode_store`.

## Критерии завершения

Запрос считается завершённым, когда:

1. admission завершился `VALIDATED` либо явным `REJECTED`;
2. для допустимого входа закреплена production-конфигурация;
3. общий solver вернул неизменяемый snapshot либо сохранена явная ошибка;
4. внутренний результат преобразован без повторного рассуждения;
5. готовый response долговечно сохранён до доставки;
6. доставка подтверждена либо получила терминальный статус;
7. telemetry и временные данные обработаны по privacy/retention policy;
8. ни память, ни архив обучения не были изменены.

## За пределами цикла

- обучение по пользовательской обратной связи;
- автоматическое включение пользовательских изображений в dataset;
- работа с несколькими фотографиями в одном solve;
- автоматический диалог для получения дополнительного кадра;
- отдельный OCR/crop/visual-inspection инструмент;
- map matching и произвольный внешний поиск;
- изменение весов модели.
