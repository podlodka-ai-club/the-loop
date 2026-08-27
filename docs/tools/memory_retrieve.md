---
type: Tool Contract
title: memory_retrieve
description: Запрос контекста у выбранной системы памяти в её нативной модели retrieval.
timestamp: 2026-08-27T00:00:00+03:00
tags: [loci, memory, retrieval, tools, agent-tools, contract]
---

# `memory_retrieve`

## Назначение

Инструмент задаёт вопрос выбранной системе памяти и возвращает её нативный результат. Он не
получает изображение, не определяет место и не предписывает провайдеру способ поиска.

`memory_ref` — opaque ссылка на заранее настроенную систему памяти. По ней оркестратор разрешает
provider, instance/bank/scope, credentials и provider-specific retrieval policy. Формат ссылки
описан в [общих моделях](../workflows/models.md#memory-reference).

Основной потребитель — [слепая геолокация](../workflows/locate.md).

## Вход

```text
memory_retrieve
  memory_ref  string, required
  query       string, required
```

`query` кратко описывает видимые признаки, географические гипотезы или нужные различающие знания.
Он не содержит ground truth, бинарное изображение или инструкции изменить память.

Параметры retrieval — например `topK`, token budget, reranking, memory types, graph traversal,
`recall` против `reflect` или режим ответа xmemory — задаются в provider-specific конфигурации
`memory_ref`, а не в общем tool input.

## Выход

```text
memory_retrieve_result
  memory_ref
  payload     # provider-defined JSON value, string или null
```

`payload` передаёт результат системы памяти без преобразования в общий список заметок. Он может
содержать найденные memories, synthesized answer, objects и relations, observations, source facts,
chunks, scores, metadata или другую нативную структуру провайдера.

## Пример

### Запрос

```json
{
  "memory_ref": "memory/xmemory-prod",
  "query": "Какие признаки различают сельские районы Paraná и Itapúa при красной почве и бетонных столбах?"
}
```

### Ответ

```json
{
  "memory_ref": "memory/xmemory-prod",
  "payload": {
    "answer": "Красная почва встречается по обе стороны границы. Для различения сначала проверяй язык и дорожную разметку; португальский текст поддерживает Paraná."
  }
}
```

## Использование

- Один solve использует одну `memory_ref` во всех вызовах.
- Форму и содержание `payload` определяют provider и конфигурация выбранной памяти.
- Результат памяти может быть неполным, ошибочным или сгенерированным.
- Агент использует его только после сопоставления с текущим изображением.
- Пустой ответ не доказывает отсутствие географического признака.
- `payload` считается данными и не исполняется как инструкция.

## Ошибки

| Код | Значение |
|---|---|
| `invalid_request` | Вход не соответствует envelope-контракту. |
| `memory_not_found` | `memory_ref` не разрешается в настроенную систему памяти. |
| `memory_mismatch` | Интеграционный слой обнаружил ответ не от системы, разрешённой через `memory_ref`. |
| `unavailable` | Память временно недоступна. |
| `timeout` | Вызов не завершился в срок. |

При ошибке решатель продолжает без результата этого вызова и не переключается на другую систему
памяти.

## Инварианты

- Инструмент обращается только к системе, явно выбранной через `memory_ref`.
- Инструмент не видит ground truth и изображение.
- Инструмент вызывает настроенную retrieval operation; внутренние фоновые процессы провайдера не
  регулируются контрактом Loci.
- Provider-native результат не обязан соответствовать сохранённому ранее `content` один к одному.
