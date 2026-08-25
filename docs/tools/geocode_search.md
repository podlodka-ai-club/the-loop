---
type: Tool Contract
title: geocode_search
description: Поиск географического объекта по названию или адресу.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, geocoding, tools, agent-tools, contract]
---

# `geocode_search`

## Назначение

Инструмент передаёт текст геокодеру и возвращает наиболее подходящие объекты. Он вызывается только
после того, как агент уже сформировал название места или адрес. Визуальное описание фотографии не
является запросом к геокодеру.

## Вход

```text
geocode_search
  query  string, required
  limit  integer, optional, default: 5
```

Страну или регион при необходимости включают прямо в `query`, например `Springfield, Illinois,
United States`.

## Выход

```text
geocode_search_result
  results[]
    display_name
    latitude
    longitude
    type | null
```

`type` — необязательная строка провайдера вроде `city`, `state` или `house`; единая таксономия не
гарантируется. Координаты приводятся инструментом к числам WGS84. Для города, региона или страны
они обычно являются representative point, а не точным местом камеры.

Пустой `results` означает, что совпадение не найдено. Порядок результатов задаёт провайдер и не
является confidence Loci.

## Пример

### Запрос

```json
{
  "query": "Québec, Canada",
  "limit": 3
}
```

### Ответ

```json
{
  "results": [
    {
      "display_name": "Québec, Capitale-Nationale, Québec, Canada",
      "latitude": 46.8139,
      "longitude": -71.208,
      "type": "city"
    }
  ]
}
```

## Ошибки

| Код | Значение |
|---|---|
| `invalid_request` | `query` пуст или `limit` недопустим. |
| `rate_limited` | Провайдер отклонил запрос из-за лимита. |
| `unavailable` | Провайдер временно недоступен. |
| `timeout` | Вызов не завершился в срок. |

## Инварианты

- Инструмент ищет только текстовый топоним или адрес.
- Результат геокодера не доказывает связь места с фотографией.
- Инструмент не добавляет отсутствующие административные поля и не рассчитывает confidence.
