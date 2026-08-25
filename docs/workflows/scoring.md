---
type: Workflow Contract
title: Геодезический score Loci
description: Детерминированная оценка ответа по расстоянию между выбранной точкой и ground truth.
timestamp: 2026-08-25T00:00:00+03:00
tags: [loci, workflow, evaluation, scoring, geolocation]
---

# Геодезический score Loci

## Назначение

Контракт задаёт единственный score для [оценки памяти](evaluate.md). Он не зависит от GeoGuessr и
учитывает только геодезическое расстояние между координатой ответа и ground truth.

Идентификатор policy: `geodesic-v1`.

## Score одного примера

```text
sample_score
  sample_id
  distance_km
```

Если общий [`answer_snapshot.location`](models.md#answer-snapshot) содержит latitude и longitude,
`distance_km` равен длине кратчайшей геодезической линии на эллипсоиде WGS84 до
[`ground_truth`](models.md#ground-truth).

Если ответа нет, `location: null` или одна из координат отсутствует:

```text
distance_km = 20_004
```

Это фиксированный штраф, близкий к максимальному расстоянию между двумя точками Земли. Тот же
штраф получают timeout и terminal solver failure. Пример никогда не исключается из агрегации.

`status`, `alternatives`, `explanation` и `limitations` не меняют score. Для `ambiguous`
оценивается ведущий `location`; alternatives нужны для ответа пользователю, но не для метрики.

## Score корпуса

```text
mean_distance_km = sum(sample.distance_km) / sample_count
```

Вычисления выполняются с полной точностью. Округление допускается только при отображении отчёта.
Меньшее значение означает лучший результат.

## Сравнение памяти

```text
delta_km = baseline_mean_distance_km - memory_mean_distance_km
```

Положительный `delta_km` означает, что включение memory snapshot уменьшило среднюю ошибку.
Отрицательный — что средняя ошибка выросла.

## Инварианты

- Оба прогона используют policy `geodesic-v1`.
- Каждый sample корпуса учитывается ровно один раз в каждом прогоне.
- Отсутствующий ответ получает штраф, а не удаляется из выборки.
- Ground truth доступен scorer только после фиксации `answer_snapshot`.
