---
type: Playbook
title: Воспроизведение прогона
description: Пошаговый запуск benchmark OSV-5M на чистой копии репозитория, от загрузки данных до сверки с baseline.
tags: [benchmark, playbook, reproducibility, osv5m, phoenix]
timestamp: 2026-08-26T00:00:00+03:00
---

# Воспроизведение прогона

Инструкция повторяет базовый прогон из [Оценка агента на OSV-5M](osv5m-eval.md) на
чистой копии репозитория. Шаги 1–5 не тратят деньги. Первый платный вызов происходит на
шаге 7.

## 1. Требования

- Node 22.18 или новее. Он выполняет `.ts` без сборки.
- Python с `huggingface_hub` — только для загрузки датасета.
- Docker или локальный Phoenix.
- Около 4.6 ГБ на диске: `test.csv` 116 МБ, архив shard 2.3 ГБ, распакованные кадры 2.2 ГБ.
- Ключ Cerebras.

## 2. Зависимости

```bash
npm ci
```

## 3. Датасет

Нужны `test.csv` и один shard изображений — `images/test/00`. Остальные четыре shard не
нужны: все 200 кадров замороженной выборки лежат в нулевом.

```python
from huggingface_hub import hf_hub_download

for name in ("test.csv", "images/test/00.zip"):
    hf_hub_download(
        repo_id="osv5m/osv5m",
        filename=name,
        repo_type="dataset",
        local_dir="tmp/datasets/osv5m",
    )
```

Распакуйте архив внутрь `tmp/datasets/osv5m/images/test/`. Вложенность значения не имеет:
индекс изображений обходит директорию рекурсивно и связывает файл с строкой CSV по имени.

```bash
cd tmp/datasets/osv5m/images/test && unzip -q 00.zip && cd -
```

Каталог `tmp/` в `.gitignore`. Другое расположение задаётся переменной `OSV5M_DIR`.

## 4. Ключи

```bash
cp .env.example .env
```

Впишите `CEREBRAS_API_KEY` в `.env`. Файл `.env` в `.gitignore`, в репозиторий он не
попадает. Скрипты `npm run` читают его через `node --env-file-if-exists=.env`.

## 5. Проверка выборки

Команда читает только локальные файлы и не обращается к API.

```bash
npm run sample
```

Ожидаемый вывод:

```text
dataset  tmp/datasets/osv5m
pool     50000 images on disk of 210122 rows in test.csv
manifest benchmark/samples/osv5m-v1-n200.txt
sample   n=200 seed=osv5m-v1 fp=90cb7d6da5f7 strata=193
ready    every image in the frozen sample is on disk
```

На Windows путь в первой строке печатается с обратными слэшами. Значение имеет только
строка `fp=90cb7d6da5f7`: она означает, что прогон оценит те же 200 кадров, что и baseline.
Если команда сообщает о недостающих изображениях, повторите шаг 3.

## 6. Phoenix

```bash
docker run -p 6006:6006 -p 4317:4317 -i -t arizephoenix/phoenix:latest
```

Без Docker:

```bash
uvx --from arize-phoenix phoenix serve
```

Пакет на PyPI называется `arize-phoenix`. Команда `uvx phoenix serve` ставит посторонний
пакет `phoenix`, в котором нет исполняемых файлов, и завершается сообщением
`Package \`phoenix\` does not provide any executables.`

Откройте `http://localhost:6006`. Без примонтированного тома данные пропадают после
остановки контейнера. Для сохранения примонтируйте volume в `/mnt/data`.

## 7. Прогон

```bash
npm run experiment -- --name my-run-1
```

Скрипт создаёт dataset `osv5m-osv5m-v1-n200-90cb7d6da5f7`, если его ещё нет, и переиспользует
его в следующие разы. Все прогоны на одном dataset сравнимы между собой.

Флаги: `--concurrency` (по умолчанию 8), `--name` (метка прогона), `--manifest` (другой
файл выборки).

В конце выводится сводка по метрикам и ссылка на страницу experiment в Phoenix.

## 8. Сверка

Сравните `geoscore`, среднюю дистанцию и `acc_200km` с таблицей в
[Оценка агента на OSV-5M](osv5m-eval.md). Отличие внутри коридора A/A — это шум
декодирования, а не эффект. Отличие больше коридора проверяйте тремя прогонами подряд.

## 9. Новая выборка

Замороженный список меняйте отдельной командой и отдельным commit.

```bash
node src/sample.ts --freeze --seed osv5m-v2 --size 500 --manifest benchmark/samples/osv5m-v2-n500.txt
```

Жребий идёт по строкам, изображения которых есть на диске. С другим набором shard
получится другая выборка, поэтому в описании нового manifest укажите, какие shard были
загружены. Числа со старой выборкой не сравнивайте.
