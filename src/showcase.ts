/**
 * Builds the demo dataset: 25 frames, every mode that has been run, one JSON file.
 *
 * The demo has to show the mechanism, not the average. Averages hide it - memory
 * costs 460 km of median and that number says nothing about why. A frame does: the
 * same picture answered without memory, with the filtered real lessons and with the
 * same lessons re-attached to the wrong places, side by side, with the exact text
 * that entered each prompt.
 *
 * Nothing here calls a model. Every mode is read out of `data/runs/`, so the file is
 * a re-cut of measurements already made, and re-running this script cannot move a
 * number.
 *
 * Usage:
 *   node src/showcase.ts [--ids benchmark/samples/showcase-25.txt] [--out demo/public]
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLabels } from "./osv5m.ts";
import type { Lesson } from "./memory/memory.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/** One line of an exported run. */
type RunRow = {
  id: string;
  country: string;
  lat?: number;
  lon?: number;
  place?: string;
  errorKm?: number;
  hintCount: number;
  hintIds: string[];
  provider?: string;
  failure?: string;
};

/**
 * A mode is a run file plus the lesson store whose ids its `hintIds` refer to.
 *
 * The pairing is not cosmetic. `lesson-0038` names Bavaria in the real store and
 * somewhere else entirely in the shuffled one, so resolving a hint against the wrong
 * file would print a shown lesson that was never shown.
 */
type Mode = {
  key: string;
  label: string;
  run: string;
  memory: string | null;
  /** Frames the run covers, for the summary denominator. */
  scope: string;
};

const MODES: readonly Mode[] = [
  { key: "baseline", label: "без памяти", run: "baseline-863", memory: null, scope: "863" },
  { key: "all73", label: "вся память, 73 урока", run: "memory-all-73-863", memory: "f6bf9c5ea31f", scope: "863" },
  { key: "top5", label: "top-5 без порога", run: "memory-top5-430", memory: "f6bf9c5ea31f", scope: "430" },
  { key: "threshold2", label: "top-5, порог 2", run: "memory-threshold2-430", memory: "f6bf9c5ea31f", scope: "430" },
  { key: "shuffled", label: "подменённые регионы", run: "shuffled-threshold2-430", memory: "939a81e8e4e4", scope: "430" },
  { key: "lessons25", label: "25 уроков, порог 2", run: "memory-threshold2-25lessons-showcase", memory: "0482aeccc48c", scope: "25" },
  { key: "lessons48", label: "48 уроков, порог 2", run: "memory-threshold2-48lessons-showcase", memory: "0e057cc9b952", scope: "25" },
];

const RUN_DIR = join("data", "runs");
const MEMORY_DIR = join("data", "memory");
const IMAGE_DIR = join("benchmark", "images", "eval");

async function readJsonl<T>(path: string): Promise<T[] | null> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Loads a run, merging its fill file when one exists.
 *
 * The 863-frame baseline lost 54 frames to provider quota and they were replayed
 * beside it. Reading only the main file would drop those frames from the demo
 * without saying so.
 */
async function loadRun(name: string): Promise<Map<string, RunRow> | null> {
  const main = await readJsonl<RunRow>(join(RUN_DIR, `${name}.jsonl`));
  if (!main) return null;
  const fill = (await readJsonl<RunRow>(join(RUN_DIR, `${name.replace(/-\d+$/, "")}-fill-54.jsonl`))) ?? [];
  const rows = new Map<string, RunRow>();
  for (const row of [...main, ...fill]) if (row.errorKm != null) rows.set(row.id, row);
  return rows;
}

const norm = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Whether a prediction landed inside a region some lesson names.
 *
 * This is the whole measurement of the menu effect, and it is deliberately a string
 * test rather than a geometric one: the claim is that the model repeats a name it was
 * shown, not that it lands within a polygon. Substring, because the model answers
 * "Nizhny Novgorod, Russia" where the lesson says "Russia".
 */
function makeRegionTest(lessons: readonly Lesson[]): (place: string | undefined) => boolean {
  const regions = [...new Set(lessons.map((lesson) => norm(lesson.region)))].filter((r) => r.length > 2);
  return (place) => {
    if (!place) return false;
    const target = norm(place);
    return regions.some((region) => target.includes(region));
  };
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length / 2;
  return sorted.length % 2 === 0
    ? ((sorted[half - 1] as number) + (sorted[half] as number)) / 2
    : (sorted[Math.floor(half)] as number);
};

/** The benchmark's own score: 5000 at zero error, halving roughly every 1000 km. */
const geoscore = (km: number): number => 5000 * Math.exp(-km / 1492.7);

async function main(): Promise<void> {
  const idsPath = flag("ids", join("benchmark", "samples", "showcase-25.txt"));
  const outDir = flag("out", join("demo", "public"));

  const ids = (await readFile(idsPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const { rows: pool } = await loadLabels();
  const labels = new Map(pool.map((row) => [row.id, row]));

  const stores = new Map<string, Lesson[]>();
  for (const mode of MODES) {
    if (mode.memory && !stores.has(mode.memory)) {
      stores.set(mode.memory, (await readJsonl<Lesson>(join(MEMORY_DIR, `${mode.memory}.jsonl`))) ?? []);
    }
  }

  // Attraction is always measured against the regions of the *real* 73, whichever
  // store a mode used. A mode that names fewer places has to be scored on the same
  // target set as one that names more, or the curve compares two different questions.
  const inLessonRegion = makeRegionTest(stores.get("f6bf9c5ea31f") ?? []);

  const runs = new Map<string, Map<string, RunRow>>();
  const missing: string[] = [];
  for (const mode of MODES) {
    const rows = await loadRun(mode.run);
    if (rows) runs.set(mode.key, rows);
    else missing.push(`${mode.key} (${mode.run}.jsonl)`);
  }

  const frames = [];
  for (const id of ids) {
    const label = labels.get(id);
    if (!label) throw new Error(`no label row for frame ${id}`);

    const modes: Record<string, unknown> = {};
    for (const mode of MODES) {
      const row = runs.get(mode.key)?.get(id);
      if (!row) continue;
      modes[mode.key] = {
        label: mode.label,
        snapshot: mode.memory,
        predicted: { lat: row.lat, lon: row.lon, place: row.place },
        errorKm: row.errorKm,
        geoscore: row.errorKm == null ? null : Number(geoscore(row.errorKm).toFixed(1)),
        inLessonRegion: inLessonRegion(row.place),
        hintCount: row.hintCount,
        // Ids, not texts. The whole-memory mode shows all 73 lessons on every frame,
        // so inlining them would repeat the store 25 times; `lessons` below holds one
        // copy per snapshot and a hint is resolved as lessons[snapshot][id].
        hintIds: row.hintIds,
        provider: row.provider ?? null,
      };
    }

    frames.push({
      id,
      image: `frames/${id}.jpg`,
      truth: {
        lat: label.latitude,
        lon: label.longitude,
        country: label.country,
        city: label.city ?? null,
        region: label.region ?? null,
        subRegion: label.subRegion ?? null,
      },
      modes,
    });
  }

  // Summary numbers are the corpus-wide ones, not the 25. Twenty-five frames chosen
  // to show a mechanism cannot also serve as its measurement, and a demo that quotes
  // the selection's own average would be quoting a number nobody should trust.
  const summary = [];
  for (const mode of MODES) {
    const rows = runs.get(mode.key);
    if (!rows) continue;
    const scored = [...rows.values()].filter((row) => row.errorKm != null);
    const errors = scored.map((row) => row.errorKm as number);
    const attracted = scored.filter((row) => inLessonRegion(row.place)).length;
    summary.push({
      key: mode.key,
      label: mode.label,
      snapshot: mode.memory,
      frames: scored.length,
      scope: mode.scope,
      medianKm: Number(median(errors).toFixed(1)),
      geoscore: Number((errors.reduce((sum, km) => sum + geoscore(km), 0) / errors.length).toFixed(1)),
      attraction: Number((attracted / scored.length).toFixed(3)),
      hintedFrames: scored.filter((row) => row.hintCount > 0).length,
    });
  }

  await mkdir(join(outDir, "frames"), { recursive: true });
  for (const id of ids) {
    await copyFile(join(IMAGE_DIR, `${id}.jpg`), join(outDir, "frames", `${id}.jpg`));
  }

  // One copy of every store a mode used, so a hint id can be resolved to its text.
  const lessons: Record<string, Record<string, unknown>> = {};
  for (const [snapshot, store] of stores) {
    lessons[snapshot] = Object.fromEntries(
      store.map((lesson) => [
        lesson.id,
        { region: lesson.region, text: lesson.content, triggers: lesson.triggers },
      ]),
    );
  }

  const payload = {
    corpus: "osv5m-v4-eval",
    model: process.env.GEOLOCATE_MODEL ?? "google/gemma-4-31b-it",
    note:
      "Сводные числа посчитаны по полному прогону каждого режима, не по этим 25 кадрам. " +
      "Притяжение - доля предсказаний, попавших в один из 61 региона, названного уроками.",
    summary,
    lessons,
    frames,
  };
  await writeFile(join(outDir, "showcase.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`frames   ${frames.length} -> ${join(outDir, "showcase.json")}`);
  console.log(`images   ${ids.length} -> ${join(outDir, "frames")}`);
  console.log(`modes    ${summary.map((s) => s.key).join(", ")}`);
  if (missing.length > 0) console.log(`absent   ${missing.join(", ")}`);
}

await main();
