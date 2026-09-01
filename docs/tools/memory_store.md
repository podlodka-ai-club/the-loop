---
type: Tool Contract
title: memory_store
description: Передача обучающего опыта в выбранную систему памяти после раскрытия правильного места.
timestamp: 2026-08-27T00:00:00+03:00
tags: [loci, memory, learning, tools, agent-tools, contract]
---

# `memory_store`

## Назначение

Инструмент передаёт обучающий опыт в выбранную систему памяти. Он вызывается только в
[обучении](../workflows/train.md) после reveal ground truth.

`memory_ref` — opaque ссылка на заранее настроенную систему памяти. По ней оркестратор разрешает
provider, instance/bank/scope, credentials и provider-specific write policy. Формат ссылки описан
в [общих моделях](../workflows/models.md#memory-reference).

В dynamic feature-scoped post-reveal flow `memory_ref` остаётся application context и не входит в
tool arguments. Канонический вход агента:

```json
{
  "feature_key": "road_markings",
  "memory_hit_id": "attempt-42/road_markings/3",
  "effect": "misleading",
  "content": "A single yellow centre line was visible, but this rule was too broad.",
  "triggers": ["single yellow centre line", "rural road"],
  "region": "BR"
}
```

Provider-native `memory_ref + content` envelope ниже остаётся legacy integration surface; dynamic
dispatcher добавляет machine-readable provenance and typed write outcome before adapter access.

Инструмент не предписывает провайдеру внутреннюю модель хранения. Система памяти может извлекать
факты, создавать связи и observations, объединять новое знание с существующим или выполнять
другие нативные операции.

## Вход

```text
memory_store
  feature_key    string, required  # dynamic feature-scoped agent tool
  memory_hit_id  string | null, required
  effect         string, required
  content        string, required
  triggers       string[], required
  region         string, required

legacy memory_store
  memory_ref  string, required
  content     string, required  # произвольная UTF-8 проза; предпочтительно Markdown
```

В dynamic agent flow `content` формирует агент рефлексии как самостоятельное текстовое описание
одного эпизода. Для `no_hit` агент получает и возвращает `memory_hit_id: null`; это означает, что
lesson относится к влиянию признака без найденного memory hit. Dispatcher проверяет strict schema:
feature key и hit ID/null, один из четырёх effects,
content 1–2,000 символов и не более двух предложений, 1–8 bounded triggers и двухбуквенный uppercase
region. В legacy provider envelope ниже остаётся только проверка непустого content на native boundary.

### Желаемая структура Markdown

Промпт рефлексии по возможности раскрывает:

- наблюдаемые признаки фотографии;
- слепой ответ и существенные альтернативы;
- правильное место после reveal;
- разбор успеха или ошибки;
- переносимый опыт для будущей геолокации.

Это мягкая структура, а не schema. Агент может менять порядок, объединять и пропускать разделы,
добавлять важный контекст и писать связной прозой. Заголовки Markdown желательны, когда улучшают
читаемость, но инструмент не валидирует их наличие.

`content` не включает изображение, скрытый chain-of-thought или инструкции провайдеру о том, какие
внутренние memory objects он обязан создать.

## Dynamic application result serialized to the model

```json
{
  "status": "stored",
  "lesson_id": "lesson-0012",
  "failure": null
}
```

Повторная запись с тем же application-owned idempotency key возвращает `status: "already_stored"`
и существующий `lesson_id`. Proven rejection и неизвестный outcome возвращаются отдельно.

## Legacy provider output

```text
memory_store_result
  memory_ref
  payload     # provider-defined JSON value, string или null
```

`payload` передаёт нативный ответ провайдера без общей модели IDs, created records или версии
состояния. Для асинхронной системы успешный ответ может означать принятие работы, а не завершение
фоновой extraction или consolidation.

## Legacy пример

### Запрос

```json
{
  "memory_ref": "memory/xmemory-prod",
  "content": "# Наблюдение\n\nСельская дорога с красной почвой, бетонными столбами и фрагментом португальского текста.\n\n# Слепой ответ\n\nОсновной вариант — Itapúa, Paraguay; альтернатива — Paraná, Brazil.\n\n# Правильное место\n\nParaná, Brazil.\n\n# Разбор\n\nКрасная почва встречается по обе стороны границы. Даже неполный португальский текст был более сильным свидетельством в пользу Brazil.\n\n# Переносимый опыт\n\nПри различении юга Brazil и востока Paraguay сначала проверяй язык и дорожную разметку, а цвет почвы используй только в сочетании с другими признаками."
}
```

### Ответ

```json
{
  "memory_ref": "memory/xmemory-prod",
  "payload": {
    "write_id": "provider-write-42"
  }
}
```

## Dynamic errors

| Код | Значение |
|---|---|
| `reflection_failed` | Reflection tool call отсутствует, повторён, невалиден или не соответствует active episode. |
| `write_failed` | Провайдер доказанно отклонил запись. |
| `write_outcome_unknown` | Acceptance/completion записи доказать нельзя; повторная запись для этого episode не выполняется. |

## Legacy provider errors

| Код | Значение |
|---|---|
| `reflection_failed` | Reflection tool call отсутствует, повторён, невалиден или не соответствует active episode. |
| `write_failed` | Провайдер доказанно отклонил запись. |
| `write_outcome_unknown` | Acceptance/completion записи доказать нельзя; повторная запись для этого episode не выполняется. |
| `invalid_request` | Вход не соответствует envelope-контракту. |
| `memory_not_found` | `memory_ref` не разрешается в настроенную систему памяти. |
| `unavailable` | Память временно недоступна. |
| `timeout` | Вызов не завершился в срок; состояние провайдера неизвестно. |

Dynamic dispatcher всегда передаёт application-owned idempotency key и не повторяет `memory_store`
после неизвестного результата. Provider-specific клиент может использовать собственные безопасные
retry-механизмы только до пересечения этой границы.

## Инварианты

- Запись разрешена только после reveal в training-контуре.
- `content` передаётся только в систему, выбранную через `memory_ref`.
- Адаптер не хранит canonical copy опыта и не навязывает провайдеру IDs или формат memory units.
- Инструмент не выбирает память для production и не меняет активную `memory_ref`.
- Evaluation и production не вызывают `memory_store`.
