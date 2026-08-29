---
type: Decision
title: "Hindsight Cloud-адаптер v1 с native recall и без snapshot/restore"
description: "Первая версия использует Hindsight Cloud по API key, синхронный retain и native raw/mixed recall, а snapshot и restore явно откладывает."
timestamp: 2026-08-29T00:00:00+03:00
date: 2026-08-29
model: gpt-5
tags: [loci, memory, hindsight, cloud, typescript, adapter, decision]
---

# Hindsight Cloud-адаптер v1 с native recall и без snapshot/restore

**Status:** Accepted
**Date:** 2026-08-29
**Authors:** Loci
**Related ADRs:** [Mem0-адаптер](../mem0-adapter/adr.md), [xmemory-адаптер](../xmemory-adapter/adr.md)

---

## Context

Loci нужен адаптер текущего `Memory` поверх Hindsight Cloud по HTTPS с Bearer API key. Интерфейс
возвращает `Hint[]`, а Hindsight извлекает из одного lesson ноль или несколько фактов; его recall
ограничен token budget, а не count-based `limit`. Подробное сравнение находится в
[исследовании](research.md).

Hindsight sync `retain` завершает основной extraction pipeline, но observations консолидируются в
фоне. `reflect` возвращает один сгенерированный ответ и потому не сохраняет семантику ranked
lessons. Document-transfer export/import существует, но это асинхронный архив с новыми embeddings
и provider IDs, а не готовый checkpoint текущего `Memory`.

Первая версия должна быть disposable pilot с воспроизводимым входом и policy, но не с обещанием
побайтно одинакового изменяемого Cloud state. Cloud bank задаётся registry через `memory_ref`,
runtime использует только API key и data-plane операции, registry запрещает promotion pilot bank
в production, а snapshot-dependent evaluation не получает неподтверждённую замену состояния.

## Options considered

**1. Native raw/mixed recall и synchronous retain** — сохраняет Hindsight ranking и source facts,
быстро внедряется через публичный TypeScript client; цена — несколько fact hints на lesson,
локальный `limit` и eventual observations.

**2. Native recall и asynchronous retain с operation polling** — лучше контролирует потерянные
подтверждения благодаря caller-generated operation ID; требует собственного poller, deadline,
reconciliation и большей Cloud-интеграции.

**3. `Reflect` как один `Hint`** — даёт готовый связный ответ, но теряет per-fact provenance,
строгий top-K и добавляет непредсказуемость и стоимость дополнительного LLM-вызова.

**4. Document-transfer как snapshot/restore** — снижает риск потери Cloud bank, но требует archive
lifecycle, target bank, асинхронного импорта и отдельной семантики замены working state.

**5. Provider-native `Memory`** — честно передаёт модель Hindsight, но требует менять benchmark,
workflow и общий интерфейс для одного backend.

## Decision

Реализовать pilot-only Hindsight Cloud adapter через exact-pinned `@vectorize-io/hindsight-client`
`0.9.2`. Runtime читает единственный secret `HINDSIGHT_API_KEY`; Cloud API URL является константой,
а bank и credential binding приходят из resolved source, который registry строит из `memory_ref`.
Self-hosted deployment и runtime provisioning bank не входят в v1.

`remember` использует synchronous `retain`. Один `sourceAttemptId` означает один logical lesson;
его можно передать как `document_id` с namespaced metadata, чтобы сохранить provenance и replace
semantics. После неизвестного sync-исхода adapter не повторяет запись автоматически.

`recall` использует native ranked recall с raw facts и observations, включая `preferObservations`,
если observation уже заменила исходные facts. Непустые features объединяются в query; при пустом
массиве используется отдельный configured global-prior query. Каждый provider fact проецируется в
один `Hint` с собственной provider identity, затем массив ограничивается локальным `limit`.
Provider metadata, типы и evidence остаются диагностическими данными адаптера, а не частью
публичного `Hint`.

`reflect` не используется для текущего `Memory`. `snapshot` и `restore` в v1 возвращают явную
ошибку неподдерживаемой операции; factory отклоняет snapshot-required composition до создания
клиента и первого Cloud-вызова. Document-transfer остаётся будущей recovery capability с
отдельным ADR.

## Rationale

Вариант 1 лучше всего сохраняет полезную часть Hindsight — hybrid ranked retrieval, provider-side
fact identity и provenance — без изменения всех memory backends. Synchronous retain ограничивает объём
adapter-owned lifecycle и даёт завершённый основной write перед следующим training lesson; фоновые
observations остаются частью измеряемого поведения provider.

Async retain полезен при превышении training deadline, но для v1 добавляет существенную
интеграционную поверхность. `Reflect` и provider-native redesign либо скрывают несовместимость
`Hint[]`, либо расширяют задачу. Export/import принимается как recovery направление, но не как
ложный snapshot: он не заменяет текущий bank атомарно и меняет provider state.

## Consequences

**Positive:**

- Можно проверить Hindsight Cloud на реальных географических lessons без изменения общего
  `Memory`-контракта.
- Native ranking определяет порядок hints без дополнительного synthesized ответа и скрытой
  агрегации facts.
- API key и bank scope остаются явными, а runtime не получает control-plane authority.
- Ошибка Cloud, неизвестный write outcome и пустой recall остаются различимыми.

**Negative:**

- `Hint` представляет fact, а не исходный lesson; один lesson может дать несколько hints, а
  `limit` контролируется только после provider response.
- При пустых features global prior одинаков для всех фотографий и может ухудшить интерпретацию
  memory-on arm.
- Synchronous extraction добавляет latency; неизвестный write outcome нельзя безопасно повторить,
  а observations могут быть недоступны сразу.
- Без snapshot/restore адаптер непригоден для полного production workflow и точного повторного
  evaluation; Cloud остаётся внешней системой хранения и тарификации.
- Lessons, provenance metadata и retrieval queries передаются Hindsight Cloud; доступность, rate
  limits, quota и vendor lock-in остаются внешними рисками.

**Neutral:**

- Bank, retain mission, recall budget, query template, error normalization, deadlines и точный
  diagnostic payload конкретизируются в spec.
- `document_id = sourceAttemptId` допустим только при гарантии «одна попытка — один lesson»;
  reconciliation после timeout и export/import остаётся отдельной процедурой.
- Exact SDK upgrade требует повторного compile/runtime integration test.

## Success metrics

- На 30 стратифицированных lessons минимум 24 дают grounded geographic fact по заранее
  согласованной rubric (fact поддержан текстом lesson); все 30 сохраняют корректный
  `sourceAttemptId`/`document_id`, без cross-attempt merge, PII и claims вне lesson.
- На 30 frozen queries ожидаемый source document/evidence из manifest попадает в первые 5 adapter
  hints минимум в 24 случаях; ни один provider failure не превращается в успешный пустой recall.
- p95 synchronous `remember` по 30 sequential writes не превышает 180 секунд, p95 `recall` по 30
  queries — 60 секунд; frozen input, policy и empty-feature behavior совпадают между прогонами.
- Snapshot-required configuration завершается fail-fast до Cloud-вызова; `snapshot` и `restore`
  возвращают unsupported errors и не меняют bank state.
