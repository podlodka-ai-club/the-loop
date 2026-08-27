---
type: Research
title: "xmemory: schema-grounded memory engine"
description: Исследование xmemory.ai и TypeScript API как одного из backend-провайдеров внешней памяти Loci.
timestamp: 2026-08-27T00:00:00+03:00
date: 2026-08-27
model: gpt-5
resource: https://xmemory.ai/typescript/
tags: [memory, xmemory, xmd, schema, typescript, research]
---

# xmemory: schema-grounded memory engine

## Область исследования

Под `xmemory` здесь имеется в виду продукт [xmemory.ai](https://xmemory.ai/) и его npm-пакет
`xmemory`, а не академическая статья с названием `xMemory`. Срез выполнен 2026-08-27 по
официальным документации, API reference, GitHub-репозиториям и npm-описанию.

## Краткий вывод

xmemory — schema-grounded memory layer: агент пишет и читает естественный язык, а система
сохраняет типизированные объекты и отношения в экземпляре памяти. Схема XMD одновременно
описывает хранение и правила extraction; `primary_key`, enum, relation cardinality и описания
используются для идентификации, дедупликации и валидации.

Для Loci это самый близкий из исследованных вариантов по форме контракта: есть детерминированные
structured mutations без LLM, режимы `xresponse`/`raw-tables`, trace IDs, журнал операций и
явные schema migrations. В этой архитектуре Loci `memory_snapshot_id` является внешним ID привязки к
xmemory instance; сам instance может оставаться mutable, потому что provider snapshots и
переключение между ними не являются требованиями Loci.

## Архитектура и модель данных

### Instance и XMD

Кластер содержит memory instances; каждый instance имеет собственную XMD-схему. XMD v1 задаёт:

- `objects` с полями типов `str`, `int`, `float`, `bool`;
- `required`, `default` и закрытые `enum`-значения;
- `primary_key` или составной ключ для identity/deduplication;
- `relations` с ролями, `on_delete` (`nullify`/`cascade`) и uniqueness keys для cardinality.

Поля XMD v1 скалярные: массивы, вложенные объекты, native date/UUID и атрибуты отношений не
являются типами полей. Такие данные нужно разложить на отдельные объекты и отношения или хранить
строками с явным форматом в description.

### Write/read loop

`write(text)` пропускает текст через schema-aware extraction и diff/merge, возвращая `created`,
`updated` и `deleted` изменения. `write(mutations)` принимает ordered `WriteMutation[]` и
применяет LLM-free create/update/delete объектов и отношений. `read(query)` строит запрос к
instance и по умолчанию возвращает synthesized answer; для интеграций, где нужны точные записи,
есть `xresponse` и `raw-tables`.

Schema descriptions являются частью extraction specification: они задают границы объектов,
нормализацию, классификацию и grounded derivations, а не только названия полей.

## TypeScript API

### Клиент и instance handle

```ts
import { XmemoryClient } from "xmemory";

// Constructor не выполняет health check.
const xm = new XmemoryClient({
  url: "https://api.xmemory.ai",
  apiKey: process.env.XMEM_API_KEY,
  timeoutMs: 60_000,
});

// Вариант с проверкой доступности:
// const xm = await XmemoryClient.create({ apiKey: process.env.XMEM_API_KEY });

const inst = xm.instance(process.env.XMEM_INSTANCE_ID!);

const write = await inst.write(
  "The user prefers metric units and concise explanations.",
  { extractionLogic: "deep" },
);

const answer = await inst.read("What units does the user prefer?", {
  readMode: "xresponse",
});
console.log(write.write_id, write.changes, answer.reader_result);
```

Пакет не имеет runtime-зависимостей и использует native `fetch`. `XmemoryClient.create()` и
`xmemoryInstance()` возвращают `Promise` после health check; `xm.instance(id)` синхронно создаёт
scoped handle. `apiKey`, `url` и `timeoutMs` имеют fallback на `XMEM_API_KEY`, `XMEM_API_URL` и
`60000` мс.

### Основные методы

| Область | TypeScript API | Назначение |
|---|---|---|
| Client | `checkHealth()` | Проверка API; бросает `XmemoryHealthCheckError` при недоступности. |
| Admin | `listClusters()`, `listInstances()`, `getInstance()` | Управление control plane. |
| Admin | `generateSchema(clusterId, description)` | Генерация XMD из описания workflow. |
| Admin | `createInstance(...)`, `deleteInstance()` | Жизненный цикл instance. |
| Admin | `getInstanceSchema()`, `updateInstanceSchema()` | Чтение/изменение схемы. |
| Instance | `write(text \| mutations, options?)` | Синхронный commit extraction или structured mutation. |
| Instance | `writeAsync(text \| mutations, options?)` | Очередь записи, возвращает `write_id`. |
| Instance | `writeStatus(writeId)` | Статус queued/processing/extracting/applying/completed/failed. |
| Instance | `read(query, options?)` | Natural-language query с режимами ответа. |
| Instance | `extract(text, options?)` | Preview extraction без записи. |
| Instance | `describe(options?)` | Agent-facing tools и live schema; результаты кэшируются на 5 минут. |
| Instance | `reviewSuggestions()`, `decideSuggestions()`, `applyPendingDecisions()` | Предложения эволюции схемы по реальным read-gap сигналам. |

### Structured write и точное чтение

```ts
const result = await inst.write([
  {
    object_mutation: {
      object_type: "MemoryNote",
      create: {
        key: { note_id: "note-0107" },
        values: {
          content: "Red soil is not sufficient to distinguish Brazil from Paraguay.",
        },
      },
    },
  },
]);

const exact = await inst.read("List notes for this attempt", {
  readMode: "raw-tables",
});
```

Structured mutations применяются в порядке массива и повторяются детерминированно, если ключи
заданы явно. `xresponse` возвращает `{ objects, relations }`, `raw-tables` — `{ columns, rows }`
или `null` при отсутствии строк. `single-answer` предназначен для prompt-ready ответа и может
скрыть точную форму сохранённых данных. На отдельных deployment structured writes могут быть
отключены, поэтому это нужно проверить до выбора контракта записи.

### Async consistency, ошибки и retry

`write()` ждёт commit. `writeAsync()` только ставит работу в очередь; до статуса `completed`
делать `read()` нельзя. Статусы включают промежуточные `extracting`, `extracted`, `applying`, а
ошибка содержит `error_detail` и structured `code`.

Ошибки SDK представлены `XmemoryAPIError` с полями `.status`, `.code`, `.details`, `.retryAfter`;
health-check использует подкласс `XmemoryHealthCheckError`. Клиент сам не повторяет запросы —
вызывающая сторона должна учитывать `Retry-After` для `RATE_LIMITED` (429). `QUOTA_EXCEEDED`
(402) не является обычным retryable rate limit.

Текстовая extraction-запись не гарантирует безопасный retry: модель может по-разному нормализовать
primary key и создать дубликат. Для retry-safe операций официальная Temporal-документация
рекомендует explicit structured mutations с ключами, заданными вызывающей стороной.

## Schema evolution и управление

Есть два управляемых пути:

1. **Direct migration:** `enhanceSchema` → `dryRunMigration` → `updateInstanceSchema`.
2. **Suggestion engine:** `reviewSuggestions` → `decideSuggestions` →
   `applyPendingDecisions` с optimistic-concurrency token.

Non-additive изменения (rename/remove/type change) требуют migration plan; операции, удаляющие
данные, требуют `confirmDestructive: true`. История миграций содержит `prior_version` и
`new_version`, а также YAML до/после при запросе. Публичный API описывает atomic abort при ошибке.
`prior_version`/`new_version` относятся к схеме, а не к значению Loci `memory_snapshot_id` и не требуют
переключения memory backend.

## Развёртывание и интеграции

- **REST/API:** `https://api.xmemory.ai`, JSON endpoints, Bearer API key; SDK unwraps стандартный
  response envelope `{ ids, items, errors, console_url }`.
- **MCP:** Streamable HTTP на `https://mcp.xmemory.ai/`; интерактивный OAuth2 или direct API key
  на `/instance/{instance_id}`. Есть отдельные data и admin tool planes.
- **CLI:** `xmemcli` для auth, XMD generation/validation, instance setup и read/write; credentials
  хранятся отдельно от коммитируемого `.xmemory.json`.
- **Temporal:** официальный TypeScript plugin `@xmemory/temporal` заявлен, но на момент проверки
  ещё был preview и не опубликован в npm; источник устанавливается из
  `github:xmemory-ai/xmemory-temporal-ts`. Он делает `read`/`write` Activities, добавляет
  `writeDurable` и передаёт retry/timeout в Temporal.
- **Hosting:** Pure SaaS, zero-retention SaaS с собственной RDS/Azure/GCP БД и on-prem Docker
  Compose по enterprise-контракту. npm SDK и интеграционные репозитории MIT; сервис, backend и
  extraction/reader models остаются proprietary по официальному legal notice.

## Fit для Loci

### Что совпадает с текущим контрактом

- XMD позволяет явно задать `content` и `note_id` вместо хранения полного transcript.
- Structured mutations подходят для записи заметок после `reveal`: они не требуют LLM и дают
  предсказуемый create/update/delete.
- `raw-tables`/`xresponse` ближе к `memory_retrieve`, чем synthesized `single-answer`.
- `trace_id`, `write_id`, operation history и schema migrations полезны для evaluation,
  debugging и provenance.
- Instance может быть ограничен scope-ом чтения; отдельный instance естественно изолирует схему
  одного workflow.

### Несовпадения и ограничения

- `write()` изменяет текущий instance, а `primary_key` специально разрешает deduplication и
  stateful update. Registry и operation ledger фиксируют, какой instance используется в конкретном
  workflow.
- Версионирование `prior_version`/`new_version` относится к XMD migration и не должно
  интерпретироваться как смена Loci `memory_snapshot_id` или версия memory state.
- Read scope в SDK ограничивает известные объекты, но не заменяет проверку tenant access и
  policy на уровне API key. Object-level RBAC на pricing page отмечен как coming soon.
- XMD v1 не имеет scalar attributes у relations и не поддерживает массивы/вложенные поля; схему
  `memory_note` следует держать плоской или моделировать дополнительные сущности.
- `writeAsync` удобен для latency, но training pipeline обязан дождаться `completed`, если следующий
  пример должен читать только что добавленную заметку.

Registry хранит соответствие `memory_snapshot_id → provider + instance` и отдаёт `raw-tables` или
`xresponse` из той же привязки. Идемпотентность операций остаётся на стороне адаптера/оркестратора.

## Открытые вопросы

- Как устроить registry `memory_snapshot_id → provider + instance` и lifecycle credentials для xmemory?
- Как на практике настроить отдельные read-only и training write credentials, и какие гарантии
  tenant isolation даёт текущий API key/RBAC слой?
- Какая опубликованная версия `xmemory` совместима со всеми описанными методами: документация
  уже ссылается на возможности `xmemory@3.6.0+`, тогда как npm-метаданные могут отставать.
- Доступны ли structured writes на выбранном deployment и какова фактическая задержка
  `writeAsync` на типичной XMD схеме заметок?
- Можно ли безопасно хранить геолокационные заметки в hosted/Temporal history; передаются ли
  изображения внешнему extraction LLM; какие retention/zero-retention условия применимы к нашему
  тарифу?

## Источники

1. [TypeScript SDK](https://xmemory.ai/typescript/) — клиент, instance methods, типы и ошибки.
2. [REST API](https://xmemory.ai/api/) — endpoints, response envelope, structured writes, read modes, migrations и limits.
3. [XMD schema format](https://xmemory.ai/xmd/) — objects, fields, keys, relations и validation rules.
4. [How xmemory works](https://xmemory.ai/integration-overview/) — schema-grounded extraction и sync/async workflow.
5. [MCP guide](https://xmemory.ai/mcp/) — Streamable HTTP, OAuth2/API-key auth и tool planes.
6. [CLI guide](https://xmemory.ai/cli/) — onboarding, schema validation и instance bindings.
7. [Temporal integration](https://xmemory.ai/temporal/) — TypeScript plugin, durable writes, retry/idempotency и preview status.
8. [xmemory TypeScript client repository](https://github.com/xmemory-ai/xmemory-npm) — исходники npm SDK.
9. [xmemory Temporal TypeScript repository](https://github.com/xmemory-ai/xmemory-temporal-ts) — preview plugin source.
10. [Pricing & Deployment](https://xmemory.ai/pricing-deployment/) — SaaS, private DB, on-prem и security status.
