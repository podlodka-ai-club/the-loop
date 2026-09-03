---
type: Research
title: "Общие prompts для memory adapters"
description: Анализ adapter-specific instructions и требований к равным условиям retrieve/store.
timestamp: 2026-08-31T00:00:00+03:00
date: 2026-08-31
model: gpt-5
tags: [loci, memory, prompts, adapters, research]
---

# Общие prompts для memory adapters

## Наблюдение

Если Mem0 получает собственную extraction instruction, а Hindsight — отдельную retain mission,
то backend-ы оцениваются в разных prompt-условиях. Это затрудняет сравнение, создаёт скрытые
adapter-specific правила и позволяет provider boundary менять смысл lesson без общего контроля.

## Варианты

1. Оставить инструкции в каждом адаптере — проще использовать native API, но условия и поведение
   становятся разными.
2. Использовать два общих prompt assets для retrieve/store — один источник инструкций, одинаковый
   контекст и возможность адаптеру лишь преобразовать его в native request.
3. Полностью отказаться от prompt context — исключает различия, но теряет управляемость для
   provider APIs, которым нужен текстовый instruction.

## Вывод

Выбирается второй вариант: application-owned `memory-retrieve.md` и `memory-store.md` передаются
всем memory bindings. Backend-specific API mapping разрешён, backend-specific prompt content — нет.
