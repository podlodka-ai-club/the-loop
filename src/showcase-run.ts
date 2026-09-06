/**
 * Scores the showcase frames against one memory snapshot and writes the run beside
 * the others in `data/runs/`.
 *
 * Why not `experiment.ts`. That path uploads to Phoenix, and the demo needs two runs
 * of twenty-five frames whose only consumer is a JSON file. Filing them as
 * experiments would put two twenty-five-frame runs next to the 863-frame corpus in
 * the same list, where the next person to read the numbers has to work out which is
 * which. These are a fill for a demo, not a benchmark, and they are kept out of the
 * experiment record on purpose.
 *
 * The frames are a hand-picked set, so nothing here is an average of anything. The
 * summary numbers the demo shows come from the full runs.
 *
 * Usage:
 *   node --env-file-if-exists=.env src/showcase-run.ts --snapshot ID --name LABEL
 *                                 [--ids benchmark/samples/showcase-25.txt] [--concurrency 4]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { haversineKm } from "./geo.ts";
import { loadLabels } from "./osv5m.ts";
import { FrozenMemory } from "./memory/file/memory.ts";
import { runTask } from "./task.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const snapshotId = flag("snapshot", "");
const label = flag("name", "");
const idsPath = flag("ids", join("benchmark", "samples", "showcase-25.txt"));
const concurrency = Number(flag("concurrency", "4"));
const recallLimit = Number(process.env.MEMORY_RECALL_LIMIT ?? "5");

if (snapshotId === "" || label === "") {
  throw new Error("--snapshot and --name are both required");
}

const ids = (await readFile(idsPath, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const { rows: pool } = await loadLabels();
const labels = new Map(pool.map((row) => [row.id, row]));

// Read-only, and ranked the same way the threshold run ranked: this exists to vary
// the size of the store and nothing else.
const memory = new FrozenMemory(snapshotId, "top");

type Line = {
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
  message?: string;
};

const lines: Line[] = [];
let done = 0;

async function score(id: string): Promise<void> {
  const truth = labels.get(id);
  if (!truth) throw new Error(`no label row for frame ${id}`);
  const result = await runTask(
    { imageId: id, imagePath: join("benchmark", "images", "eval", `${id}.jpg`) },
    { memory, twoStep: true, recallLimit },
  );

  const common = { id, country: truth.country, hintCount: result.hintCount, hintIds: result.hintIds };
  if (result.ok) {
    const errorKm = haversineKm(
      { latitude: truth.latitude, longitude: truth.longitude },
      { latitude: result.guess.latitude, longitude: result.guess.longitude },
    );
    lines.push({
      ...common,
      lat: result.guess.latitude,
      lon: result.guess.longitude,
      place: result.guess.place,
      errorKm: Number(errorKm.toFixed(3)),
      provider: result.guess.provider,
    });
  } else {
    // A frame that failed keeps its row. Dropping it would shrink the denominator
    // without saying so.
    lines.push({ ...common, failure: result.failure, message: result.message });
  }
  done++;
  process.stdout.write(`\r${done}/${ids.length}`);
}

const queue = [...ids];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await score(next);
  }),
);

lines.sort((a, b) => (a.id < b.id ? -1 : 1));
const out = join("data", "runs", `${label}.jsonl`);
await writeFile(out, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

const scored = lines.filter((line) => line.errorKm != null);
const hinted = scored.filter((line) => line.hintCount > 0).length;
console.log(`\nsnapshot ${snapshotId} | ${scored.length}/${ids.length} scored | ${hinted} with hints`);
console.log(`wrote    ${out}`);
