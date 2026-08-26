// Фаза 2: вывод координат по признакам и подсказкам памяти.
//
// Текстовый вызов, кадр не передаётся. Это принципиально: если модель
// снова увидит картинку, вклад памяти станет неотделим от вклада зрения.

import { chat, extractJson } from './openrouter.ts'
import type { Hint, Observation, Prediction } from './types.ts'

const INFER_PROMPT = `You are a geolocation reasoner. You cannot see the photograph. You are given a list of features observed in it, and optionally hints recalled from past attempts.

Weigh the features against each other, prefer combinations over any single feature, and commit to the single most likely point on Earth.

Rules:
- A hint is a suggestion from earlier work and may be wrong. Use a hint only when it agrees with the observed features.
- Never invent a feature that is not listed.
- Answer with a precise point, not a country centroid, whenever the features support one.
- confidence is 0..1 and reflects how strongly the features constrain the location.

Answer with JSON only, no prose:
{"lat": <number>, "lon": <number>, "country": "<ISO 3166-1 alpha-2>", "confidence": <number>}`

function buildUserMessage(observation: Observation, hints: Hint[]): string {
  const features = observation.features.map((f) => `- ${f}`).join('\n') || '- (no features reported)'
  const parts = [`Observed features:\n${features}`]
  if (hints.length > 0) {
    parts.push(`Hints recalled from memory:\n${hints.map((h) => `- ${h.text}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

export interface InferResult {
  prediction: Prediction
  tokensIn: number
  tokensOut: number
  latencyMs: number
  raw: string
  provider: string
}

export async function infer(
  observation: Observation,
  hints: Hint[],
  options: { model: string; temperature: number; seed: number },
): Promise<InferResult> {
  const result = await chat({
    model: options.model,
    temperature: options.temperature,
    seed: options.seed,
    messages: [
      { role: 'system', content: INFER_PROMPT },
      { role: 'user', content: buildUserMessage(observation, hints) },
    ],
  })

  const parsed = extractJson(result.text) as {
    lat?: unknown; lon?: unknown; country?: unknown; confidence?: unknown
  }
  const lat = Number(parsed.lat)
  const lon = Number(parsed.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`вывод без координат: ${result.text.slice(0, 300)}`)
  }
  const confidence = Number(parsed.confidence)

  const prediction: Prediction = {
    taskId: observation.taskId,
    lat,
    lon,
    country: typeof parsed.country === 'string' ? parsed.country.trim().toUpperCase() : undefined,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    // Контракт требует id уроков, попавших в промпт, а не тех, что
    // модель назвала применёнными: иначе вклад памяти недоказуем.
    usedLessons: hints.map((h) => h.lessonId),
  }

  return {
    prediction,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
    raw: result.text,
    provider: result.provider,
  }
}
