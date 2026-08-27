---
type: Workflow
title: Production-инференс Loci
description: Проверка пользовательской фотографии, запуск слепой геолокации и возврат результата.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, inference, production, geolocation]
---

# Production-инференс Loci

## Назначение

Production-инференс принимает одну пользовательскую фотографию, проверяет вход, закрепляет
активную привязку к системе памяти и вызывает [слепую геолокацию](locate.md).

Он не содержит собственного географического reasoning и не изменяет память.

## Вход

```text
inference_request
  request_id
  image_ref
```

[`runner_config_id`](models.md#runner-config) и активный `memory_snapshot_id` являются частью
конфигурации сервиса, а не пользовательского запроса. Это историческое поле содержит opaque ID
привязки к системе/инстансу памяти, а не provider snapshot. Если активной памяти нет, inference
вызывает workflow с `memory_snapshot_id: null`.

Активная привязка меняется вручную в конфигурации сервиса между запусками; это выбор системы
памяти, а не promotion/rollback её внутреннего snapshot. Автоматической смены привязки в базовом
контуре нет.

## Выход

```text
inference_response
  request_id
  status — located | ambiguous | insufficient_evidence
  location — location_candidate | null
  alternatives[] — location_candidate
  explanation
  limitations[]
```

`location_candidate` и граница публичных полей определены в [общих моделях](models.md). Response
копирует их из `answer_snapshot` без повторного вызова модели. Memory и geocode calls остаются
внутренними.

Если запрос невозможно обработать, возвращается:

```text
inference_error
  request_id
  code — invalid_image | not_allowed | timeout | failed
  retryable
  message
```

`failed` используется только когда input прошёл проверку, но workflow слепой геолокации не вернул
пригодный `answer_snapshot`. Ошибка memory или geocoder при наличии результата остаётся успешным
response с описанием в `limitations`.

## Процесс

### 1. Проверка изображения

Оркестратор проверяет, что файл доступен, декодируется, имеет поддерживаемый формат и может быть
обработан по продуктовой policy.

### 2. Запуск

До solve оркестратор закрепляет текущие `runner_config_id`, `memory_snapshot_id` и создаёт:

```text
locate_request
  request_id
  image_ref
  runner_config_id
  memory_snapshot_id | null
```

Привязка к системе памяти не переключается внутри запроса.

### 3. Ответ

Успешный `answer_snapshot` преобразуется в `inference_response` без нового reasoning. Если память
или геокодер были недоступны, solver возвращает доступный результат и описывает ограничение в
`limitations`.

## Инварианты

- Ground truth отсутствует.
- Один production-запрос вызывает один workflow слепой геолокации.
- Inference не вызывает `memory_store`.
- Пользовательская фотография не становится training-данными автоматически.

## За пределами workflow

- обучение и оценка памяти;
- долговременное хранение пользовательских изображений;
- retry транспорта и operational telemetry;
- диалог для запроса дополнительных фотографий.
