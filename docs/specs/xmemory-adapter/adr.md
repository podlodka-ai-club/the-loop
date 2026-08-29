---
type: Decision
title: "xmemory-адаптер v1 с синтезированным recall и управляемой XMD-схемой"
description: "Первая версия проецирует single-answer xmemory в один Hint, хранит XMD-схему в репозитории и работает только с disposable pilot instance без snapshot и restore."
timestamp: 2026-08-29T00:00:00+03:00
date: 2026-08-28
model: gpt-5
tags: [loci, memory, xmemory, cloud, xmd, typescript, adapter, decision]
---

# xmemory-адаптер v1 с синтезированным recall и управляемой XMD-схемой

**Status:** Accepted
**Date:** 2026-08-28
**Authors:** Loci
**Related ADRs:** [Mem0-адаптер v1 без snapshot и restore](../mem0-adapter/adr.md)

---

## Context

Loci нужна реализация текущего интерфейса `Memory` поверх xmemory Cloud с API key. Интерфейс
возвращает ранжированный массив `Hint[]`, тогда как xmemory нативно отвечает одним синтезированным
или структурированным результатом без публичного `topK`, score и общего ID найденного lesson.
Полной семантической совместимости между этими моделями нет.

xmemory также требует предметную XMD-схему: она одновременно определяет хранилище и правила
извлечения знаний из lesson. Схема поэтому является частью функции, а не ручной настройкой вне
репозитория. Исследование вариантов и рисков находится в [research.md](research.md).

Публичный data plane не предоставляет snapshot/restore. Без независимого rebuild path Cloud
остаётся единственной копией извлечённых знаний, поэтому первая версия допустима только для
одноразового пилота и не является production memory.

До запуска пилота frozen corpus фиксирует для каждого lesson ожидаемый source ID, допустимые
grounded insights и ожидаемый recall answer. Разметка создаётся до Cloud-вызовов; спорные случаи
разбираются до расчёта метрик, чтобы provider output не менял критерий успеха задним числом.

## Options considered

**1. Один synthesized `Hint` и минимальная hybrid schema** — сохраняет нативный смысл xmemory read
и быстро проверяет пользу schema-grounded memory; принимает, что `Hint` становится проекцией ответа,
а не отдельным сохранённым lesson.

**2. Schema-specific `raw-tables` как массив `Hint[]`** — лучше сохраняет source IDs и формальный
limit, но жёстко связывает adapter со схемой и generated SQL, не получая гарантированного relevance
ranking от provider.

**3. Сначала заменить `Memory` provider-native интерфейсом** — честно передаёт synthesized answers,
objects и relations, но расширяет задачу до переработки benchmark и всех memory backends.

**4. Не реализовывать xmemory до появления native ranked lessons или snapshots** — сохраняет
строгую семантику текущего интерфейса, но блокирует проверку xmemory и не даёт данных для следующего
решения.

**5. Богатая provider-managed schema с автоматическими миграциями** — быстрее наращивает cues,
places и relations, но делает extraction непредсказуемой между запусками и даёт runtime право
изменять единственную Cloud-копию данных.

## Decision

Реализовать pilot-only xmemory Cloud adapter через закреплённую версию официального TypeScript SDK.
`remember` использует schema-aware text write, а `recall` запрашивает `single-answer` и проецирует
непустой ответ в один `Hint`. При пустых features используется отдельный фиксированный global-prior
query. Эта проекция считается явной несовместимостью с per-lesson ranked recall, а не полной
реализацией его семантики.

XMD v1 хранится и рецензируется в репозитории. Первая схема содержит `TrainingExperience` со
стабильным source attempt ID и source-specific `Insight`, связанный с породившим его опытом.
Нормализованные `VisualCue` и `Place` не входят в v1: их identity и merge требуют отдельного пилота.
Поля XMD явно фиксируют `enum: null` и `default: null`, которые Cloud v1 материализует при
round-trip схемы. Эти значения входят в repo-owned canonical hash; runtime не удаляет provider
defaults и не ослабляет exact comparison.
Синхронный write также материализует `created_keyless_objects` для schema objects без primary key;
adapter валидирует этот provider field и объединяет его элементы с публичным `created.objects`, не
расширяя общий `Memory`-контракт provider-specific структурой.
Cloud read возвращает provider-generated `trace_id`, а не гарантированный echo клиентского UUID.
Adapter валидирует provider trace как metadata, но использует собственный UUID в synthetic
`lessonId`, чтобы публичная корреляция не зависела от поведения Cloud.

Instance создаётся явным provisioning-шагом, а runtime проверяет совместимость live schema и не
создаёт миграции. Provisioning и runtime получают раздельные конфигурации credentials; если Cloud
не позволяет реально ограничить полномочия keys, это принимается только в disposable pilot.
Disposable означает отдельный instance для одного frozen pilot corpus: он не переиспользуется как
официальный evaluation baseline и не считается восстанавливаемым активом.

`snapshot` и `restore` возвращают различимые ошибки неподдерживаемой операции, не вызывают xmemory
и не меняют instance. Snapshot-зависимая конфигурация отклоняется до начала дорогой или изменяющей
состояние работы. Неизвестный исход write означает fail-fast без автоматического recovery; pilot
останавливается и instance выводится из повторного использования.

## Rationale

Один synthesized `Hint` — единственный ограниченный вариант, который сохраняет главную ценность
xmemory: schema-aware synthesis применимого знания. `raw-tables` внешне ближе к `Hint[]`, но его
порядок всё равно не является provider-guaranteed ranking и требует schema-specific parsing.
Переработка общего `Memory` архитектурно чище, но несоразмерна пилоту одного backend.
Полный отказ от реализации оставил бы главный вопрос — даёт ли schema-grounded synthesis прирост
геолокации — без данных и не позволил бы оценить цену общей переработки `Memory`.

Минимальная hybrid schema сохраняет provenance каждого episode и отдельно извлекает переносимый
вывод без преждевременной дедупликации cues и places. Repo-owned XMD и явный provisioning делают
эксперимент воспроизводимым, а запрет runtime migrations и production use ограничивает последствия
ошибок extraction, широкого API key и отсутствия recovery.

## Consequences

**Positive:**
- Можно проверить качество xmemory на реальных геолокационных lessons без изменения всех backends.
- Source experience и derived insight остаются связанными и проверяемыми.
- Схема проходит code review и одинаково создаётся для каждого disposable pilot.
- Ошибки Cloud не маскируются под успешное отсутствие памяти.

**Negative:**
- `recall` возвращает не ranked lessons, а один generated answer; `lessonId` отражает read operation,
  поэтому существующая диагностика per-lesson wins неприменима.
- Global-prior query добавляет generated контекст даже без observed features и может усложнить
  сравнение с Mem0/FileMemory.
- Без snapshot, canonical log и гарантированно ограниченного runtime key решение непригодно для
  production, повторного evaluation и восстановления после потери instance.
- Text extraction может давать duplicates, grounded-but-wrong structure и неизвестный исход после
  timeout; автоматический write retry запрещён.
- Cloud latency и token quota зависят от schema и read mode; пилот добавляет внешний расход, который
  может сделать backend непригодным даже при приемлемом качестве.

**Neutral:**
- Точный XMD YAML, envelope/query templates, schema check, timeouts, error codes и pilot harness
  определяются в spec.
- Добавление `VisualCue`/`Place`, provider-native `Memory` и recovery требует новых решений, а не
  скрытого расширения v1.
- В Cloud передаются только разрешённые lesson text и provenance; изображения не передаются.

## Success metrics

- На стратифицированных 30 lessons все 30 совпадают с заранее размеченным `sourceAttemptId` без
  cross-attempt merge; минимум 24 содержат один из заранее допустимых `Insight`, при нуле claims вне
  evidence lesson и утечек PII.
- На 30 frozen queries минимум 24 synthesized answers содержат заранее размеченный ожидаемый вывод;
  provider failure ни разу не превращается в успешный пустой `recall`.
- На пилотной выборке p95 синхронного `remember` не превышает 180 секунд, а p95 `recall` — 60 секунд;
  полный прогон 30 lessons и 30 queries расходует не более 10 000 xmemory tokens.
- Snapshot-required config завершается fail-fast до пилота; `snapshot` и `restore` возвращают
  различимые unsupported errors и не изменяют Cloud state.
