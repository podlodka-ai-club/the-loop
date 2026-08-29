---
type: Research
title: "Mem0 Cloud как адаптер интерфейса Memory"
description: Исследование отображения Mem0 Platform API на remember и ranked recall при отложенной поддержке snapshot и restore.
timestamp: 2026-08-28T00:00:00+03:00
date: 2026-08-28
model: gpt-5
resource: https://docs.mem0.ai/api-reference/memory/add-memories
tags: [loci, memory, mem0, cloud, typescript, adapter, research]
---

# Mem0 Cloud как адаптер интерфейса Memory

## Цель

Определить границу первой реализации `Memory` поверх Mem0 Cloud. Адаптер использует Platform API с
ключом `MEM0_API_KEY`, поддерживает `remember` и ranked `recall`, а `snapshot` и `restore` в v1
явно не поддерживает. Продуктовые контракты [memory_store](/tools/memory_store.md) и
[memory_retrieve](/tools/memory_retrieve.md) этим исследованием не меняются.

## Принятые ограничения v1

- Backend — Mem0 Cloud, не локальная OSS-библиотека и не собственная база.
- Запись использует native extraction Mem0 (`infer: true`).
- Retrieval использует Platform v3 search по признакам, переданным в `recall(features, limit)`.
- `snapshot()` и `restore()` возвращают различимую ошибку неподдерживаемой операции. Эмуляция scope,
  export/re-import и локальная canonical copy не входят в v1.
- API key хранится только в `.env`; adapter не принимает и не логирует его как данные запроса.

## Проверенная поверхность Platform API

Проверено по официальной документации и опубликованным типам `mem0ai@3.1.7` на 2026-08-28.

| Операция | Фактическое поведение | Влияние на адаптер |
|---|---|---|
| Клиент | `MemoryClient` из `mem0ai`, авторизация API key | Нет локального Mem0 store или отдельного server process |
| `add` | Platform v3 ставит extraction в очередь и возвращает `event_id` со статусом `PENDING` | `remember()` не должен завершаться сразу после принятия запроса |
| Event | `GET /v1/event/{event_id}/` возвращает `PENDING`, `RUNNING`, `SUCCEEDED` или `FAILED` | Первые два статуса нетерминальные; adapter ждёт завершение или timeout |
| Extraction | V3 single-pass ADD-only: новые facts накапливаются, прежние не обновляются и не удаляются автоматически | Один lesson даёт 0..N facts; ручные CRUD не входят в `remember` |
| Scope при add | Нужен хотя бы один `userId`/`agentId`/`appId`/`runId` | Scope должен задаваться конфигурацией adapter instance |
| Scope при search | Идентификаторы передаются внутри `filters`; casing различается между wire API, документацией и версиями SDK | Форму filters нужно зафиксировать integration fixture для установленной версии |
| `search` | V3 комбинирует semantic, keyword/BM25 и entity signals; принимает `topK`, threshold и rerank | `limit`, threshold и rerank должны быть зафиксированы одной search policy |
| `getAll` | Результат постраничный | Для recall не нужен; станет важен только будущему snapshot/export |
| Snapshot/restore | Публичного backup/restore нет; export не предоставляет обратный import состояния | Полная реализация этих методов откладывается |

Есть version-specific риск: опубликованный TypeScript type `MemoryClient.add()` описывает ответ как
массив memories, а Platform v3 документирует pending event. В `MemoryClient` нет публичного метода
poll одного event. Поэтому реализация должна проверять runtime response и обращаться к event REST
endpoint отдельно, а не полагаться только на TypeScript declaration.

## Отображение интерфейса

| `Memory` | Mem0 Cloud v1 | Граница |
|---|---|---|
| `remember(lesson)` | `add()` с native extraction, configured scope и provenance metadata; затем ожидание event | Promise завершается только после `SUCCEEDED`; `FAILED` и timeout становятся ошибкой |
| `recall(features, limit)` | `search()` по query из features в том же scope с `topK = limit` | Пустой features, query, threshold, rerank и диапазон limit фиксируются в spec |
| `snapshot()` | Явная unsupported-operation error | Не вызывает Platform API и не меняет scope |
| `restore(id)` | Та же явная unsupported-operation error | Не проверяет и не создаёт scope |

`LessonInput.sourceAttemptId`, `triggers` и `region` следует передавать как namespaced metadata.
Один lesson может породить несколько facts, поэтому provider fact ID и provenance ID lesson —
разные сущности. Точное отображение `Hint.lessonId` фиксируется в spec, а не выводится из Mem0.

## Согласованность записи

Успешный HTTP-ответ `add` означает только принятие работы. Если `remember()` завершится на этом
этапе, следующий `recall()` может не увидеть lesson, а training log посчитает запись успешной.
Поэтому минимальная гарантия v1 — ждать event до `SUCCEEDED`, затем проверить видимость созданных
facts. Нулевой результат extraction считается успешным no-op и отдельно входит в quality metric.

`SUCCEEDED` не обязательно означает окончательное ранжирование: temporal enrichment может
завершиться позже. V1 должен проверить read-after-write visibility на pilot и либо отключить
дополнительное temporal/reranking поведение, либо ввести измеримый stabilization gate.

Timeout оставляет состояние неизвестным: операция могла завершиться после прекращения polling.
То же относится к timeout/reset самого `POST add` после принятия запроса, особенно если adapter не
успел получить `event_id`. Автоматический повтор способен создать дубликат, поэтому retry нельзя
считать безопасным без provider idempotency guarantee. V1 возвращает различимую ошибку, прекращает
run, карантинирует adapter instance и выводит pilot agent ID из использования; известный event ID
сохраняется в очищенной диагностике.

## Ошибки и наблюдаемость

Пустой результат поиска, неподдерживаемая операция, неверный input, timeout и недоступность Mem0 —
разные исходы. Adapter не должен превращать provider failure в успешный `[]`: иначе benchmark не
отличит отсутствие релевантной памяти от инфраструктурного сбоя.

Точный набор error classes/codes принадлежит spec. На уровне решения нужны как минимум категории:

- unsupported operation;
- invalid input/configuration;
- authentication/authorization;
- rate limit;
- quota exceeded;
- temporary unavailable;
- ingestion failed;
- ingestion outcome unknown after timeout.
- protocol/schema mismatch, неизвестный event status или event `404`.

## Риски

- **Данные уходят внешнему сервису.** Reflection lessons и metadata покидают локальную среду; scope
  и секреты должны исключать случайное смешение проектов. Клиент работает только server-side;
  `Authorization`, raw provider errors и полный event payload не попадают в логи. Нужны rotation и
  revoke API key на уровне Mem0 project.
- **Асинхронная видимость увеличивает latency.** Каждый `remember` включает extraction и polling;
  последовательный training может стать заметно медленнее.
- **Extraction prompt не специализирован под геолокацию.** Нужны custom instructions и frozen
  corpus, иначе lessons могут быть отброшены или переформулированы как сведения о пользователе.
- **Стоимость внешняя и переменная.** Platform usage и дополнительные model operations считаются
  отдельно от геолокационной модели.
- **Cloud — единственная копия извлечённых facts.** Без snapshots и local canonical copy удаление,
  retention или потеря Mem0 project необратимы. V1 принимает это только для одноразовых pilot data.
- **SDK и API расходятся.** Integration test должен проверять runtime envelope, filters и event
  lifecycle для закреплённой версии.
- **Текущий snapshot-зависимый workflow несовместим с v1.** Mem0 adapter можно запускать только в
  отдельном pilot/smoke-контуре либо после capability check в orchestration.

## Что проверить до spec

На frozen corpus из реальных `LessonInput` нужно проверить:

- какой message role и custom instructions сохраняют географические cue и региональный contrast;
- сколько lessons дают 0, 1 и N facts;
- сохраняется ли provenance metadata на каждом извлечённом fact;
- сколько длится event lifecycle и как часто возникают timeout/rate limit;
- попадает ли ожидаемый fact в top-5 на frozen query set;
- отличается ли provider failure от корректного пустого recall во всех наблюдаемых результатах.

Порог пилота на фиксированной выборке: из 30 размеченных lessons не менее 24 дают хотя бы один
корректный географический fact; среди всех извлечённых facts этой выборки нет сведений о
пользователе или утверждений без опоры на lesson; ожидаемый fact входит в top-5 минимум для 24 из
30 frozen queries. Эти числа оценивают только pilot corpus, а не гарантируют качество на генеральной
совокупности.

## Открытые вопросы

- Какая комбинация `userId`/`agentId`/`appId`/`runId` задаёт lifetime и изоляцию одного memory
  dataset Loci, включая cross-run recall и поведение незаданных entity fields?
- Как строится query из `features`, и что возвращает `recall` при пустом массиве?
- Какой timeout и polling policy допустимы по времени и стоимости training?
- Какие данные разрешено отправлять Mem0 Cloud помимо текста lesson и обязательного provenance?
- Где orchestration проверяет, что snapshot-зависимый workflow нельзя запустить с adapter v1?

Поддержка snapshot/restore не является открытым вопросом этой версии: она явно отложена и потребует
отдельного research/ADR.

## Следующий шаг

Провести extraction/retrieval prototype по указанным порогам, затем описать query, scope, polling,
errors и capability check в spec. Реализация snapshots остаётся отдельной будущей функцией.

## Источники

1. [Add Memories](https://docs.mem0.ai/api-reference/memory/add-memories) — async ADD-only pipeline, scope, metadata и pending event.
2. [Get Event](https://docs.mem0.ai/api-reference/events/get-event) — статусы и результат фоновой записи.
3. [Search Memory](https://docs.mem0.ai/core-concepts/memory-operations/search) — Platform filters, topK и response.
4. [Get Memories](https://docs.mem0.ai/api-reference/memory/get-memories) — pagination и фильтрация Platform.
5. [Platform v2 → v3](https://docs.mem0.ai/migration/platform-v2-to-v3) — изменения endpoint и async ingestion.
6. [mem0ai на npm](https://www.npmjs.com/package/mem0ai) — TypeScript package и опубликованная версия.
