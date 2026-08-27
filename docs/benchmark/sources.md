---
type: Reference
title: Источники метрик benchmark
description: Публикации и реализации, из которых взяты определения метрик, пороги точности и опорные числа.
tags: [benchmark, reference, metrics, osv5m, phoenix]
timestamp: 2026-08-26T00:00:00+03:00
---

# Источники метрик benchmark

Каждый источник был прочитан, а не восстановлен по памяти. Аннотация говорит, для чего
источник нужен.

## Датасет и метрики

- [OpenStreetView-5M: The Many Roads to Global Visual Geolocation, CVPR 2024](https://arxiv.org/abs/2404.18873)
  Датасет: 5.1 млн кадров, 225 стран, строгое разделение train и test. Нужен для
  обоснования, почему оценивается только test-сплит.
- [gastruc/osv5m](https://github.com/gastruc/osv5m)
  Референсная реализация метрик, `metrics/distance_based.py` и `metrics/utils.py`.
  Нужна для сверки haversine и GeoScore в `src/geo.ts`.
- [osv5m.github.io](https://osv5m.github.io/)
  Определения метрик и leaderboard. Нужен для выбора чисел для сравнения.
- [Model card osv5m/baseline](https://huggingface.co/osv5m/baseline)
  Обученный baseline авторов: GeoScore 3361, средняя ошибка 1814 км, country accuracy
  68%. Нужен для ответа на вопрос, лучше агент или хуже обученной модели.
- [PIGEON: Predicting Image Geolocations, arXiv 2307.05845](https://arxiv.org/abs/2307.05845)
  Источник постоянной 1492.7 км в формуле GeoScore.
- [Image-Based Geolocation Using Large Vision-Language Models, arXiv 2408.09474](https://arxiv.org/pdf/2408.09474)
  Раздел E задаёт haversine, GeoScore и пороговую точность для vision-LLM. Ближайшая
  опубликованная постановка к этому репозиторию.
- [GaGA: Towards Interactive Global Geolocation Assistant, arXiv 2412.08907](https://arxiv.org/html/2412.08907v1)
  Лестница порогов 1 / 25 / 200 / 750 / 2500 км и сравнимые числа для LLM.
- [Assessing the Geolocation Capabilities, Limitations and Societal Risks of Generative Vision-Language Models, arXiv 2508.19967](https://arxiv.org/pdf/2508.19967)
  Загрязнение обучающих данных, отказы модели и этика задачи. Нужен для метрики
  `suspected_leak`.

## Harness

- [Phoenix: datasets and experiments quickstart](https://arize.com/docs/phoenix/datasets-and-experiments/quickstart-datasets)
  Схема dataset — task — evaluator — experiment, по которой построен `src/experiment.ts`.
- [@arizeai/phoenix-client](https://github.com/Arize-ai/phoenix/blob/main/js/packages/phoenix-client/README.md)
  Сигнатуры `createDataset`, `runExperiment` и контракт evaluator в TypeScript.
- [Phoenix: self-hosting with Docker](https://arize.com/docs/phoenix/self-hosting/deployment-options/docker)
  Порты 6006 и 4317, монтирование тома для сохранения трасс.

## Открытые вопросы

- Нет проверенного источника по выбору размера выборки для метрик координатной ошибки.
  Нужна ссылка на bootstrap-доверительные интервалы, чтобы заменить эмпирический коридор
  A/A расчётным.
- Нет проверенного источника по калибровке confidence для регрессионного вывода. Поле
  `confidence` пока не входит в метрики.
