---
type: Tool Contract
title: geocode_search
description: Контракт преобразования текстовой гипотезы о месте в кандидатов с координатами.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, geocoding, tools, agent-tools, contract]
---

# `geocode_search`

## Когда вызывается

Инструмент вызывается при формировании итоговой гипотезы, когда общий
[слепой решатель](/workflows/locate.md) уже получил из фотографии, user context и памяти название
страны, региона, населённого пункта, улицы или адреса. Он преобразует текстовый кандидат в
географический объект, но не определяет, какой кандидат соответствует фотографии.

## Вход

```text
geocode_search
  query           string, required
  country_hint    string, optional
  region_hint     string, optional
  limit           integer, optional, default: 5
```

`query` содержит топоним или адрес. Визуальное описание вроде «тропическая дорога с красной
почвой» не является допустимым запросом. `country_hint` и `region_hint` используются только для
разрешения неоднозначности уже сформированной гипотезы.

Пример:

```json
{
  "query": "Quebec City",
  "country_hint": "Canada",
  "region_hint": "Quebec",
  "limit": 5
}
```

## Выход

```text
geocode_search_result
  provider
  dataset_version
  candidates[]
    label
    coordinates
      latitude
      longitude
    bounding_box | null
      south
      west
      north
      east
    feature_type — country | region | locality | street | address | landmark | unknown
    country
    country_code
    region
    region_code
    locality
    precision  — country | region | locality | street | address | unknown
    reference  — string, opaque
```

Координаты и bounding box возвращаются в десятичных градусах WGS84. Координата broad-объекта может
быть технической representative point и не означает наиболее вероятное положение камеры. Порядок
кандидатов определяется геокодером и не является уверенностью Loci. Пустой массив означает, что
совпадение не найдено.

## Правила использования

- Агент сначала формирует географическую гипотезу и только потом вызывает геокодер.
- Допускается разрешить несколько заранее сформированных top-кандидатов в пределах tool budget.
- Несколько результатов рассматриваются как неоднозначность, а не как указание выбрать первый.
- Геокодер подтверждает существование места, но не связь места с фотографией.
- Ответ геокодера не повышает raw или calibrated geographic confidence без новых оснований связи
  фотографии с местом.
- `provider` и `dataset_version` должны соответствовать закреплённому solve config.
- Конфликт координат и административных полей обрабатывается явно и не маскируется как visual evidence.

## Ошибки

| Код | Значение | Действие агента |
|---|---|---|
| `invalid_request` | Запрос не содержит допустимого топонима или нарушает контракт. | Исправить запрос один раз. |
| `unavailable` | Геокодер временно недоступен. | Продолжить без нормализации; не выдумывать точность и отметить degraded reason. |
| `timeout` | Ответ не получен вовремя. | Продолжить без результата вызова в пределах текущего budget. |
