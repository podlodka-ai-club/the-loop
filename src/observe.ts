// Фаза 1: перечисление наблюдаемых признаков кадра.
//
// Единственный вызов vision-модели за задачу. Догадки о стране здесь
// запрещены явно: страна - работа фазы вывода, иначе наблюдение
// перестаёт быть независимым входом и сравнивать режимы памяти нечем.
//
// Результат кэшируется в data/observations.jsonl: прогоны разных
// режимов не должны дёргать VLM повторно.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { config } from './config.ts'
import { chat, extractJson } from './openrouter.ts'
import type { Observation, Task } from './types.ts'

// Слоты собраны из таблицы признаков в разборе игры профессионалов
// (docs/research/geo-guessr/rainbolt-wired.md). Строка Street View
// оттуда исключена: у нас кадры дашкамов, гугл-мет в них нет.
//
// Слоты обязательные: модель молчала о стороне движения и надписях там,
// где они видны, и вывод оставался без самых сильных признаков. Явное
// "not visible" отличает "не видно" от "не посмотрел".
const OBSERVE_PROMPT = `You are a visual observation instrument. Report only what is literally visible in this photograph.

You MUST emit exactly one entry for every slot below, in this order. If the slot is not visible in the image, emit the slot with the value "not visible". Never omit a slot, and never merge two slots into one entry.

1. "traffic side: ..." - which side vehicles drive on, position of the camera in the lane, side of the steering wheel.
2. "script and language: ..." - the writing system and language of ANY text in the frame, including partial, blurred or truncated words. Name the script (latin, cyrillic, arabic, devanagari, han, ...) and any diacritics.
3. "visible text: ..." - every readable string, quoted verbatim, including fragments.
4. "plate colour front: ..." - colour and proportions of any front number plate.
5. "plate colour rear: ..." - colour and proportions of any rear number plate.
6. "poles: ..." - material, shape, crossbars, holes, hooks, insulators of utility and light poles.
7. "bollards and barriers: ..." - bollard shape, colour and reflector colour, guardrail profile, fencing.
8. "road markings: ..." - colour, pattern and position of every line, including edge and centre lines.
9. "road surface: ..." - material, colour, width, condition.
10. "vegetation: ..." - species or type, density, colour, season.
11. "terrain and soil: ..." - relief, soil colour and texture, rocks, water, horizon shape.
12. "built environment: ..." - building materials, roof shapes, fences, utility boxes, sign shapes and colours.
13. "vehicles: ..." - makes, body types, roof racks, bull bars, taxi or bus liveries.
14. "road geometry: ..." - road azimuth if determinable, curvature, position of landmarks.

Hard rules:
- Never name a country, region, city or continent.
- Never infer a location, and never explain what a feature implies.
- Report absence as "not visible" only for the slot at hand; do not guess at anything obscured.
- Keep every entry to one short self-contained phrase after the slot prefix.

Answer with JSON only, no prose:
{"features": ["traffic side: ...", "script and language: ...", "..."]}`

function imageDataUrl(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`
}

export function loadObservations(): Map<string, Observation> {
  const cache = new Map<string, Observation>()
  if (!existsSync(config.paths.observations)) return cache
  for (const line of readFileSync(config.paths.observations, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const observation = JSON.parse(line) as Observation
    cache.set(observation.taskId, observation)
  }
  return cache
}

export interface ObserveResult {
  observation: Observation
  tokensIn: number
  tokensOut: number
  latencyMs: number
  cached: boolean
  provider: string   // пустой, если наблюдение взято из кэша
}

export async function observe(
  task: Task,
  options: { model: string; temperature: number; seed: number; cache: Map<string, Observation> },
): Promise<ObserveResult> {
  const hit = options.cache.get(task.id)
  if (hit) return { observation: hit, tokensIn: 0, tokensOut: 0, latencyMs: 0, cached: true, provider: '' }

  if (!existsSync(task.imagePath)) throw new Error(`нет кадра ${task.imagePath}`)

  const result = await chat({
    model: options.model,
    temperature: options.temperature,
    seed: options.seed,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OBSERVE_PROMPT },
          { type: 'image_url', image_url: { url: imageDataUrl(task.imagePath) } },
        ],
      },
    ],
  })

  // Признаки нормализуются в нижний регистр: иначе память не сматчит
  // "Latin script" и "latin script". Исходное написание, включая
  // процитированные надписи, сохраняется в raw.
  const parsed = extractJson(result.text) as { features?: unknown }
  const features = Array.isArray(parsed.features)
    ? parsed.features
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim().toLowerCase())
    : []

  const observation: Observation = { taskId: task.id, features, raw: result.text }

  mkdirSync(dirname(config.paths.observations), { recursive: true })
  appendFileSync(config.paths.observations, JSON.stringify(observation) + '\n')
  options.cache.set(task.id, observation)

  return {
    observation,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
    cached: false,
    provider: result.provider,
  }
}
