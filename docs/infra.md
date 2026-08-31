---
type: Playbook
title: "Запуск тестов и интеграционных проверок"
description: Порядок запуска локальных проверок, live-теста Mem0 Cloud и полного memory pilot.
timestamp: 2026-08-28T00:00:00+03:00
tags: [loci, infrastructure, tests, mem0, cloud, benchmark]
---

# Запуск тестов и интеграционных проверок

## Предварительные условия

- Node.js версии не ниже `22.18`.
- Зависимости установлены через `npm install`.
- Реальный `.env` находится в корне репозитория и не добавлен в git.
- Для `npm run sample` локальный OSV-5M расположен по `OSV5M_DIR`; по умолчанию ожидаются
  `tmp/datasets/osv5m/test.csv` и `tmp/datasets/osv5m/images/test/`.

## Локальные проверки

Проверка типов:

```bash
npm run typecheck
```

Все тесты Mem0 без обращения к Cloud:

```bash
npm run test:mem0
```

Команда не загружает `.env` автоматически. При обычном запуске integration fixture должен быть
помечен `SKIP`, а остальные тесты должны завершиться без ошибок.

Полный набор тестов, который Node обнаруживает в репозитории:

```bash
node --test
```

Проверка замороженной выборки benchmark:

```bash
npm run sample
```

Эта команда требует локальный CSV OSV-5M. Отсутствие `tmp/datasets/osv5m/test.csv` означает, что
fixture не подготовлена, а не что Mem0-адаптер сломан.

## Настройка Mem0 Cloud

Скопируй `.env.example` в `.env` и заполни блок Mem0:

```dotenv
MEM0_API_KEY=<secret>
MEM0_AGENT_ID=<new-unique-agent-id>
MEM0_INGESTION_TIMEOUT_MS=120000
MEM0_POLL_INTERVAL_MS=1000
MEM0_INTEGRATION=1
```

Правила для окружения:

- `MEM0_API_KEY` хранится только в `.env`; не передавай его в аргументах команд, логах или
  документации.
- `MEM0_INTEGRATION` должен быть равен строке `1`. Любое другое значение отключает Cloud-вызовы.
- Для каждого live-теста и каждого pilot используй новый `MEM0_AGENT_ID` с пустым scope.
- Integration test и pilot записывают данные в Mem0 Cloud и не удаляют их после завершения.
- После принятой Cloud-записи scope считается одноразовым даже при timeout или ошибке. Не повторяй
  запуск с тем же `MEM0_AGENT_ID`: поздняя запись может изменить результат следующего прогона.

## Live contract test Mem0

Минимальная проверка подключения реально выполняет цепочку
`add → event polling → visibility → metadata → list → ranked search`:

```bash
node --env-file=.env --test src/memory/mem0/platform.integration.test.ts
```

Успешный результат содержит имя теста
`Mem0 Cloud normalizes add, event, visibility, metadata, list and ranked search`, `pass 1`,
`fail 0` и `skipped 0`. Если тест помечен `SKIP`, проверь `MEM0_INTEGRATION=1` и способ загрузки
`.env`.

Чтобы одновременно выполнить unit-тесты и live contract test с тем же окружением:

```bash
node --env-file=.env --test src/memory/mem0/*.test.ts
```

После успешного contract test замени `MEM0_AGENT_ID` перед pilot: smoke-тест уже сделал scope
непустым.

## Полный Mem0 pilot

Pilot загружает `.env` автоматически и использует два замороженных manifest по 30 кейсов:

```bash
npm run mem0:pilot
```

До записи harness валидирует оба manifest и вызывает `list` для проверки пустого scope. После
валидного preflight он печатает ровно один итоговый JSON. Пример успешной структуры:

```json
{
  "lessonCases": 30,
  "lessonsWithCorrectFact": 30,
  "extractedFacts": 42,
  "distortedFacts": 0,
  "queryCases": 30,
  "queriesWithExpectedFactInTop5": 30,
  "writeFailures": 0,
  "recallFailures": 0,
  "harnessFailures": 0,
  "aborted": false,
  "instanceQuarantined": false,
  "scopeRetired": true,
  "passed": true
}
```

Число `extractedFacts` и фактические результаты могут меняться вместе с поведением Cloud. Условия
успеха зафиксированы в [спецификации адаптера](/specs/mem0-adapter/spec.md):

- не менее 24 из 30 lessons дают ожидаемый географический fact;
- `distortedFacts` равен нулю;
- ожидаемый fact входит в top-5 не менее чем для 24 из 30 queries;
- все три failure counter равны нулю.

`scopeRetired: true` означает, что использованный `MEM0_AGENT_ID` больше нельзя применять в
следующем pilot. Exit code равен нулю только при `passed: true`.

## Диагностика ошибок

| Признак | Что проверить |
|---|---|
| Integration test имеет статус `SKIP` | `.env` загружен через `--env-file`, а `MEM0_INTEGRATION` точно равен `1` |
| `authentication` или `authorization` | API key принадлежит нужному Mem0 project и остаётся активным |
| Preflight сообщает непустой scope | Создать новый уникальный `MEM0_AGENT_ID`; старый scope не очищать и не переиспользовать |
| `ingestion_outcome_unknown` или timeout | Прекратить прогон и заменить `MEM0_AGENT_ID`; автоматический повтор небезопасен |
| `rate_limited` или `quota_exceeded` | Проверить лимиты Mem0 project; не маскировать ошибку пустым результатом |
| `npm run sample` завершается с `ENOENT` | Подготовить локальный OSV-5M по пути `OSV5M_DIR` |

Адаптер намеренно не включает raw provider response, request body, lesson/query или API key в
публичные ошибки и логи. Для диагностики используй нормализованный error code и, когда он доступен,
очищенный `eventId`.
