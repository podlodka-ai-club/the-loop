---
type: Research
title: "xmemory Cloud как адаптер интерфейса Memory"
description: Исследование TypeScript-адаптера Memory поверх xmemory Cloud, включая XMD-схему, provisioning, read/write semantics и отказ от snapshot и restore в v1.
timestamp: 2026-08-28T00:00:00+03:00
date: 2026-08-28
model: gpt-5
resource: https://xmemory.ai/typescript/
tags: [loci, memory, xmemory, cloud, xmd, typescript, adapter, research]
---

# xmemory Cloud как адаптер интерфейса Memory

## Цель

Определить границу первой реализации `Memory` поверх xmemory Cloud. Адаптер должен использовать
API key, поддерживать `remember` и `recall`, а `snapshot` и `restore` — возвращать явную ошибку по
аналогии с Mem0. В отличие от Mem0, xmemory не работает без предметной XMD-схемы, поэтому схема и
воспроизводимое создание instance входят в реализацию v1, а не считаются внешней ручной настройкой.

Продуктовые контракты [memory_store](/tools/memory_store.md) и
[memory_retrieve](/tools/memory_retrieve.md) этим исследованием не меняются. Исследуется
совместимость с текущим TypeScript-интерфейсом `Memory` из `src/memory/memory.ts`.

## Заданные границы

Пользователем заданы четыре решения:

- backend — xmemory Cloud с API key;
- реализуется текущий TypeScript-интерфейс `Memory`;
- XMD-схема и способ создания instance входят в будущую реализацию;
- `snapshot()` и `restore()` не реализуются и возвращают явную ошибку по аналогии с Mem0.

Остальное — SDK против raw REST, форма recall, состав schema, credential scopes, provisioning и
recovery policy — является предметом исследования, а не принятым решением.

До появления snapshot или воспроизводимого rebuild path область v1 ограничена disposable pilot
instances. Использовать такую память как единственную production-копию опыта нельзя.

## Что проверено

Срез выполнен 2026-08-28 по официальным TypeScript, REST API, XMD и Temporal-материалам, а также по
опубликованным declarations npm-пакета. На момент проверки npm `latest` — `xmemory@3.8.1`; пакет не
имеет runtime dependencies и использует native `fetch`.

Локальный xmemory CLI аутентифицирован, но доступных instances нет. Поэтому ниже разделены
documented contract и ещё не проверенное live-поведение. Extraction, durability, read visibility,
формы пустого ответа и latency остаются обязательной частью пилота до spec.

| Операция | Документированный контракт | Что ещё проверить live |
|---|---|---|
| Client | `new XmemoryClient({ apiKey, url, timeoutMs })`; constructor не делает health check | 401/403, redirect policy, timeout и malformed response |
| Instance | `client.instance(instanceId)` синхронно создаёт scoped handle | Как key permissions ограничивают instance/cluster |
| `write` | Text проходит schema-aware extraction и diff/merge; Promise возвращается после server-side commit | Durability, immediate read visibility и lost-response outcome |
| `writeAsync` | Возвращает `write_id`; читать можно после статуса `completed` | Latency и необходимость async path для выбранной schema |
| `read` | Natural-language query; `single-answer`, `xresponse` или `raw-tables` | Empty/no-match envelopes и стабильность порядка results |
| Errors | `XmemoryAPIError` содержит `status`, `code`, `details`, `retryAfter` | DNS/TLS/abort/5xx и неизвестные provider codes |
| Schema | Instance governed by XMD v1 | Нормализация YAML в live `data_schema` и drift semantics |
| Snapshot | Публичный data-plane не предоставляет state checkpoint/restore | Capability gate до любого provider/model call |

## Главное несовпадение интерфейсов

`Memory.recall(features, limit)` ожидает массив `Hint[]`: отдельные lessons в релевантном порядке,
с устойчивым `lessonId` и строгим верхним пределом. xmemory `read(query)` возвращает один
синтезированный или структурированный `reader_result`; у него нет параметра `limit`, публичного
ranking score или общего ID найденного lesson.

Это не транспортная мелочь, а потеря семантики. Generic adapter может вернуть результат xmemory в
prompt, но не может честно представить его как native top-K lessons.

| Вариант recall | Верность `Memory` | Provenance | Schema coupling | Цена/сложность |
|---|---|---|---|---|
| `single-answer` как один `Hint` | Низкая: нет lesson ID и top-K | Только read trace | Низкая | Самый короткий prompt и adapter |
| `xresponse` как один JSON `Hint` | Низкая: всё ещё один payload | Objects/relations, если response их сохраняет | Средняя | Больше tokens и parsing |
| `raw-tables` → несколько `Hint` | Средняя: можно получить source IDs и `LIMIT`, но relevance/order генерирует reader | Высокая | Высокая | Больше schema-specific tests |
| Отдельный provider-native port | Высокая для xmemory, но это уже не текущий `Memory` | Native | Низкая | Меняет архитектурную границу |
| Не реализовывать adapter без изменения `Memory` | Полная честность контракта | Не теряется | Нет | Блокирует feature до общего redesign |

Ни один путь пока нельзя назвать compatibility adapter без оговорки. `single-answer` меняет
семантику `lessonId` и `limit`, а `raw-tables` не получает от API гарантированного relevance score.
ADR должна либо явно разрешить эту несовместимость, либо выбрать provider-native interface/no-go.
Live pilot сравнивает первые три режима, но не подменяет архитектурное решение метрикой качества.

## Возможное отображение после ADR

| `Memory` | Кандидат | Нерешённая граница |
|---|---|---|
| `remember(lesson)` | `instance.write(text, { extractionLogic })` либо async+status | Timeout, commit visibility и retry выбираются после пилота |
| `recall(features, limit)` | Один из трёх read modes | Нельзя обещать native ranked lessons до ADR |
| `snapshot()` | Rejected Promise с `unsupported_operation` и method-specific message | Не вызывает SDK и не меняет instance |
| `restore(id)` | Rejected Promise с тем же code и другим method-specific message | Не валидирует ID, не вызывает SDK и не меняет instance |

Как у Mem0, factory должна публиковать `{ snapshot: false, restore: false }` и отклонять
`requirements.snapshots: true` до создания SDK client. Различимость snapshot/restore обеспечивают
message или поле `operation`, хотя стабильный общий code может оставаться одним.

### Запись lesson

Кандидат text write содержит не только `LessonInput.content`, но и идентифицирующие поля, которые
xmemory должен извлечь и использовать для merge:

```markdown
# Training experience

<lesson.content>

# Loci provenance

- source_attempt_id: <lesson.sourceAttemptId>
- region: <lesson.region>
- observed_triggers: <lesson.triggers, one per line>
```

Это Markdown, а не provider JSON. Буквальный `source_attempt_id` является кандидатом на primary key,
но становится им только после успешной extraction: это нужно доказать round-trip тестом. Spec
должна определить escaping delimiters/backticks, Unicode и whitespace normalization, допустимые
длины, duplicate ID policy и запрет управляющих конструкций внутри provenance block. Triggers и
region остаются данными эпизода, а `lesson.content` всегда считается недоверенным data payload.

Синхронный и async+polling paths остаются кандидатами. Первый проще и документирован как ожидание
commit, второй лучше переживает долгую deep extraction, но требует собственного deadline/status
contract.

### Recall query

Пустой `features` не следует автоматически отправлять как бессодержательный read. В текущем
benchmark пустой список означает global prior, но xmemory не имеет native операции «top lessons
overall». ADR выбирает между `[]`, явной unsupported/capability error и отдельным configured prior
query. Первые два поведения различаются: `[]` выглядит как успешное отсутствие релевантной памяти.

Для непустых features query просит применимые знания, сравнения и контрпризнаки, не раскрывая
ground truth. Точное значение `limit` зависит от выбранного read mode: для `single-answer` это лишь
инструкция краткости и потому несовместимость, для schema-specific tables — проверяемый SQL limit
без гарантии native relevance ranking.

## XMD-схема v1

### Что должна обеспечить схема

- один source training experience можно идентифицировать через буквальный `source_attempt_id`;
- transfer lesson и provenance не смешиваются между попытками;
- любые merge cues и places опираются на проверенную identity policy, а не только похожее имя;
- positive evidence, counter-signals, comparisons и caveats остаются доступны natural-language
  read;
- extraction не создаёт сведения о пользователе или агенте из геолокационного lesson;
- схема позволяет проверить хотя бы один выбранный recall path end-to-end.

### Кандидаты

| Модель | Плюсы | Риск |
|---|---|---|
| Только `TrainingExperience` | Самая простая extraction и явный provenance | xmemory почти не консолидирует cues и places между episodes |
| Только нормализованные `Cue`/`Place`/`Rule` | Компактная knowledge model и сильный cross-episode recall | Слабый provenance, нестабильная identity автоматически извлечённых rules |
| Гибрид source + derived objects | Сохраняет episode и даёт переиспользуемые знания | Больше extraction failure modes и relations для тестирования |

Пилот должен сравнить две committed XMD-кандидатуры, а spec выбрать одну конкретную:

1. **Source schema:** только `TrainingExperience`.
2. **Hybrid schema:** `TrainingExperience` и source-specific `Insight`; `VisualCue` и `Place`
   добавляются только если identity tests докажут безопасный merge.

Обязательное ядро обеих кандидатур:

| Object | Назначение | Identity |
|---|---|---|
| `TrainingExperience` | Один раскрытый эпизод: source ID, исходный lesson, region и triggers | `primary_key: [source_attempt_id]` |
| `Insight` | Один вывод конкретного source episode: evidence, comparison, caveat или procedure | `primary_key: []`; не консолидируется между episodes |

В hybrid schema relation `derived_from` связывает каждый `Insight` ровно с одним
`TrainingExperience`. Несколько episodes, независимо подтвердившие одинаковый вывод, остаются
несколькими source-specific insights: это сохраняет provenance и не обещает несуществующую
deduplication. Повтор потерянной text write всё равно может создать duplicate insight, поэтому
reconciliation остаётся отдельной задачей.

`Insight` хранит `statement` и закрытый `kind`: `positive_evidence`, `negative_evidence`,
`comparison`, `caveat` или `procedure`. Relations не получают scalar attributes: XMD v1 их не
поддерживает.

`VisualCue.primary_key: [name]` опасен из-за синонимов, языка и нормализации. `Place.primary_key:
[name]` смешивает одноимённые города, уровни и страны. Для каждого object пилот сравнивает unkeyed
records с composite key (`canonical_name + kind/context`). Если literal context отсутствует или
извлекается нестабильно, v1 оставляет object unkeyed либо не включает его в schema; false merge
опаснее диагностируемых duplicates.

Полный YAML с operational descriptions, required fields, enum boundaries, deletion policy и
relation keys должен быть нормативной частью следующей spec и коммититься как implementation
artifact. Пилот до spec использует отдельные disposable candidate schemas, явно помеченные как
spike assets; они не становятся production contract автоматически.

## Provisioning и drift

Есть три способа получить instance:

| Подход | Стоимость | Риск |
|---|---|---|
| Создать вручную в console/CLI | Быстро для spike | Невоспроизводимая schema и незаметный drift |
| Создавать или мигрировать на старте adapter | Меньше ручных шагов | Runtime получает control-plane authority и может изменить production data |
| Отдельная repo-команда provisioning | Явное действие, reviewable XMD, повторяемая настройка | Нужно хранить cluster/instance config и отдельно запускать setup |

Отдельная repo-команда — ведущий кандидат, но до spec нужно проверить весь admin flow через
`xmemory@3.8.1`: выбор cluster, повторное имя, race двух запусков, частичное создание, audit output
и cleanup disposable instance. Команда не должна автоматически удалять или мигрировать instance.

Provisioning требует control-plane credential, runtime — data-plane credential. Контракт должен
использовать разные env names (`XMEM_ADMIN_API_KEY` и `XMEM_API_KEY`) и разные keys, если xmemory
реально позволяет ограничить permissions. Если account API key неизбежно даёт admin authority,
runtime v1 остаётся pilot-only; переименование одного и того же широкого key не создаёт изоляцию.
`XMEM_CLUSTER_ID` нужен только provisioning, `XMEM_INSTANCE_ID` — runtime.

На старте integration/pilot adapter должен прочитать live schema и проверить её совместимость с
committed schema. Это не выбор только между hash и shape: сравнение должно учитывать semantic
descriptions, enums, keys и relations, но допускать безопасную server normalization. Пилот сохраняет
round-trip `data_schema`, чтобы spec могла определить version marker, direction compatibility и
поведение при недоступной проверке. Несовместимость является `schema_mismatch`, а не поводом
автоматически мигрировать instance. Проверка перед каждым write устраняет drift, но дорога; проверка
только при создании adapter имеет TOCTOU-риск — частоту также фиксирует spec.

## Согласованность и retry

Text extraction не является безопасно идемпотентной. Официальный Temporal guide отдельно
предупреждает: повтор после потерянного ответа может нормализовать primary key иначе и создать
duplicate. Adapter делает одну автоматическую попытку; это не end-to-end at-most-once guarantee,
потому что workflow, человек или новый process могут повторно подать тот же lesson.

Timeout или сетевой разрыв во время `write` оставляет outcome неизвестным: commit мог состояться.
Adapter должен вернуть отдельную ошибку `write_outcome_unknown`, остановить pilot run и не делать
повтор. Последовательная очередь внутри одного process не защищает от concurrent writers из других
processes. До появления provider concurrency contract v1 требует один writer на disposable
instance; crash/restart и manual replay должны попадать в reconciliation report по
`source_attempt_id`.

Reads и health/schema checks не меняют memory state, поэтому временный `RATE_LIMITED` или
unavailable read можно повторять с ограниченным backoff и `Retry-After`, если общий timeout
workflow это допускает. Краткосрочный retry `QUOTA_EXCEEDED` не выполняется.

## Ошибки и наблюдаемость

Пустой ответ, unsupported method, неверный input, отсутствующий instance, quota и provider failure
должны оставаться различимыми. Adapter не возвращает `[]` при исключении SDK.

Минимальные категории для будущей spec:

- `unsupported_operation` и `unsupported_configuration`;
- `invalid_input`;
- `authentication` и `authorization`;
- `instance_not_found`;
- `rate_limited` и `quota_exceeded`;
- `unavailable`;
- `write_failed` и `write_outcome_unknown`;
- `protocol_error` и `schema_mismatch`.

Наружу выходят стабильный code, безопасное сообщение, `retryable` и при необходимости локальный
trace ID. Raw SDK message, response body, API key, полный lesson и query не сохраняются как cause и
не логируются. `console_url` полезен для ручной диагностики, но его публикация в benchmark output
требует отдельного решения: URL может раскрывать идентификаторы tenant/operation.

Unit port покрывает malformed/non-JSON response, redirect, abort, timeout, DNS/TLS, 408/5xx,
неизвестный code и SDK envelope drift. Opt-in Cloud test подтверждает только безопасно вызываемые
401/404 и happy path; 402/429/5xx проверяются по документированному provider contract и transport
fixtures, а не провоцируются расходованием quota или атакой на service.

## Credentials и локальная конфигурация

Runtime adapter читает секрет только из `XMEM_API_KEY` в `.env`; provisioning использует отдельный
`XMEM_ADMIN_API_KEY`, если permissions действительно различаются. `XMEM_INSTANCE_ID` — не секрет,
но хранится рядом для однозначной привязки. SDK поддерживает `XMEM_API_URL`; hosted v1 не принимает
произвольный URL, иначе ошибочная конфигурация способна отправить Bearer key на чужой host.

До spec владелец данных должен подтвердить, что в Cloud разрешено отправлять: полный reflection
lesson, source attempt ID, названия мест и visual cues. Изображение, координаты ground truth сверх
уже раскрытых в lesson, secrets и PII не отправляются. Нужны проверенные retention/deletion,
residency, provider logging/model-training terms, tenant isolation, rotation и revoke procedure.
Если эти gates не закрыты, pilot использует только синтетические или разрешённые disposable data.

В рабочем дереве обнаружен `.xmemrc.json`: файл имеет права `0600`, но сейчас не игнорируется git.
Он содержит credential CLI и не соответствует правилу проекта «секреты только в `.env`».
Реализация adapter не должна зависеть от этого файла; до любого коммита его нужно убрать из
репозитория либо явно исключить из git и перенести credential в разрешённое место.

## Риски

- **Legacy interface скрывает native semantics.** Один synthesized answer становится одним
  `Hint`; per-lesson provenance и строгий top-K теряются.
- **Качество зависит от schema.** Ошибка в descriptions меняет extraction и retrieval без
  изменения TypeScript adapter.
- **Cloud — единственная копия.** Без snapshots, export/import contract или replayable canonical
  log потеря instance необратима. Поэтому v1 не является production memory.
- **Write outcome может быть неизвестен.** Автоматический retry text extraction создаёт duplicate
  risk.
- **Стоимость и latency переменны.** Deep write может занимать минуты; reads и writes расходуют
  provider quota, а 402 и 429 имеют разную retry policy.
- **Access control ограничен.** Object-level RBAC в публичных материалах отмечен как coming soon;
  один API key не следует считать доказательством read-only/write-only или runtime/admin разделения.
- **Данные покидают локальную среду.** Lessons и queries обрабатываются hosted service; изображения
  adapter не передаёт.
- **Snapshot-dependent workflow несовместим.** Без раннего capability check ошибка проявится лишь
  в конце training при первом `snapshot()`.
- **SDK/API drift и vendor lock-in.** Версию `xmemory` нужно pin exact; обновление SDK или XMD меняет
  envelopes/extraction и требует повторного Cloud test.
- **Cross-environment mix-up.** Dev/pilot/prod используют разные instances, keys и quotas; startup
  проверяет ожидаемые instance metadata/schema до первой записи.

## Что проверить до spec

На frozen corpus из размеченных `LessonInput` провести отдельный live pilot. До запуска нужно
зафиксировать strata (positive, negative, comparison, ambiguous/incomplete), rubric для correct и
grounded extraction, expected recall evidence и порядок разбора спорных случаев.

- провалидировать candidate XMD и создать новый disposable instance временным spike script/CLI;
- прогнать `extract` без записи для happy-path, ambiguous, incomplete и negative lessons;
- проверить round-trip `source_attempt_id`, escaping, длины и попытки data/prompt injection;
- сравнить source-only и hybrid schema, число objects/relations и provenance;
- для optional cue/place сравнить false merge и duplicate rate у unkeyed/composite identity;
- измерить fast/deep extraction, число empty/partial extractions и latency;
- проверить synchronous read-after-write и форму ответа при пустом instance/нет совпадений;
- сравнить `single-answer`, `xresponse` и `raw-tables` на frozen queries;
- измерить, сохраняет ли `single-answer` counter-signals и provenance без выдуманных фактов;
- измерить token/latency/quota отдельно по schema и read mode;
- проверить error normalization через fake port и безопасный opt-in Cloud happy/negative path.

Исследование не назначает произвольный общий порог. ADR до пилота фиксирует допустимые error rates
по каждому stratum, максимальные p50/p95 latency и token cost, а также zero-tolerance классы:
groundless claims, leakage секретов/PII и смешение разных `source_attempt_id`. Итог пилота публикует
числители и знаменатели, а не только агрегированный процент.

## Открытые вопросы

- **Recall contract:** на frozen queries сравнить три read modes по provenance, determinism, tokens
  и quality; ADR выбирает explicit incompatibility, provider-native redesign или no-go.
- **Empty features:** product owner выбирает между `[]`, unsupported error и configured prior после
  сравнения того, как каждый вариант влияет на baseline interpretation.
- **Schema identity:** extract pilot измеряет round-trip source ID, false merges и duplicates;
  только после этого spec фиксирует source-only либо hybrid XMD и keys каждого object.
- **Schema drift:** сохранить server-normalized schema и проверить изменения descriptions/enums;
  spec определяет version marker, compatibility direction и частоту runtime check.
- **Credentials:** создать отдельные admin/runtime/read-only keys в console и документировать
  доступные операции. Если ограничения не работают, v1 остаётся disposable pilot-only.
- **Latency/cost:** до пилота ADR задаёт p50/p95 и token budgets; результат выбирает fast/deep и
  sync/async path.
- **Data governance:** владелец подтверждает разрешённые поля, retention, residency, deletion,
  logging/training terms, rotation и incident response до первого реального lesson.
- **Recovery:** либо явно принять disposable loss, либо отдельным решением определить canonical
  lesson log, deterministic replay/reconciliation или export/import before production.
- **Capability gate:** spec называет конкретный composition point, где `snapshots: true`
  отклоняется до создания SDK client и первого model/provider call.

Поддержка snapshot/restore не является открытым вопросом v1: она явно отложена.

## Следующий шаг

Сначала принять ADR с pilot protocol и допустимыми вариантами `Memory` compatibility, затем
выполнить disposable extraction/read spike. По его результатам обновить ADR и написать spec. Spec
должна дословно определить XMD YAML, provisioning/re-run contract, credential separation, env,
adapter/port interfaces, query/envelope templates, empty-result protocol, schema compatibility,
errors, tests, data gates и capability check. Только после этого реализовываются adapter и schema.

## Термины

- `Hint` — текущая пара `{ lessonId, text }`, которую benchmark добавляет в prompt.
- `memory_ref` — внешняя opaque привязка к provider и instance, не snapshot и не item ID.
- `single-answer` — сгенерированный natural-language ответ xmemory; `xresponse` — objects/relations;
  `raw-tables` — значения строк без финального formatting pass.
- `global prior` — одинаковый контекст памяти при отсутствии observed features.
- `canonical copy` — независимый источник, из которого можно восстановить memory state.
- `capability gate` — ранняя проверка, запрещающая snapshot-dependent workflow для adapter v1.

## Источники

1. [TypeScript SDK](https://xmemory.ai/typescript/) — client/instance API, modes, types и errors.
2. [REST API](https://xmemory.ai/api/) — data-plane endpoints, response envelopes, quota и rate limits.
3. [XMD schema format](https://xmemory.ai/xmd/) — objects, fields, primary keys, relations и extraction rules.
4. [How xmemory works](https://xmemory.ai/integration-overview/) — schema-grounded write/read loop.
5. [Temporal integration](https://xmemory.ai/temporal/) — at-most-once text writes, retry и timeout semantics.
6. [MCP guide](https://xmemory.ai/mcp/) — API-key binding и отличие runtime data plane от admin plane.
7. [xmemory TypeScript client repository](https://github.com/xmemory-ai/xmemory-npm) — source и published declarations.
8. [xmemory на npm](https://www.npmjs.com/package/xmemory) — текущая опубликованная версия.
9. [Pricing & Deployment](https://xmemory.ai/pricing-deployment/) — quota, deployment и access-control status.
