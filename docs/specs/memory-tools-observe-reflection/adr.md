---
type: Decision
title: "Feature-scoped retrieval против доминирования широких признаков"
description: "Память запрашивается и ранжируется отдельно по каждому визуальному признаку, а reflection сохраняет отдельные feature-level lessons через tools."
timestamp: 2026-08-30T00:00:00+03:00
date: 2026-08-30
model: gpt-5
tags: [loci, memory, tools, observe, reflection, decision]
---

# Feature-scoped retrieval против доминирования широких признаков

**Status:** Accepted
**Date:** 2026-08-30
**Authors:** Loci
**Related ADRs:** [Mem0-адаптер](../mem0-adapter/adr.md), [Hindsight-адаптер](../hindsight-adapter/adr.md), [xmemory-адаптер](../xmemory-adapter/adr.md)

---

## Context

Сейчас память получает общий запрос по нескольким признакам, а затем выбирает общий top-K. В
файловом backend это пересечение токенов без обратной частоты и нормировки длины: широкие слова
вроде `road`, `flat` и `horizon` встречаются почти везде и вытесняют редкие признаки вроде
`dark tunnel` или `orange lighting`.

Отчёт [PR #10](https://github.com/podlodka-ai-club/the-loop/pull/10) показывает, что проблема не
в доставке памяти: `file top-5` и Mem0 дали сопоставимое поведение, а режим «положить всё» не
устраняет отсутствие нужного знания. Нужна другая единица retrieval, которая не заставляет редкий
cue конкурировать с широкими признаками в одном рейтинге.

Цель — разобрать изображение на признаки, запросить память отдельно по каждому признаку и передать
анализу результаты сгруппированными по исходному cue. После reveal reflection должна отдельно
разобрать каждую пару `feature + memory hit`, определить, помогла ли память, была ли нерелевантной
или ошибочной, и сохранить самостоятельный lesson для этого эпизода. Память должна быть доступна
агенту как tools, но ground truth и право записи должны появляться только после blind-ответа.

Решение ограничено текущим TypeScript-агентом, несколькими memory backends и benchmark, где важны
контроль стоимости, воспроизводимость и изоляция evaluation. Подробное исследование находится в
[research.md](research.md).

## Options considered

**1. Оставить общий global top-K** — один запрос и один рейтинг по всем lesson. Это дёшево и просто,
но сохраняет конкуренцию между признаками: частые широкие токены продолжают вытеснять редкие cues.

**2. Улучшить общий ranking** — добавить IDF/BM25, нормировку или веса редкости. Это сохраняет один
запрос и снижает перекос частот, но всё равно смешивает несопоставимые признаки и зависит от качества
общего скоринга каждого backend.

**3. Feature-scoped retrieval через tools** — приложение фиксирует признаки, агент вызывает
`memory_retrieve` отдельно для каждого, а анализ получает отдельные группы результатов. Это требует
больше вызовов и orchestration, зато редкий cue больше не проигрывает глобальный конкурс.

**4. Свободный tool-loop** — модель сама выбирает, какие признаки искать и когда остановиться. Это
наиболее гибко, но не гарантирует coverage и делает стоимость запуска непредсказуемой.

## Decision

Выбрать **bounded feature-scoped retrieval через гибридный tool-loop**. Приложение фиксирует список
признаков и планирует отдельный ограниченный retrieval для каждого eligible-признака; модель
формулирует query, вызывает `memory_retrieve`, а результат остаётся в группе этого признака. В v1
backend не возвращает полный store для каждого feature: в анализ передаются bounded-группы, а не
единый global top-K.

В v1 остаёмся на текущем API-вызове и добавляем к нему управляемый цикл tools, без миграции всего
агента на новый endpoint. `observe` сохраняет фиксированный реестр слотов: видимый слот участвует в
retrieval и reflection, `not_visible` только фиксируется и не вызывает память. После reveal
reflection запускается отдельно для каждого `feature + memory hit`, классифицирует эффект памяти
(`helped`, `irrelevant`, `misleading` или `insufficient`) и при grounded-выводе, включая отрицательный
counter-signal, делает один `memory_store` для одного episode-level lesson. `effect` и provenance
(`attempt`, `feature`, `memory_hit`) являются machine-readable частью lesson, а не только его prose.
Blind-фаза не получает `memory_store`.

Evaluation использует frozen read-only snapshot и никогда не пишет lessons. Memory-on и control
используют одну выборку, один набор закэшированных observations и явно выбранный cold/warm режим;
train исключает eval IDs и соседние sequence, а live store не является неявным baseline.

Для каждого видимого feature фиксируется ровно один логический retrieval outcome. Каждый возвращённый
memory hit создаёт отдельный episode и ровно один reflection outcome; каждый валидный reflection
outcome получает один `memory_store`, включая уроки о нерелевантной или misleading памяти. Если
reflection завершилась ошибкой или не смогла сформировать grounded вывод, запись не выполняется и
фиксируется failure. Если hits нет,
фиксируется no-hit outcome без pair-episode. Retry, timeout и повторная запись не создают второй
логический outcome. Точные схемы tool inputs/outputs, provider mapping и idempotency определяются в
следующем `spec.md`.

Решение распространяется на общий read-flow benchmark, training и production. `memory_store`
разрешён только training после reveal; evaluation и production read-only. Training memory и
production memory разделяются namespace или `memory_ref`, а promotion snapshot выполняется вручную.
Автоматическое обучение на пользовательских фотографиях и автоматическая публикация lessons в
production не входят в решение.

## Rationale

Отчёт PR #10 показывает, что простая замена backend не устраняет перекос: векторный поиск Mem0 и
пересечение токенов дают неразличимый результат. Улучшение global ranking уменьшило бы частотный
перекос, но не решило бы конкуренцию между разными типами признаков и не дало бы прозрачной связи
между cue и lesson.

Feature-scoped retrieval устраняет саму причину потери: широкий `road` может влиять на группу
дороги, но не получает очки за вытеснение специфичного `dark tunnel` в группе освещения. При этом
модель остаётся реальным tool-using агентом, а приложение контролирует coverage, безопасность и
бюджет.

Отдельный lesson на пару feature и memory hit лучше связывает опыт с будущим поиском и позволяет
измерять, какая подсказка помогла, не помогла или ввела в заблуждение. Разделение blind и post-reveal
фаз предотвращает утечку ground truth в solver и
сохраняет смысл benchmark. Frozen snapshot и ручное promotion нужны, чтобы новые tool-вызовы не
превратили evaluation или production в неявное продолжение обучения.

## Consequences

**Positive:**
- Появляется прозрачная связь `feature → memory query → memory hit → reflection verdict → lesson`.
- Агент действительно умеет читать и сохранять память через типизированные tools.
- Можно отдельно анализировать полезность признаков, конкретных memory hits и качество lessons, а не
  только общий geoscore.
- Фазы и лимиты остаются под контролем приложения, поэтому benchmark можно воспроизводить.

**Negative:**
- На одну фотографию добавляются retrieval-вызовы по числу видимых признаков и отдельные reflection
  и write-операции по числу memory hits; latency, токены и стоимость вырастут ещё сильнее.
- Tool-loop сложнее текущего одного solver-вызова: нужны coverage, валидация аргументов, retry,
  частичные ошибки и защита от повторной записи.
- Разные backends могут по-разному отвечать на один feature; provider-native payload придётся
  сохранять и безопасно проецировать в общий контекст агента.
- Ошибочный или инъекционный lesson может повлиять на много будущих попыток, поэтому нужны snapshots,
  provenance и возможность исключить плохую память; автоматической публикации training lessons в
  production не будет.
- Разделение retrieval по features может ослабить выводы, зависящие от комбинации признаков; такие
  cross-feature связи придётся собирать на этапе analyze, а не получать из одного общего ranking.

**Neutral:**
- В v1 реестр observe-слотов остаётся фиксированным; расширение vocabulary потребует версии ключей и
  отдельной проверки старых lessons.
- `memory_retrieve` не выбирает backend, а работает с memory context, закреплённым workflow.
- Отсутствие полезного lesson является нормальным reflection outcome и не считается ошибкой всего
  attempt; точные коды outcome и схема provenance определяются в spec.

## Success metrics
- На contract-тестах 100% видимых features получают ровно один bounded retrieval outcome, а 100%
  memory hits — ровно один reflection outcome; `memory_store` до reveal не вызывается ни разу.
- На фиксированном retrieval fixture редкие cues не теряются из-за global top-K: каждый eligible
  feature получает собственную bounded-группу, а редкие и широкие hit rates считаются раздельно.
- На пилоте из 30 изображений 100% валидных reflection outcomes получают отдельный store с
  machine-readable provenance; verdicts (`helped/irrelevant/misleading/insufficient`) и write failures
  считаются отдельно.
- На frozen pilot memory-on сравнивается с текущим global top-K/control по rare-cue hit rate, geoscore
  и `valid_output`; p95 времени обработки не превышает 2× текущего двухшагового flow.
