---
type: Tool Contract
title: geocode_reverse
description: Контракт нормализации координат в административные данные о местоположении.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, geocoding, tools, agent-tools, contract]
---

# `geocode_reverse`

## Когда вызывается

- В общем [слепом решателе](/workflows/locate.md) инструмент нормализует только координаты,
  выбранные самим агентом, до формирования answer snapshot.
- В процессе обучения до `ANSWERED` инструмент также нормализует только координаты агента.
  После `REVEALED` он может нормализовать истинные координаты для расчёта административных
  совпадений. Скрытые координаты не передаются инструменту до раскрытия.

## Вход

```text
geocode_reverse
  latitude    number, required, от -90 до 90
  longitude   number, required, от -180 до 180
```

## Выход

```text
geocode_reverse_result
  provider
  dataset_version
  location
    label
    coordinates
      latitude
      longitude
    location_kind  — land | water | disputed | unknown
    bounding_box | null
    country
    country_code
    region
    region_code
    locality
    precision  — country | region | locality | street | address | unknown
    reference  — string, opaque
```

`location` может быть `null` для удалённой или неизвестной геокодеру точки. Для воды или спорной
территории `country` может быть `null`. Административные названия и границы зависят от поставщика,
поэтому для сравнения предпочтительны стабильные `country_code` и `region_code`, когда они доступны.

## Правила использования

- В слепом решателе проверяется только согласованность выбранной агентом точки с заявленными административными полями.
- В процессе обучения до `ANSWERED` действует то же ограничение.
- После `REVEALED` результат используется для нормализации ground truth, а не для переписывания исходного ответа.
- Обратный геокодер не является свидетельством того, что фотография сделана в возвращённом месте.
- `provider` и `dataset_version` должны соответствовать закреплённому solve config.
- Несогласованность создаёт явный `geocoding_conflict`; она не исправляется молча.

## Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Координаты выходят за допустимый диапазон. | Исправить координаты. |
| `unavailable` | Геокодер временно недоступен. | Сохранить административные поля как неизвестные и отметить degraded reason. |
| `timeout` | Ответ не получен вовремя. | Продолжить без нормализации в пределах текущего budget. |
