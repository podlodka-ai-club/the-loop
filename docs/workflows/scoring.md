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
  penalized
```

Если общий [`answer_snapshot.location`](models.md#answer-snapshot) содержит latitude и longitude,
`distance_km` равен длине кратчайшей геодезической линии на эллипсоиде WGS84 до
[`ground_truth`](models.md#ground-truth), а `penalized: false`.

Если ответа нет, `location: null` или одна из координат отсутствует:

```text
distance_km = 20_004
penalized = true
```

Это фиксированный штраф, близкий к максимальному расстоянию между двумя точками Земли. Тот же
штраф получают timeout и terminal solver failure. Пример никогда не исключается из агрегации.

`status`, `alternatives`, `explanation` и `limitations` не меняют score. Для `ambiguous`
оценивается ведущий `location`; alternatives нужны для ответа пользователю, но не для метрики.

## Score корпуса

```text
mean_distance_km = sum(sample.distance_km) / sample_count
median_distance_km = median(sample.distance_km)
penalized_count = count(sample.penalized)
```

Для чётного числа samples median равна среднему двух центральных значений отсортированного ряда.
Вычисления выполняются с полной точностью. Округление допускается только при отображении отчёта.
Меньшее расстояние означает лучший результат.

## Сравнение памяти

```text
delta_km = baseline_mean_distance_km - memory_mean_distance_km
median_delta_km = baseline_median_distance_km - memory_median_distance_km
```

Положительная delta означает уменьшение соответствующей ошибки. Mean остаётся основной метрикой;
median и penalized counts показывают устойчивость результата к редким крупным сбоям.

## Инварианты

- Оба прогона используют policy `geodesic-v1`.
- Каждый sample корпуса учитывается ровно один раз в каждом прогоне.
- Отсутствующий ответ получает штраф, а не удаляется из выборки.
- Penalized samples учитываются и в mean, и в median.
- Ground truth доступен scorer только после фиксации `answer_snapshot`.
