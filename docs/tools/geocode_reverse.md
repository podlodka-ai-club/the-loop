---
type: Tool Contract
title: geocode_reverse
description: Получение ближайшего географического объекта и адресных компонентов по координатам.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, geocoding, tools, agent-tools, contract]
---

# `geocode_reverse`

## Назначение

Инструмент передаёт координаты reverse-geocoder и возвращает ближайший индексированный объект. Он
помогает проверить название страны, региона и населённого пункта для уже выбранной агентом точки.

Reverse-geocoder не доказывает, что фотография сделана в этой точке.

## Вход

```text
geocode_reverse
  latitude   number, required, от -90 до 90
  longitude  number, required, от -180 до 180
```

## Выход

```text
geocode_reverse_result
  result | null
    display_name
    latitude
    longitude
    type | null
    address | null
      country | null
      country_code | null
      region | null
      locality | null
```

Провайдер может вернуть не исходную координату, а координату или центр ближайшего найденного
объекта. Поэтому `result.latitude` и `result.longitude` не заменяют выбранную агентом точку.

Address components зависят от покрытия и провайдера. Отсутствующие значения остаются `null`;
инструмент их не угадывает. `result: null` означает, что подходящий объект не найден.

## Пример

### Запрос

```json
{
  "latitude": 46.8139,
  "longitude": -71.208
}
```

### Ответ

```json
{
  "result": {
    "display_name": "Québec, Capitale-Nationale, Québec, Canada",
    "latitude": 46.8139,
    "longitude": -71.208,
    "type": "city",
    "address": {
      "country": "Canada",
      "country_code": "CA",
      "region": "Québec",
      "locality": "Québec"
    }
  }
}
```

## Ошибки

| Код | Значение |
|---|---|
| `invalid_request` | Координаты выходят за допустимый диапазон. |
| `rate_limited` | Провайдер отклонил запрос из-за лимита. |
| `unavailable` | Провайдер временно недоступен. |
| `timeout` | Вызов не завершился в срок. |

## Инварианты

- Инструмент возвращает ближайший объект, а не гарантированно точный адрес координаты.
- Ответ не изменяет исходные координаты агента.
- Отсутствующие address components не восстанавливаются предположением.
- Инструмент не рассчитывает confidence.
