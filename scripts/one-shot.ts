// Временный контрольный прогон: кадр уходит в модель одним вызовом,
// без разделения на наблюдение и вывод. Нужен, чтобы понять, теряет ли
// двухфазная схема очки против одношаговой.
//
// Скрипт намеренно не трогает src/: это контроль, а не часть ядра.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { config, defaultModel } from '../src/config.ts'
import { chat, extractJson } from '../src/openrouter.ts'
import { geoscore, haversineKm, isPenalized, mean, median } from '../src/score.ts'
import type { Task } from '../src/types.ts'

if (existsSync('.env')) process.loadEnvFile('.env')

const LIMIT = 20
const TEMPERATURE = 0
const SEED = 1

// Тот же выходной контракт, что у infer: иначе числа несравнимы.
const ONE_SHOT_PROMPT = `You are a geolocation expert. Look at this photograph and determine where on Earth it was taken.

Rules:
- Answer with a precise point, not a country centroid, whenever the image supports one.
- confidence is 0..1 and reflects how strongly the image constrains the location.

Answer with JSON only, no prose:
{"lat": <number>, "lon": <number>, "country": "<ISO 3166-1 alpha-2>", "confidence": <number>}`

function imageDataUrl(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`
}

async function main(): Promise<void> {
  const model = defaultModel()
  const tasks = readFileSync(config.paths.tasks, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Task)
    .filter((task) => task.split === 'heldout_a')
    .slice(0, LIMIT)

  console.log(`одношаговый контроль: задач=${tasks.length} модель=${model} temperature=${TEMPERATURE}`)

  const results: {
    taskId: string; errorKm: number; geoscore: number; countryCorrect: boolean
    penalized: boolean; country: string | undefined; confidence: number
    tokensIn: number; tokensOut: number; latencyMs: number; provider: string
  }[] = []

  for (const [index, task] of tasks.entries()) {
    const result = await chat({
      model,
      temperature: TEMPERATURE,
      seed: SEED,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: ONE_SHOT_PROMPT },
            { type: 'image_url', image_url: { url: imageDataUrl(task.imagePath) } },
          ],
        },
      ],
    })

    const parsed = extractJson(result.text) as {
      lat?: unknown; lon?: unknown; country?: unknown; confidence?: unknown
    }
    const lat = Number(parsed.lat)
    const lon = Number(parsed.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`ответ без координат на ${task.id}: ${result.text.slice(0, 300)}`)
    }
    const rawConfidence = Number(parsed.confidence)
    const prediction = {
      lat,
      lon,
      country: typeof parsed.country === 'string' ? parsed.country.trim().toUpperCase() : undefined,
      confidence: Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0,
    }

    const penalized = isPenalized(prediction)
    const errorKm = penalized ? config.penaltyKm : haversineKm(task.truth, prediction)

    results.push({
      taskId: task.id,
      errorKm,
      geoscore: geoscore(errorKm),
      countryCorrect: !penalized && prediction.country === task.truth.country,
      penalized,
      country: prediction.country,
      confidence: prediction.confidence,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      provider: result.provider,
    })

    console.log(
      `[${index + 1}/${tasks.length}] ${task.id} ${task.truth.country} -> ` +
        `${prediction.country ?? '??'} ${errorKm.toFixed(1)} км${penalized ? ' (штраф)' : ''}`,
    )
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = `${config.paths.runs}/${timestamp}-oneshot.jsonl`
  mkdirSync(config.paths.runs, { recursive: true })
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const errors = results.map((r) => r.errorKm)
  console.log('---')
  console.log(`медианная ошибка: ${median(errors).toFixed(1)} км`)
  console.log(`средняя ошибка:   ${mean(errors).toFixed(1)} км`)
  console.log(`средний geoscore: ${mean(results.map((r) => r.geoscore)).toFixed(1)}`)
  console.log(`страна угадана:   ${results.filter((r) => r.countryCorrect).length}/${results.length}`)
  console.log(`штрафных ответов: ${results.filter((r) => r.penalized).length}/${results.length}`)
  console.log(`< 25 км: ${errors.filter((e) => e < 25).length}, < 200 км: ${errors.filter((e) => e < 200).length}`)
  console.log(`токенов: ${results.reduce((s, r) => s + r.tokensIn, 0)} in / ${results.reduce((s, r) => s + r.tokensOut, 0)} out`)
  console.log(`записано: ${outPath}`)
}

void main().catch((error: unknown) => {
  console.error(`контроль остановлен: ${(error as Error).message}`)
  process.exitCode = 1
})
