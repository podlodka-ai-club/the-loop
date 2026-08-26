// CLI прогона: набор задач -> RunResult на задачу.
//
//   npx tsx src/run.ts --mode off --limit 20 --temperature 0 --seed 1
//
// Порядок задач фиксирован файлом data/tasks.jsonl, температура и seed
// задаются явно: без этого повторный прогон несравним с предыдущим.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { config, defaultModel } from './config.ts'
import { infer } from './infer.ts'
import { loadObservations, observe } from './observe.ts'
import { NullMemory } from './memory/null.ts'
import { geoscore, haversineKm, isPenalized, mean, median } from './score.ts'
import type { Memory, Mode, RunConfig, RunResult, Task } from './types.ts'

if (existsSync('.env')) process.loadEnvFile('.env')

const MODES: Mode[] = ['off', 'live', 'frozen', 'shuffled']
const SPLITS: Task['split'][] = ['train', 'heldout_a', 'heldout_b']

interface Args {
  mode: Mode
  split: Task['split']
  limit: number
  temperature: number
  seed: number
  model: string
  tag: string
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) throw new Error(`неизвестный аргумент: ${token}`)
    const [flag, inline] = token.slice(2).split('=', 2)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`у --${flag} нет значения`)
    raw.set(flag!, value)
  }

  const mode = (raw.get('mode') ?? 'off') as Mode
  if (!MODES.includes(mode)) throw new Error(`--mode должен быть одним из ${MODES.join('|')}`)
  const split = (raw.get('split') ?? 'heldout_a') as Task['split']
  if (!SPLITS.includes(split)) throw new Error(`--split должен быть одним из ${SPLITS.join('|')}`)

  const number = (flag: string, fallback: number): number => {
    const value = raw.get(flag)
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new Error(`--${flag} должен быть числом`)
    return parsed
  }

  return {
    mode,
    split,
    limit: number('limit', Number.POSITIVE_INFINITY),
    temperature: number('temperature', 0),
    seed: number('seed', 1),
    model: raw.get('model') ?? defaultModel(),
    tag: raw.get('tag') ?? '',
  }
}

function loadTasks(split: Task['split'], limit: number): Task[] {
  if (!existsSync(config.paths.tasks)) {
    throw new Error(`нет ${config.paths.tasks}, сначала npm run build-tasks`)
  }
  const tasks = readFileSync(config.paths.tasks, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Task)
    .filter((task) => task.split === split)
  return Number.isFinite(limit) ? tasks.slice(0, limit) : tasks
}

function buildMemory(mode: Mode): Memory {
  if (mode === 'off') return new NullMemory()
  throw new Error(`режим ${mode} требует реализации памяти, сейчас доступен только off`)
}

// Одна повторная попытка на задачу: сетевой сбой не должен ронять прогон,
// но и молча заменять ответ заглушкой нельзя - расхождение двух прогонов
// станет шумом неизвестной природы.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (first) {
    console.warn(`  повтор ${label}: ${(first as Error).message}`)
    return await fn()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runConfig: RunConfig = {
    mode: args.mode,
    split: args.split,
    model: args.model,
    seed: args.seed,
    temperature: args.temperature,
  }

  const tasks = loadTasks(args.split, args.limit)
  if (tasks.length === 0) throw new Error(`в сплите ${args.split} нет задач`)

  const memory = buildMemory(args.mode)
  const observationCache = loadObservations()
  const results: RunResult[] = []

  console.log(`прогон: mode=${args.mode} split=${args.split} задач=${tasks.length}`)
  console.log(`модель=${args.model} temperature=${args.temperature} seed=${args.seed}`)

  for (const [index, task] of tasks.entries()) {
    const startedAt = performance.now()

    const observed = await withRetry(`observe ${task.id}`, () =>
      observe(task, {
        model: args.model,
        temperature: args.temperature,
        seed: args.seed,
        cache: observationCache,
      }),
    )

    const hints = await memory.recall(observed.observation.features, config.recallLimit)

    const inferred = await withRetry(`infer ${task.id}`, () =>
      infer(observed.observation, hints, {
        model: args.model,
        temperature: args.temperature,
        seed: args.seed,
      }),
    )

    const penalized = isPenalized(inferred.prediction)
    const errorKm = penalized ? config.penaltyKm : haversineKm(task.truth, inferred.prediction)
    // Провайдер обоих вызовов обязан совпадать; расхождение видно в отчёте.
    const providers = [...new Set([observed.provider, inferred.provider].filter(Boolean))]
    const result: RunResult = {
      taskId: task.id,
      errorKm,
      geoscore: geoscore(errorKm),
      countryCorrect: !penalized && inferred.prediction.country === task.truth.country,
      penalized,
      provider: providers.join('/') || 'unknown',
      prediction: inferred.prediction,
      tokensIn: observed.tokensIn + inferred.tokensIn,
      tokensOut: observed.tokensOut + inferred.tokensOut,
      latencyMs: Math.round(performance.now() - startedAt),
    }
    results.push(result)

    console.log(
      `[${index + 1}/${tasks.length}] ${task.id} ${task.truth.country} ` +
        `-> ${inferred.prediction.country ?? '??'} ${errorKm.toFixed(1)} км` +
        (penalized ? ' (штраф, ответа нет)' : '') +
        (observed.cached ? ' (наблюдение из кэша)' : ''),
    )
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = args.tag ? `-${args.tag}` : ''
  const outPath = `${config.paths.runs}/${timestamp}-${args.mode}${suffix}.jsonl`
  mkdirSync(config.paths.runs, { recursive: true })
  writeFileSync(
    outPath,
    [JSON.stringify({ runConfig }), ...results.map((r) => JSON.stringify(r))].join('\n') + '\n',
  )

  const errors = results.map((r) => r.errorKm)
  const scores = results.map((r) => r.geoscore)
  console.log('---')
  console.log(`медианная ошибка: ${median(errors).toFixed(1)} км`)
  console.log(`средняя ошибка:   ${mean(errors).toFixed(1)} км`)
  console.log(`средний geoscore: ${mean(scores).toFixed(1)}`)
  console.log(`страна угадана:   ${results.filter((r) => r.countryCorrect).length}/${results.length}`)
  console.log(`штрафных ответов: ${results.filter((r) => r.penalized).length}/${results.length}`)
  console.log(`< 25 км: ${errors.filter((e) => e < 25).length}, < 200 км: ${errors.filter((e) => e < 200).length}`)
  console.log(`провайдер: ${[...new Set(results.map((r) => r.provider))].join(', ')}`)
  console.log(`записано: ${outPath}`)
}

void main().catch((error: unknown) => {
  console.error(`прогон остановлен: ${(error as Error).message}`)
  process.exitCode = 1
})
