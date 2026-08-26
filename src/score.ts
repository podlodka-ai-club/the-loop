// Оценка ответа: расстояние до истины и geoscore.

import { config } from './config.ts'

const toRad = (deg: number): number => (deg * Math.PI) / 180

// Haversine, сфера. Контракт geodesic-v1 из ветки feat/workflow требует
// геодезическую на эллипсоиде WGS84 - расхождение до ~0.5%, при медианной
// ошибке в сотни километров на выводы не влияет.
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * config.earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

// TODO: сверить с реализацией Лёши, у него уже есть рабочая.
// Пока стандартная GeoGuessr-подобная экспонента, константы в config.geoscore.
export function geoscore(errorKm: number): number {
  const { maxScore, scaleKm } = config.geoscore
  return maxScore * Math.exp(-errorKm / scaleKm)
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

// Ответ считается несостоявшимся, когда модель явно отказалась: код страны
// XX или нулевая уверенность. Координаты при этом приходят валидные (0, 0),
// поэтому проверки на конечность числа недостаточно.
export function isPenalized(prediction: { country?: string; confidence: number }): boolean {
  return prediction.country === 'XX' || prediction.confidence === 0
}
