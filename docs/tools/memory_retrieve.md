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

В dynamic feature-scoped agent flow `memory_ref` остаётся application context и не входит в tool
arguments. Канонический вход имеет вид:

```json
{
  "feature_key": "wooden_poles",
  "query": "wooden poles with two crossarms"
}
```

`feature_key` формируется observation-моделью, ограничивается активным ключом приложением и не
является фиксированным enum. Provider-native envelope ниже описывает legacy integration surface;
dynamic dispatcher нормализует его в bounded group с этим feature key.

Основной потребитель — [слепая геолокация](../workflows/locate.md).

## Вход

```text
memory_retrieve
  feature_key string, required  # dynamic feature-scoped agent tool
  query       string, required

legacy memory_retrieve
  memory_ref  string, required
  query       string, required
```

В dynamic flow `query` кратко описывает только один model-generated visual feature. Legacy provider
envelope может использовать более общий текстовый query. В обоих режимах query не содержит ground
truth, бинарное изображение или инструкции изменить память.

Параметры retrieval — например `topK`, token budget, reranking, memory types, graph traversal,
`recall` против `reflect` или режим ответа xmemory — задаются в provider-specific конфигурации
`memory_ref`, а не в общем tool input.

## Dynamic application result serialized to the model

```json
{
  "attempt_id": "train-v1:img-42",
  "feature_key": "wooden_poles",
  "status": "hits",
  "hits": [
    {
      "memory_hit_id": "train-v1:img-42/wooden_poles/8b4d",
      "provider_id": "lesson-0012",
      "text": "Two wooden crossarms are a useful regional separator.",
      "score": 2,
      "effect": "helped"
    }
  ],
  "failure": null
}
```

`no_hit` содержит пустой `hits` и `failure: null`; failure envelope содержит пустой `hits` и
ненулевой код failure. `memory_ref`, `attempt_id` и active memory instance добавляет приложение.

## Legacy provider output

```text
memory_retrieve_result
  memory_ref
  payload     # provider-defined JSON value, string или null
```

`payload` передаёт результат системы памяти без преобразования в общий список заметок. Он может
содержать найденные memories, synthesized answer, objects и relations, observations, source facts,
chunks, scores, metadata или другую нативную структуру провайдера.

Для dynamic agent output допустимы только статусы `hits`, `no_hit` и `failed`; failure codes включают
`invalid_tool_arguments`, `wrong_feature`, `missing_tool_call`, `multiple_tool_calls`,
`malformed_tool_json`, `memory_error`, `timeout`, `budget_exhausted` и `skipped`.

## Legacy пример

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

## Dynamic errors

| Код | Значение |
|---|---|
| `invalid_tool_arguments` | Dynamic tool input does not match the active feature and bounded query contract. |
| `wrong_feature` | Tool call names a feature different from the application-selected active key. |
| `missing_tool_call` | The model did not return the required single function call. |
| `multiple_tool_calls` | The model returned more than one function call for the feature turn. |
| `malformed_tool_json` | Function arguments are not valid JSON. |
| `memory_error` | Provider returned a malformed result or a non-timeout provider error. |
| `timeout` | Provider call timed out. |
| `budget_exhausted` | Attempt budget prevented another retrieval model call. |
| `skipped` | Application skipped retrieval without fabricating a hit. |

Dynamic failure remains in the feature group and is not converted into a fake empty lesson.

## Legacy provider errors

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
