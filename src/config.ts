// Единая точка настройки прогона. Всё, что предстоит согласовать с
// командой, вынесено сюда, чтобы менялось одной строкой.

export const config = {
  openRouterBaseUrl: 'https://openrouter.ai/api/v1',

  // TODO: сверить с реализацией Лёши, у него уже есть рабочая.
  // Пока стандартная GeoGuessr-подобная экспонента для мировой карты:
  //   score = maxScore * exp(-distanceKm / scaleKm)
  geoscore: {
    maxScore: 5000,
    scaleKm: 1492.7,
  },

  // Провайдер фиксируется, иначе OpenRouter волен раздать один и тот же
  // слаг с разной квантовкой и ответы поедут между прогонами.
  // order задаёт провайдера, quantizations - точность: у части провайдеров
  // несколько эндпоинтов одного слага с разной квантовкой, и без второго
  // поля фиксация неполная.
  provider: {
    order: ['Novita'],
    allowFallbacks: false,
    quantizations: ['bf16'],
  },

  // Ответ без содержания ("не знаю") не исключается из выборки, а получает
  // фиксированный штраф, см. docs/workflows/scoring.md. Иначе отказ модели
  // случайно оказывается хорошим ответом: до (0, 0) от Конго 2687 км.
  penaltyKm: 20_004,

  // Радиус Земли для haversine, км.
  earthRadiusKm: 6371.0088,

  paths: {
    tasks: 'data/tasks.jsonl',
    observations: 'data/observations.jsonl',
    runs: 'data/runs',
  },

  // Сколько подсказок памяти максимум уходит в промпт вывода.
  recallLimit: 5,

  requestTimeoutMs: 120_000,
} as const

// Слаг читается функцией, а не полем: .env загружается в рантайме,
// а поле объекта зафиксировало бы значение на момент импорта модуля.
//
// TODO: слаги моделей уточняются у команды. Пока один слаг на оба вызова;
// разделение vision/text появится вместе с согласованными слагами,
// слаг живёт в runner_config.model_id, см. docs/workflows/models.md.
export function defaultModel(): string {
  return process.env.LOCI_MODEL ?? 'REPLACE_WITH_OPENROUTER_SLUG'
}
