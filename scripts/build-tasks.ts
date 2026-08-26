// Сборка набора задач из тестового сплита osv5m.
//
// Плотность важнее разнообразия: берём немного стран, но много кадров
// на страну, чтобы урок про страну переиспользовался внутри набора.
//
// Нарезка идёт по плану снапшота (docs/data/snapshot-plan.md):
//   train      - поток, на котором копится опыт
//   heldout_a  - те же страны, другие кадры
//   heldout_b  - страны, не встречавшиеся в потоке
//
// Утечка между train и heldout_a закрывается группировкой по sequence:
// кадры одной съёмочной последовательности целиком уходят в один сплит.

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import type { Task } from '../src/types.ts'
import { config } from '../src/config.ts'

const DATASET_DIR = 'tmp/datasets/osv5m'
const CSV_PATH = `${DATASET_DIR}/test.csv`
const SHARD_ZIP = `${DATASET_DIR}/images/test/00.zip`
const IMAGES_DIR = `${DATASET_DIR}/images/test/00`

// Квоты набора.
const MAIN_COUNTRIES = 14        // страны потока, они же в heldout_a
const FRAMES_PER_COUNTRY = 20    // кадров на страну потока
const HELDOUT_A_PER_COUNTRY = 3  // из них уходит в heldout_a
const HELDOUT_B_COUNTRIES = 4    // страны только под heldout_b
const HELDOUT_B_FRAMES = 15      // кадров на страну heldout_b

const SEED = 20260826

interface Row {
  id: string
  lat: number
  lon: number
  country: string
  sequence: string
}

// Разбор строки CSV с учётом кавычек: в osv5m есть поля вида "(61, 28)".
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: T[], rnd: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const a = out[i]!, b = out[j]!
    out[i] = b; out[j] = a
  }
  return out
}

// Идентификаторы кадров, реально лежащих в скачанном шарде.
function shardIds(): Set<string> {
  const listing = execFileSync('unzip', ['-Z1', SHARD_ZIP], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const ids = new Set<string>()
  for (const name of listing.split('\n')) {
    const m = /^00\/(.+)\.jpg$/.exec(name.trim())
    if (m) ids.add(m[1]!)
  }
  return ids
}

async function readRows(ids: Set<string>): Promise<Row[]> {
  const rl = createInterface({ input: createReadStream(CSV_PATH), crlfDelay: Infinity })
  let header: string[] | null = null
  let idx = { id: -1, lat: -1, lon: -1, country: -1, sequence: -1 }
  const rows: Row[] = []
  for await (const line of rl) {
    if (!line) continue
    const cells = parseCsvLine(line)
    if (!header) {
      header = cells
      idx = {
        id: header.indexOf('id'),
        lat: header.indexOf('latitude'),
        lon: header.indexOf('longitude'),
        country: header.indexOf('country'),
        sequence: header.indexOf('sequence'),
      }
      for (const [key, value] of Object.entries(idx)) {
        if (value < 0) throw new Error(`в ${CSV_PATH} нет колонки ${key}`)
      }
      continue
    }
    const id = cells[idx.id] ?? ''
    if (!ids.has(id)) continue
    const country = cells[idx.country] ?? ''
    const lat = Number(cells[idx.lat])
    const lon = Number(cells[idx.lon])
    if (!country || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    rows.push({ id, lat, lon, country, sequence: cells[idx.sequence] || id })
  }
  return rows
}

// Кадры страны, сгруппированные по sequence и перемешанные детерминированно.
function sequenceGroups(rows: Row[], rnd: () => number): Row[][] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = groups.get(row.sequence)
    if (bucket) bucket.push(row)
    else groups.set(row.sequence, [row])
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, bucket]) => bucket.slice().sort((a, b) => (a.id < b.id ? -1 : 1)))
  return shuffled(ordered, rnd)
}

// Разложение групп по квотам: группа не рвётся между сплитами.
function take(groups: Row[][], quota: number, from: number): { rows: Row[]; next: number } {
  const rows: Row[] = []
  let i = from
  while (i < groups.length && rows.length < quota) {
    for (const row of groups[i]!) {
      if (rows.length >= quota) break
      rows.push(row)
    }
    i++
  }
  return { rows, next: i }
}

async function main(): Promise<void> {
  if (!existsSync(CSV_PATH)) throw new Error(`нет ${CSV_PATH}, датасет не выгружен`)
  if (!existsSync(SHARD_ZIP)) throw new Error(`нет ${SHARD_ZIP}, датасет не выгружен`)

  const ids = shardIds()
  const rows = await readRows(ids)
  console.log(`кадров в шарде: ${ids.size}, размечено в csv: ${rows.length}`)

  const byCountry = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = byCountry.get(row.country)
    if (bucket) bucket.push(row)
    else byCountry.set(row.country, [row])
  }

  // Плотность: страны ранжируются по числу доступных кадров.
  // Ничья разрешается по коду страны, чтобы отбор был воспроизводим.
  const ranked = [...byCountry.entries()]
    .filter(([, bucket]) => bucket.length >= FRAMES_PER_COUNTRY)
    .sort(([ac, a], [bc, b]) => b.length - a.length || (ac < bc ? -1 : 1))
    .map(([country]) => country)

  const needed = MAIN_COUNTRIES + HELDOUT_B_COUNTRIES
  if (ranked.length < needed) {
    throw new Error(`стран с ${FRAMES_PER_COUNTRY}+ кадрами всего ${ranked.length}, нужно ${needed}`)
  }
  const mainCountries = ranked.slice(0, MAIN_COUNTRIES)
  const heldoutBCountries = ranked.slice(MAIN_COUNTRIES, needed)

  const rnd = mulberry32(SEED)
  const tasks: Task[] = []
  const toTask = (row: Row, split: Task['split']): Task => ({
    id: row.id,
    imagePath: `${IMAGES_DIR}/${row.id}.jpg`,
    truth: { lat: row.lat, lon: row.lon, country: row.country },
    split,
  })

  for (const country of mainCountries) {
    const groups = sequenceGroups(byCountry.get(country)!, rnd)
    const a = take(groups, HELDOUT_A_PER_COUNTRY, 0)
    const train = take(groups, FRAMES_PER_COUNTRY - HELDOUT_A_PER_COUNTRY, a.next)
    for (const row of a.rows) tasks.push(toTask(row, 'heldout_a'))
    for (const row of train.rows) tasks.push(toTask(row, 'train'))
  }

  for (const country of heldoutBCountries) {
    const groups = sequenceGroups(byCountry.get(country)!, rnd)
    const b = take(groups, HELDOUT_B_FRAMES, 0)
    for (const row of b.rows) tasks.push(toTask(row, 'heldout_b'))
  }

  // Порядок задач фиксирован: требование детерминизма замера.
  tasks.sort((x, y) => (x.split < y.split ? -1 : x.split > y.split ? 1 : x.id < y.id ? -1 : 1))

  mkdirSync(dirname(config.paths.tasks), { recursive: true })
  writeFileSync(config.paths.tasks, tasks.map((t) => JSON.stringify(t)).join('\n') + '\n')

  // Из шарда распаковываются только отобранные кадры: остальные 2 ГБ не нужны.
  mkdirSync(IMAGES_DIR, { recursive: true })
  const missing = tasks.filter((t) => !existsSync(t.imagePath)).map((t) => `00/${t.id}.jpg`)
  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i += 200) {
      execFileSync('unzip', ['-j', '-o', '-q', SHARD_ZIP, ...missing.slice(i, i + 200), '-d', IMAGES_DIR])
    }
  }

  const counts = { train: 0, heldout_a: 0, heldout_b: 0 }
  for (const t of tasks) counts[t.split]++
  console.log(`страны потока: ${mainCountries.join(' ')}`)
  console.log(`страны heldout_b: ${heldoutBCountries.join(' ')}`)
  console.log(`задач: ${tasks.length} (train ${counts.train}, heldout_a ${counts.heldout_a}, heldout_b ${counts.heldout_b})`)
  console.log(`распаковано кадров: ${missing.length}`)
  console.log(`записано: ${config.paths.tasks}`)
}

void main()
