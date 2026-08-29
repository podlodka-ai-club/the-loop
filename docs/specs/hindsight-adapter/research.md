---
type: Research
title: "Hindsight как адаптер интерфейса Memory"
description: Исследование границы первой реализации Hindsight-адаптера для Loci, включая retain, hybrid recall, консолидацию observations и перенос состояния.
timestamp: 2026-08-29T00:00:00+03:00
date: 2026-08-29
model: gpt-5
resource: https://hindsight.vectorize.io/developer/api/quickstart
tags: [loci, memory, hindsight, temporal, typescript, adapter, research]
---

# Hindsight как адаптер интерфейса `Memory`

## Цель

Определить реалистичную границу первой реализации Hindsight-адаптера до принятия ADR и spec.
Главная неопределённость — не подключение HTTP-клиента, а совместимость двух моделей: Loci ждёт
массив коротких `Hint[]` и четыре метода `Memory`, а Hindsight извлекает несколько фактов из одного
текста, асинхронно консолидирует observations и теперь умеет переносить документы через архивы.

Исследование не меняет общие контракты [`memory_store`](/tools/memory_store.md),
[`memory_retrieve`](/tools/memory_retrieve.md) и workflow Loci. Оно определяет вопросы, которые
должны быть закрыты отдельным ADR и последующей spec.

## Контекст и заданные границы

- Текущий TypeScript-интерфейс [`Memory`](../../../src/memory/memory.ts) содержит `remember(lesson)`,
  `recall(features, limit)`, `snapshot()` и `restore(id)`.
- `memory_ref` остаётся opaque-ссылкой на provider и bank; Hindsight не обязан знать значение
  `memory_ref`. Registry Loci должен разрешать ссылку в `bank_id`, credentials и policy.
- Запись происходит только в training после reveal; evaluation и production вызывают только
  retrieval. Это задано [workflow обучения](/workflows/train.md) и [workflow оценки](/workflows/evaluate.md).
- Целевой deployment — Hindsight Cloud по HTTPS с Bearer API key. Self-hosted PostgreSQL/pgvector
  не входит в реализацию адаптера; он упоминается только как контраст операционных и data-governance
  рисков. На 2026-08-29 опубликованный `@vectorize-io/hindsight-client` имеет версию `0.9.2`; для
  реализации потребуется exact pin и Cloud integration fixture для конкретной версии API.
- Не следует автоматически считать новые возможности Hindsight готовым snapshot-контрактом:
  `Memory.snapshot()` возвращает строковый ID состояния, а Hindsight export возвращает архив
  документов и импортирует его отдельной асинхронной операцией.

## Статус утверждений

В документе используются три уровня уверенности:

| Статус | Смысл |
|---|---|
| **Подтверждено по документации/типам** | Зафиксировано в официальном API или опубликованных типах `@vectorize-io/hindsight-client@0.9.2`; это ещё не заменяет live integration test |
| **Ограничение Loci** | Следует из текущего репозитория и его workflow, а не из Hindsight |
| **Проверить в пилоте** | Результат зависит от deployment, данных, LLM или runtime envelope |

Подтверждены по текущему API: sync/async retain, `document_id`, metadata, token-based recall без
count-based `limit` в TypeScript types, поля recall result, `getVersion` и document-transfer.
Проверить в пилоте нужно read-after-write, фактическое число и качество extracted facts, latency,
settle time observations, сохранение provenance и поведение ошибок на выбранном Cloud deployment.

## Что предоставляет Hindsight

### Retain и внутренняя модель

`retain` принимает текстовый item и автоматически выполняет extraction фактов, embedding, entity
resolution и создание semantic/temporal links. Один lesson может породить ноль, один или несколько
memory units. Факты делятся на `world`, `experience` и `observation`; observations создаются из
накопленных фактов и имеют ссылки на supporting source facts.

Синхронный `retain` ждёт завершения основного ingestion pipeline и возвращает `success`, bank,
число обработанных items и usage. После него auto-consolidation observations запускается отдельно
в фоне. Поэтому успешный `remember` может означать, что raw facts уже видны, но consolidated
observation ещё не построена.

Для каждого lesson Hindsight предлагает два полезных идентификатора:

- `document_id` группирует исходный текст и связанные memory units; повторный retain с тем же ID
  переобрабатывает документ, удаляя его предыдущие memories;
- `metadata` сохраняет строковые поля на факте и передаётся также в extraction prompt.

`document_id` делает повтор с тем же `sourceAttemptId` контролируемее, но имеет разрушительную
семантику: предыдущие memories этого документа удаляются перед повторной обработкой. Поэтому
прямое отображение `documentId = sourceAttemptId` допустимо только если контракт подтверждает, что
один `sourceAttemptId` соответствует ровно одному logical lesson и повтор означает replace. Если
одна попытка может дать несколько lessons или требуется append, нужны другой deterministic ID и
явная duplicate policy. Даже с `document_id` повтор после синхронного сетевого timeout не является
доказанно идемпотентным: запрос мог завершиться на сервере до потери ответа. Асинхронный retain
принимает заранее созданный `operation_id`; повтор с тем же ID не создаёт новую работу. Это
безопаснее для retry, но требует ожидания и чтения статуса операции.

По умолчанию Hindsight также может хранить исходный текст документа рядом с извлечёнными фактами.
Это нужно отдельно согласовать с требованиями к данным: адаптер не хранит canonical copy локально,
но сам provider может сохранять переданный lesson.

### Recall

`recall` — native ranked retrieval по естественно-языковому запросу. Одновременно работают
semantic, keyword/BM25, graph и temporal стратегии, после чего результаты rerank-ятся. Ответ
содержит массив объектов с `id`, `text`, `type`, `context`, `metadata`, `document_id`, tags,
временными полями, `source_fact_ids` и диагностическими scores. Дополнительно можно запросить
source facts, chunks и entities.

Ключевое ограничение — Hindsight думает бюджетом токенов, а не числом результатов. В типах
`@vectorize-io/hindsight-client@0.9.2` у `recall` нет параметра `limit`; есть `maxTokens`,
`budget`, фильтр типов и дополнительные include-параметры. В некоторых текущих примерах
TypeScript-документации всё ещё показан `{ limit: 5 }`, поэтому это нужно считать version-drift и
не полагаться на пример без compile/runtime-проверки.

`reflect` строит один generated markdown-ответ и опционально возвращает `based_on` с evidence.
Он хорошо соответствует вопросу «что следует считать выводом», но не соответствует текущему
`Hint[]`: у него нет гарантии одного элемента на lesson, строгого top-K и provider fact ID.

### Bank и конфигурация

Bank естественно выражает область памяти `memory_ref`: данные банков изолированы, bank можно
создать или обновить, а extraction направляется через `retain_mission`, extraction mode и
дополнительные bank settings. Для Loci mission-кандидат должен описывать географические cues,
региональные различия, counter-signals и переносимые процедуры, а не пользовательские
предпочтения или внутренний chain-of-thought.

Tags могут разделять training data, source attempt и другие scopes. Однако уникальный tag каждой
попытки становится границей consolidation и не даёт observations объединяться между episodes.
Если provenance-tag нужен для фильтрации, а observations должны быть общими, Hindsight имеет
отдельный `observation_scopes: "shared"` режим. Это полезный, но ещё не принятый policy choice.

## Совместимость с Loci

| Операция `Memory` | Кандидатное отображение | Что теряется или требует решения |
|---|---|---|
| `remember(lesson)` | Синхронный `retain(bankId, lesson.content)` с `documentId = sourceAttemptId`, context и namespaced metadata | Raw facts видны после retain, observations — нет гарантии немедленной готовности; retry после timeout требует policy |
| `recall(features, limit)` | Query из непустых features, `recall`, затем defensive `slice(0, limit)` | Provider ограничивает ответ токенами, а не count; один lesson может дать несколько fact hints |
| `snapshot()` | В v1 unsupported; в будущем async export в локальный архив | Export/import не является строковым checkpoint текущего bank и не имеет прямого class-level import helper |
| `restore(id)` | В v1 unsupported; в будущем импорт архива в отдельный target bank | Нужны archive storage, новый bank или destructive replacement и reconciliation provider IDs |

Если v1 сохраняет текущий `Memory` без расширения интерфейса, это не означает, что методы молча
исчезают. Кандидатный composition contract для следующей spec, согласованный с уже существующими
адаптерами, таков: factory до создания Hindsight client отклоняет `requirements.snapshots: true`
как `unsupported_configuration`; прямые вызовы `snapshot()` и `restore()` завершаются
`unsupported_operation` и не делают network call. Такой adapter является pilot-only и не может
подменить snapshot-зависимый evaluation workflow без отдельного operational freeze или recovery
capability.

### Provenance и `Hint`

Вариант `lessonId = result.id` честно сохраняет уникальность и порядок facts, но это Hindsight
memory-unit ID, а не ID исходного lesson. Вариант `lessonId = result.document_id` ближе к модели
Loci, но несколько facts одного lesson получают одинаковый ID и могут потерять различимость.
Текущий `Hint` не имеет отдельного поля `sourceAttemptId`, поэтому metadata нельзя вернуть в
общий prompt без изменения интерфейса.

Для первого адаптера нужно выбрать, что важнее:

1. несколько provider facts как несколько `Hint` с уникальными fact IDs;
2. один hint на source lesson с локальным dedup/grouping;
3. один synthesized `reflect`-ответ как один hint.

Третий вариант наиболее сильно меняет смысл текущего интерфейса и добавляет LLM variability.
Первый лучше сохраняет native ranked retrieval и evidence, но делает `Hint` атомарным фактом, а
не lesson. Второй требует дополнительной политики агрегации, которой Loci сейчас не описывает.

### Пустые `features`

Текущий benchmark часто вызывает `recall` с пустым массивом: в `FileMemory` режим `top` тогда
возвращает global prior. У Hindsight нет операции «вернуть самые полезные факты вообще» без query.
Реальные варианты:

| Вариант | Польза | Риск |
|---|---|---|
| Вернуть `[]` | Честно отражает отсутствие поискового запроса; минимальная стоимость | В текущем single-call benchmark Hindsight почти не влияет на результат |
| Отправить фиксированный configured prior query | Даёт памяти шанс повлиять на каждый solve | Один и тот же контекст попадает к каждой фотографии; это уже отдельная retrieval policy |
| Завершить вызов ошибкой capability/input | Не маскирует отсутствие native semantics | Несовместимо с обычным workflow и делает adapter непригодным без upstream feature extraction |

До ADR нельзя молча выбрать один из этих вариантов. Особенно важно не называть fixed prior
релевантным retrieval: это глобальная подсказка, а не поиск по признакам фотографии.

## Варианты первой реализации

| Вариант | Скорость старта | Качество соответствия `Memory` | Риски и цена |
|---|---:|---:|---|
| **A. Raw recall + synchronous retain** | Высокая | Средняя/высокая: сохраняет native ranking и fact IDs | `limit` только после ответа; observations eventual; timeout write outcome нужно нормализовать |
| **B. Raw recall + async retain с idempotent operation** | Средняя | Высокая для ingestion lifecycle | Нужен polling через low-level SDK/raw port, deadline, operation status и quarantine/reconciliation |
| **C. Reflect как один `Hint`** | Высокая | Низкая: один generated answer не равен ranked lessons | Потеря count/provenance, дополнительный LLM cost и nondeterminism; трудно сравнивать с FileMemory |
| **D. Raw recall плюс Hindsight archive как snapshot/restore** | Низкая | Потенциально полная для provider state | Архив бинарный, экспорт/import асинхронны, embeddings/DB IDs меняются, нужен lifecycle target bank |
| **E. Provider-native интерфейс вместо текущего `Memory`** | Низкая | Полная | Требует менять benchmark, workflow и общий контракт; это отдельная архитектурная работа |

Ведущая кандидатура для ADR — A, если пилот покажет заранее заданные в ADR p50/p95 и не создаст
неприемлемого training deadline. B следует выбрать, если одна запись часто выходит за этот
deadline или нужна безопасная повторная отправка после потери ответа. C не следует принимать как
compatibility adapter без явного изменения интерфейса. D и E лучше оставить отдельными
capabilities, а не встраивать в первую реализацию.

## Scope записи и качество extraction

Кандидатная граница данных для одного `remember`:

- `content` — исходная reflection-проза без добавления скрытого chain-of-thought;
- `documentId` — `sourceAttemptId` только при подтверждённых уникальности и replace-policy;
  иначе deterministic document ID должен включать logical lesson identity, либо поле не
  передаётся;
- metadata с namespace `loci_` для `source_attempt_id`, `region` и serialized triggers;
- стабильный context вроде `loci training reflection`;
- tags для назначения и диагностической фильтрации, но без уникального per-attempt tag как
  неявной границы observations;
- bank-level retain mission, направляющая extraction к visible cues, географическим contrast и
  переносимому опыту.

Metadata участвует в extraction prompt, поэтому source ID, region и triggers — не нейтральные
технические поля. Spec должна задать escaping, длины, Unicode/whitespace normalization,
защиту от prompt/data injection и проверку того, что provider не превращает служебные поля в
географические утверждения.

Для retrieval есть три provider-native policy:

- `world`/`experience` facts — доступны сразу после synchronous retain и сохраняют source-level
  provenance, но могут дублироваться;
- `observation` — compact cross-episode knowledge с evidence, но появляется после background
  consolidation и может быть stale или отсутствовать;
- смешанный recall с `preferObservations` — потенциально сочетает fallback raw facts и отсутствие
  дубликатов, но требует проверки качества и фактического ответа на пустой/малый bank.

Окончательный выбор не следует делать только по удобству prompt. Он должен быть измерен на
географических lessons, особенно на stratum с counter-signals, пограничными регионами,
отрицательными выводами и неоднозначными cue.

## Согласованность, retry и settle period

У Hindsight есть три разных временных события:

1. HTTP completion synchronous `retain` — основной extraction и запись facts завершены;
2. eventual auto-consolidation — observations создаются или обновляются в фоне;
3. retrieval ranking — результат зависит от индексов, reranker и текущего состояния bank.

Поэтому нужно отдельно измерить read-after-write для raw facts и время появления observations.
Evaluation не должен начинаться просто по окончании последнего HTTP `retain`, если выбран режим,
который зависит от observations. Возможны два честных эксперимента: зафиксировать измеримый settle
period либо оценивать только raw facts и явно не включать consolidation в v1.

Синхронный путь проще и не требует adapter-owned operation poller. Асинхронный путь принимает
caller-generated `operation_id`, что позволяет безопасно повторить потерянное подтверждение, но
высокоуровневый TypeScript class не предоставляет отдельный публичный `getOperationStatus`;
придётся использовать экспортированный low-level SDK или собственный transport port. Автоматический
retry без operation ID нельзя считать безопасным: тот же lesson может породить повторный extraction,
embeddings и provider cost.

Кандидатный error lifecycle для следующей spec должен быть явным:

- `recall` с transient `unavailable`, `rate_limited` или transport timeout возвращает нормализованную
  retryable error; orchestration может повторить retrieval в новом blind context, но не заменяет
  память на `[]`;
- sync `remember` после timeout возвращает `write_outcome_unknown`, не повторяет content
  автоматически и помечает запись для reconciliation по document/metadata provenance;
- async `remember` генерирует operation ID до запроса, после чего poller ждёт terminal status;
  потерянное подтверждение повторяет тот же operation ID, а не создаёт новую операцию;
- `failed`, malformed response, auth/config и неизвестный status — terminal errors, не успешный
  пустой write. Точная quarantine/reconciliation policy принадлежит ADR/spec.

## Snapshot, restore и recovery

Актуальный Hindsight API предоставляет document-transfer export/import. Архив может переносить
документы, chunks, извлечённые facts, entities, links и опционально observations. Embeddings и
внутренние database IDs не переносятся: target bank заново строит embeddings и entity resolution.
Export теперь выполняется асинхронно, а import возвращает operation ID и также выполняется в фоне.

Это полезно для будущего migration/recovery, но не эквивалентно текущему `Memory`:

- `snapshot()` должен быстро вернуть строковый ID локально адресуемого неизменяемого состояния, а
  export возвращает `Uint8Array` архив после фоновой операции;
- `restore(id)` должен заменить working store, а import обычно ориентирован на новый или явно
  выбранный target bank и меняет provider IDs;
- archive storage, retention и размер файла выходят за текущий memory contract;
- импорт observations as-is может не merge-иться с уже существующими observations;
- destructive delete/recreate bank для имитации restore потребует отдельного разрешения и recovery
  protocol.

Следовательно, наличие export/import снижает риск долгосрочной потери данных, но не отменяет
решение «поддерживает ли adapter v1 snapshot capability». До ADR безопасная граница — публиковать
`snapshot: false`, `restore: false` и отклонять snapshot-dependent workflow до первого provider
вызова. Будущий recovery должен быть отдельной операцией export/import с собственным artifact ID,
target bank и reconciliation report.

## Изоляция окружений и evaluation

Один bank нельзя считать одновременно training workspace, immutable evaluation snapshot и
production memory. При unsupported snapshot/restore остаются только operational варианты:

| Вариант | Что позволяет | Цена/риск |
|---|---|---|
| Отдельный disposable bank на pilot/run | Чистый эксперимент и отсутствие cross-run contamination | Нет provider snapshot; повторяемость требует не писать после training |
| Export в архив и новый target bank | Provider-level freeze/rebuild без общего интерфейса `Memory` | Асинхронный artifact lifecycle, новые IDs и изменённый ranking |
| Общий долгоживущий bank | Быстрый smoke/eval | Training, eval и production могут смешать state; не годится как benchmark contract |

Минимальный pilot должен использовать уникальный bank, запрещать записи после training и не
регистрировать его как production `memory_ref`. Перед подключением к snapshot-dependent workflow
нужен отдельный ADR о bank clone/export или изменение evaluation composition.

## Deployment, credentials и observability

Минимальная runtime-конфигурация кандидата:

- `HINDSIGHT_API_KEY` — единственный Bearer credential, только в `.env`;
- фиксированный адрес Hindsight Cloud API — константа адаптера;
- bank и `memory_ref` — resolved source от registry, не переменные окружения;
- provider-specific retrieval и retain policy — programmatic policy adapter instance, не вход
  общего tool.

Hindsight Cloud уменьшает операционную работу: Loci не управляет PostgreSQL/pgvector, LLM
credentials, migrations и background workers. Цена этого упрощения — lessons, metadata и queries
передаются внешнему сервису. До live pilot нужно подтвердить Cloud retention, residency,
provider/model training terms, rotation/revoke API key, HTTPS/TLS boundary и изоляцию bank.

Адаптер должен нормализовать `HindsightError.statusCode` и не отдавать raw `details` в logs или
ошибки, потому что там могут находиться provider payload, fragment lesson или служебные данные.
Минимальные стабильные категории:

- `unsupported_configuration`;
- `invalid_input`;
- `authentication` / `authorization`;
- `rate_limited` / `quota_exceeded`;
- `unavailable`;
- `timeout` и `write_outcome_unknown`;
- `protocol_error`;
- `unsupported_operation` для snapshot/restore в v1.

Пустой recall — успешное отсутствие результата; provider failure не должен превращаться в `[]`.
Для диагностики полезны bank-independent adapter trace ID, provider operation ID при наличии,
количество raw results, types и latency. Не следует логировать API key, полный lesson/query,
ground-truth coordinates или полный provider response.

## Воспроизводимый pilot до ADR/spec

На disposable bank и frozen наборе нужно провести один и тот же протокол. Он не назначает пороги
production, но делает сравнение вариантов принимающим решение:

- подготовить 30 уникальных lessons, по 6 в пяти stratum: positive evidence, negative evidence,
  comparison, ambiguous cue и incomplete/counter-signal; каждому lesson назначить уникальный
  `sourceAttemptId`;
- подготовить 30 matching queries с ожидаемым source lesson/evidence и 5 кейсов с пустыми
  `features`; сохранить policy, `limit = 5`, bank ID и exact SDK version;
- выполнять retain FIFO в чистом bank, делать raw recall сразу после каждой записи, затем повторять
  observation/mixed reads в фиксированные моменты 60 и 300 секунд;
- отдельно прогнать raw, observation и mixed policies на одинаковых queries; для empty features
  сравнить `[]` и configured prior, не выдавая prior за релевантный retrieval;
- после фиксации bank/artifact провести memory-on geolocation evaluation без новых writes;
- export/import и transport error matrix запускать отдельно, чтобы failure recovery не загрязнял
  основной quality run.

Минимальный summary сохраняет per-case provider response, adapter `Hint[]`, fact/document IDs,
metadata presence, groundedness verdict, leakage verdict, latency, token/cost usage и error code.
Дополнительно проверить:

- exact runtime surface `@vectorize-io/hindsight-client@0.9.2`, включая response envelopes,
  `HindsightError`, `getVersion` и отсутствие count-based `limit` в `recall`;
- synchronous retain latency, 0/1/N extracted facts, success с нулём facts и read-after-write;
- сохранение `document_id`, namespaced metadata, tags и source provenance;
- повторный retain с тем же `document_id`, потерянное подтверждение и operation ID для async;
- время появления observations, near-duplicates, source facts и effect `preferObservations`;
- strict `limit` после provider response, число hints на один lesson и стабильность provider IDs;
- extraction quality, Memory Defense/422 и partial-block поведение, если эта функция включена;
- p50/p95 latency, token usage, rate limits и стоимость отдельно для retain, consolidation и
  recall;
- export/import на disposable bank, включая archive size, observations, changed IDs и
  восстановление в новый target bank;
- fake transport tests для 401/403/404/409/422/429/5xx, timeout, malformed JSON и unknown
  status/code без расходования Cloud quota.

Итог публикует числители и знаменатели по каждому stratum, hit@5 после adapter slice, 0/1/N fact
counts, provenance/leakage failures, p50/p95 latency, token/cost usage, observation visibility на
обоих checkpoints и error counts. Порог качества, допустимые p50/p95 и решение о production нужно
зафиксировать в ADR до запуска или явно обновить по результатам pilot.

## Открытые вопросы для ADR

- **Граница `Hint`:** ADR выбирает `fact.id → lessonId` с несколькими hints на lesson, группировку
  по `document_id` или provider-native redesign; критерий — provenance, строгий limit и отсутствие
  потери counter-signals.
- **Пустой запрос:** ADR выбирает `[]`, configured global prior или capability error; критерий —
  честная интерпретация memory-on arm и результат 5 empty-feature cases.
- **Recall policy:** ADR выбирает raw, observation или mixed `preferObservations`; критерии —
  hit@5, groundedness, duplicate rate, tokens и latency.
- **Count limit:** ADR фиксирует `maxTokens` и локальный slice; критерий — ни один adapter result не
  превышает `limit`, а over-fetch укладывается в бюджет.
- **Write lifecycle:** ADR выбирает sync или async+operation poll; критерии — p95 training latency,
  потерянное подтверждение и отсутствие duplicate writes.
- **Consolidation gate:** ADR выбирает settle period или raw-only v1; критерии — observation
  visibility/reproducibility на 60/300-секундных checkpoints.
- **Provenance и duplicate policy:** ADR фиксирует уникальность `sourceAttemptId`, replace/append,
  metadata/document/tags mapping и reconciliation после re-retain/import.
- **Bank/evaluation policy:** ADR фиксирует disposable bank, archive clone или provider-native
  snapshot; критерий — training/eval не видят новые writes и не смешивают dev/pilot/prod.
- **Recovery:** ADR решает, остаются ли snapshot/restore unsupported в v1, несмотря на
  document-transfer, или появляется отдельный export/import capability с artifact lifecycle.
- **Cloud/data governance:** ADR фиксирует Hindsight Cloud как deployment и получает подтверждение
  retention, residency, model-training terms, rotation/revoke API key и разрешённых полей.
- **Capability gate:** spec называет composition point, который отклоняет
  `requirements.snapshots: true` до создания клиента и первого LLM/provider call.

## Открытые вопросы для pilot

- Сколько фактов извлекается из каждого stratum, сколько из них grounded и как часто служебные
  metadata становятся ложным географическим утверждением?
- Видны ли raw facts сразу после sync retain, когда появляются observations и меняется ли ranking
  на checkpoint-ах?
- Можно ли по `document_id` и metadata надёжно восстановить logical source lesson после retry,
  export/import и provider ID change?
- Как часто synchronous retain выходит за training deadline и какие реальные p50/p95 и token/cost
  получаются у Hindsight Cloud?
- Какие provider status/error envelopes нужно добавить в fake port после просмотра live fixtures?

## Следующий шаг

Принять ADR, который зафиксирует семантику `Hint`, поведение пустых features, raw/mixed recall,
synchronous/async retain и snapshot capability. Затем провести disposable Hindsight pilot на
frozen lessons/queries и написать spec с exact SDK pin, bank/env mapping, transport port,
provenance encoding, errors, deadlines, tests и capability gate. До этого не следует добавлять
Hindsight в production registry или менять общие tool/workflow-контракты.

## Термины

- `bank` — изолированная область Hindsight, соответствующая provider-side scope;
- `memory unit` / `fact` — атомарный результат extraction;
- `observation` — consolidated belief, связанный с source facts;
- `document_id` — provider ID исходного retained текста, не обязательно ID отдельного fact;
- `settle period` — измеряемое ожидание после retain до оценки background consolidation;
- `configured prior` — один общий query, применяемый при отсутствии observed features;
- `write outcome unknown` — timeout после момента, когда provider мог принять запись;
- `defensive slice` — локальное ограничение массива после provider retrieval, не native top-K.
- `Memory Defense/422` — provider policy, при которой retain может быть полностью отклонён как
  policy violation; partial-block может вернуть 200 с отброшенными items;
- `observation scope` — набор tags, в границах которого Hindsight сравнивает и обновляет
  observations;
- `requirements.snapshots` — composition-time capability requirement, не поле общего tool
  contract; его точное место должен закрепить spec;
- `LessonInput` — текущая входная модель Loci с `content`, `sourceAttemptId`, `triggers` и
  `region`.

## Источники

1. [Hindsight Quick Start](https://hindsight.vectorize.io/developer/api/quickstart) — установка,
   Node.js client и разделение retain/recall/reflect.
2. [Retain API](https://hindsight.vectorize.io/developer/api/retain) — extraction, metadata,
   `document_id`, sync/async retain и operation ID.
3. [Recall API](https://hindsight.vectorize.io/developer/api/recall) — hybrid retrieval, token
   budget, result fields, source facts и chunks.
4. [Observations](https://hindsight.vectorize.io/developer/observations) — background consolidation,
   scopes, evidence и near-duplicate reconciliation.
5. [Memory Banks](https://hindsight.vectorize.io/developer/api/memory-banks) — isolation,
   configuration и document export/import.
6. [Operations API](https://hindsight.vectorize.io/developer/api/operations) — async operation
   status и retain lifecycle.
7. [TypeScript SDK Guide](https://docs.hindsight.vectorize.io/typescript-sdk/) — client surface и
   integration examples.
8. [TypeScript client package](https://www.npmjs.com/package/@vectorize-io/hindsight-client) —
   published version `0.9.2` и package metadata.
9. [Hindsight repository](https://github.com/vectorize-io/hindsight) — source, clients, deployment
   and license.
