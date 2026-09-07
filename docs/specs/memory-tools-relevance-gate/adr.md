---
type: Decision
title: "Relevance gate и гигиена lessons для feature-scoped памяти"
description: Приложение фильтрует recall по verdict, feature key и релевантности, проверяет содержимое lessons при записи и передаёт analyze только правило, регион и effect.
timestamp: 2026-09-05T00:00:00+03:00
date: 2026-09-05
model: claude-fable-5-1
tags: [loci, memory, retrieval, reflection, decision]
---

# Relevance gate и гигиена lessons для feature-scoped памяти

**Status:** Accepted
**Date:** 2026-09-05
**Authors:** Loci
**Related ADRs:** [Feature-scoped retrieval](/specs/memory-tools-observe-reflection/adr.md), [Dynamic features](/specs/memory-tools-observe-dynamic-features/adr.md), [Единые prompts](/specs/memory-tools-observe-common-memory-prompts/adr.md)

## Context

Первый прогон feature-scoped памяти на Hindsight (train 30 кадров, eval 180 кадров, PR #11) показал,
что память ухудшает ответ. Кадры без hits дали медиану 577 км, кадры с hits — 1000–1200 км. Причины
измеримы:

- 78% отданных hits несли verdict `irrelevant`, 0.8% — `helped`. Reflection обязана сохранить один
  lesson на каждый episode, и 27 кадров породили 764 lessons, почти все отрицательные.
- 66% текстов hits описывали эпизод («cue did not provide diagnostic information»), 52% называли
  страну чужого эпизода. Truth одного attempt утекала в следующий через prose lesson.
- 54% ошибочных ответов (>750 км) называли страну, которая встречалась в тексте hits кадра.
- Recall провайдера — глобальный semantic search. `featureKey` записывался в metadata, но не
  участвовал в отборе: lesson про `surface` отвечал на запрос про `lighting`.
- `score` у всех hits был `null`, top-5 брался безусловно, пустой результат не был допустимым
  исходом. Среднее — 26 hits на кадр.
- Analyze получал сырой JSON групп: полный текст lesson, `providerId`, `memoryHitId`, `effect` без
  объяснения семантики.

ADR о feature-scoped retrieval требует хранить counter-signals. Это требование остаётся, но хранение
и выдача — разные операции.

Второй прогон (xmemory, train 50 кадров, eval 50 кадров, парное сравнение warm/cold) после гейта и
гигиены показал нейтральный результат: 7 кадров лучше, 13 хуже, 25 без изменений. Проигрыши —
дрейф к странам train-корпуса: правила вида «<cue> is typical of this region» с verdict `helped`
получали тег страны и тянули ответ к ней независимо от кадра. `insufficient` и `misleading`
добавляли тег страны, не добавляя признака.

## Options considered

**1. Оставить как есть и увеличить train-корпус** — доля `irrelevant` не зависит от размера корпуса,
   а утечка стран через prose остаётся.

**2. Убрать запись отрицательных verdicts** — противоречит принятому ADR и лишает reflection
   статистики о том, какие lessons мешают.

**3. Фильтровать на выдаче и валидировать на записи** — хранить все verdicts, но отдавать analyze
   только правила, прошедшие verdict-, feature- и relevance-гейт; на записи не принимать narrative и
   чужую географию в prose.

## Decision

Выбрать вариант 3. Изменения живут в приложении и одинаковы для всех адаптеров.

**Retrieve.** Dispatcher запрашивает у провайдера в четыре раза больше кандидатов, чем отдаёт
(`RECALL_FETCH_MULTIPLIER`, не более 20), затем применяет гейт в `src/memory/relevance.ts`:

1. Verdict: выдаются только `helped` и lessons без verdict. `irrelevant`, `insufficient` и
   `misleading` хранятся для статистики, но analyze не получают.
2. Feature: lesson с `featureKey`, отличным от активного признака, не выдаётся. Lessons без
   `featureKey` проходят.
3. Relevance: если провайдер вернул `score`, он должен быть не ниже `MEMORY_MIN_SCORE` (по умолчанию
   0.5). Без score lesson должен делить с query хотя бы один содержательный токен: по `triggers`,
   а без triggers — по тексту.
4. Дубликаты по тексту не выдаются; выдача ограничена `recallLimit`, по умолчанию 2 на признак.

Пустая выдача — валидный `no_hit`. Счётчики отброшенного пишутся в группу как `gate`.

**Store.** После schema-валидации dispatcher применяет `src/lesson-hygiene.ts`:

- Для `irrelevant` content заменяется канонической формой из triggers без географии.
- Для остальных verdicts content не должен описывать эпизод (memory, hit, lesson, retrieval, blind
  guess, this image) и не должен называть страну, территорию или демоним вне поля `region`. Список
  имён строится из `Intl.DisplayNames` и короткого списка alias/демонимов.
- Нарушение — `invalid_tool_arguments`, episode получает `reflection_failed`.

- `helped` без контраста понижается до `insufficient`: content обязан назвать, как cue выглядит
  здесь и как выглядит ближайшая альтернатива («..., not ...», «unlike ...», «rather than ...»).
  Правило без контраста — гипотеза, а не свидетельство; episode и метрики несут сохранённый verdict.

Prompt рефлексии (`reflect-v3`) делает `insufficient` verdict по умолчанию для общего cue и
требует для `helped` контраст с альтернативой, описанной по виду, а не по месту.

**Analyze.** Группы проецируются в `{feature.key, status, failure, hits[{region, lesson, effect}]}`.
Префиксы `XX:` и `[effect=…]` снимаются, `providerId` и `memoryHitId` не передаются. Общий объём
текста lessons ограничен `ANALYZE_MEMORY_CHAR_BUDGET` (3000 символов). Prompt analyze (`analyze-v3`)
объясняет, что правило — свидетельство только там, где виден его cue, а не его контраст.

**Адаптеры.** `Hint` получает опциональные `region`, `triggers` и `score`. File и Mem0 заполняют
region и triggers из lesson и metadata, Mem0 дополнительно score. Hindsight заполняет region и
triggers; его `scores` — карта по стратегиям без документированной шкалы, поэтому score не
передаётся и работает overlap-гейт. xmemory возвращает один синтезированный ответ без полей.

## Rationale

Гейт устраняет измеренный шум там, где он входит в prompt, и не зависит от провайдера. Гигиена
закрывает канал утечки truth между attempts, не отменяя хранение отрицательных verdicts. Минимальная
проекция убирает из analyze всё, на что blind attempt не имеет права опираться.

## Consequences

**Positive:**
- Analyze видит не более двух правил на признак, только `helped` с контрастом и без чужих стран.
- Feature scoping выполняется приложением, а не доверяется провайдеру.
- Пустая выдача — штатный исход, а не отсутствие top-K.

**Negative:**
- Overlap-гейт по токенам груб: синонимы (`pole`/`post`) не совпадают, и полезный lesson может быть
  отброшен. Score провайдера, где он есть, имеет приоритет.
- Словарь стран не покрывает все демонимы и субнациональные названия; prompt остаётся вторым
  барьером.
- Rejected content означает потерянный episode; доля `reflection_failed` должна отслеживаться.
- Понижение `helped` без контраста уменьшает число выдаваемых правил; bank из 50 кадров может
  отдавать почти пустые группы, и польза памяти проявится только на большем корпусе.

**Risks:**
- Порог `MEMORY_MIN_SCORE` задан для cosine-шкалы Mem0 и не проверен на других провайдерах.
- Прежние bank'и содержат narrative lessons; гигиена действует только на новые записи, поэтому
  bank надо создать заново перед сравнением.

## Success metrics

- Разрыв «0 hits против hits» по медиане расстояния стремится к нулю.
- Доля ошибочных ответов, называющих страну из текстов hits, падает с 54%.
- Доля `helped` среди выданных hits выше доли шума.
- Warm-прогон не хуже cold-прогона на том же провайдере и подмножестве.
