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
активный snapshot памяти и вызывает общий [workflow геолокации](locate.md).

Он не содержит собственного географического reasoning и не изменяет память.

## Вход

```text
inference_request
  request_id
  image_ref
```

Активный `memory_snapshot_id` является частью конфигурации сервиса, а не пользовательского
запроса. Если активной памяти нет, inference вызывает solver с `memory_snapshot_id: null`.

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

`location_candidate` определён в [контракте геолокации](locate.md). Response копирует публичные
поля `answer_snapshot` без повторного вызова модели. Внутренние `memory_calls` и
`used_memory_note_ids` пользователю не возвращаются.

Если запрос невозможно обработать, возвращается:

```text
inference_error
  request_id
  code — invalid_image | not_allowed | failed
  message
```

## Процесс

### 1. Проверка изображения

Оркестратор проверяет, что файл доступен, декодируется, имеет поддерживаемый формат, относится к
одной сцене и может быть обработан по продуктовой policy.

### 2. Запуск

До solve оркестратор закрепляет текущий `memory_snapshot_id` и создаёт:

```text
locate_request
  request_id
  image_ref
  memory_snapshot_id | null
```

Snapshot не переключается внутри запроса.

### 3. Ответ

Успешный `answer_snapshot` преобразуется в `inference_response` без нового reasoning. Если память
или геокодер были недоступны, solver возвращает доступный результат и описывает ограничение в
`limitations`.

## Инварианты

- Ground truth отсутствует.
- Один production-запрос вызывает один blind solve.
- Inference не вызывает `memory_store`.
- Пользовательская фотография не становится training-данными автоматически.

## За пределами workflow

- обучение и оценка памяти;
- долговременное хранение пользовательских изображений;
- retry транспорта и operational telemetry;
- диалог для запроса дополнительных фотографий.
