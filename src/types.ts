// Контракты ядра и памяти. Черновик к синку 26.08.
// TODO: свести Lesson и memory_note из docs/workflows/models.md.

export interface Task {
  id: string           // стабильный, по нему идёт парное сравнение режимов
  imagePath: string
  truth: { lat: number; lon: number; country: string }
  split: 'train' | 'heldout_a' | 'heldout_b'
}

// Фаза 1: что видно на кадре. Кэшируется, чтобы прогоны разных
// режимов памяти не дёргали VLM повторно.
export interface Observation {
  taskId: string
  features: string[]   // "правостороннее движение", "латиница, диакритика"
  raw: string          // сырой ответ модели, для разбора провалов
}

// Фаза 2: вывод по признакам плюс подсказки из памяти.
export interface Prediction {
  taskId: string
  lat: number
  lon: number
  country?: string
  confidence: number   // 0..1, нужен для отсечки "не знаю"
  usedLessons: string[] // id уроков, попавших в промпт - без этого
                        // не докажем, что сработала именно память
}

export interface Lesson {
  id: string
  createdAtTask: string  // на какой задаче родился, отсюда чекпоинты
  trigger: string[]      // признаки, при которых урок релевантен
  claim: string          // "красная латеритная обочина + правый руль -> Кения"
  region: string
  hits: number           // сколько раз применён
  wins: number           // сколько раз применение совпало с улучшением
}

export interface Hint {
  lessonId: string
  text: string
}

export interface Memory {
  recall(features: string[], limit: number): Promise<Hint[]>
  remember(lesson: Lesson): Promise<void>
  snapshot(): Promise<string>      // id состояния, для заморозки и чекпоинтов
  restore(id: string): Promise<void>
}

export type Mode =
  | 'off'        // recall не вызывается, baseline
  | 'live'       // полный маховик: recall + remember
  | 'frozen'     // recall из снапшота, remember выключен
  | 'shuffled'   // recall из чужой памяти, контроль на "просто больше текста"

export interface RunConfig {
  mode: Mode
  split: Task['split']
  model: string        // точный слаг OpenRouter
  snapshotId?: string  // для frozen и shuffled
  seed: number
  temperature: number  // правка контракта 26.08: детерминизм замера
}

export interface RunResult {
  taskId: string
  errorKm: number
  geoscore: number     // правка контракта 26.08: GeoGuessr-подобная экспонента
  countryCorrect: boolean
  provider: string     // правка контракта 26.08: фактический провайдер OpenRouter
  penalized: boolean   // правка контракта 26.08: ответа не было, errorKm - штраф
  prediction: Prediction
  tokensIn: number
  tokensOut: number
  latencyMs: number
}
