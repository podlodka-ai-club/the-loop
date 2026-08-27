/**
 * The learning loop: run the agent over a training stream, and after every attempt
 * ask it to write down what it should have noticed.
 *
 * Usage:
 *   node src/train.ts [--limit 30] [--snapshot-every 10] [--seed train-v1]
 *
 * The training pool excludes every image in the frozen evaluation manifest, and
 * every image sharing a `sequence` with one. A sequence is one drive down one road,
 * so a neighbouring frame is the same place from a metre further along - training on
 * it would be training on the eval set.
 */
import { readManifest, DEFAULT_MANIFEST } from "./manifest.ts";
import { haversineKm } from "./geo.ts";
import { FileMemory, RECALL_LIMIT, parseRecallMode } from "./memory.ts";
import { drawSample, fingerprintOf, loadRows } from "./osv5m.ts";
import type { Row } from "./osv5m.ts";
import { reflect } from "./reflect.ts";
import { runTask } from "./task.ts";
import type { ExampleInput } from "./task.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const limit = Number(flag("limit", "30"));
const snapshotEvery = Number(flag("snapshot-every", "10"));
const seed = flag("seed", "train-v1");
const recallMode = parseRecallMode(flag("recall", "all"));

const { rows: pool } = await loadRows();
const manifest = await readManifest(flag("manifest", DEFAULT_MANIFEST));

const evalIds = new Set(manifest.ids);
const evalSequences = new Set(
  pool.filter((row) => evalIds.has(row.id)).map((row) => row.sequence).filter((s) => s !== ""),
);
const trainPool: Row[] = pool.filter(
  (row) => !evalIds.has(row.id) && !evalSequences.has(row.sequence),
);

/**
 * Country quotas copied from the evaluation manifest, by largest remainder.
 *
 * A dataset-weighted draw would track the whole OSV-5M split, not the 200 frames the
 * benchmark actually scores. Those differ: the manifest is 72 countries with a long
 * tail of single frames. Lessons about countries the benchmark never shows cannot
 * move the number, they only add tokens - which is exactly what the shuffled control
 * is meant to isolate, so it must not be what the real run is doing too.
 */
function manifestQuotas(evalRows: readonly Row[], total: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of evalRows) {
    if (row.country === "") continue;
    counts.set(row.country, (counts.get(row.country) ?? 0) + 1);
  }
  const denominator = [...counts.values()].reduce((a, b) => a + b, 0);

  const exact = [...counts.entries()].map(([country, count]) => ({
    country,
    share: (count / denominator) * total,
  }));
  const quotas = new Map<string, number>();
  for (const { country, share } of exact) quotas.set(country, Math.floor(share));

  // Hand the leftover slots to the largest fractional parts, ties by country code.
  let remaining = total - [...quotas.values()].reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((entry) => ({ ...entry, fraction: entry.share - Math.floor(entry.share) }))
    .sort((a, b) => b.fraction - a.fraction || (a.country < b.country ? -1 : 1));
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    quotas.set(entry.country, (quotas.get(entry.country) ?? 0) + 1);
    remaining--;
  }
  return new Map([...quotas].filter(([, quota]) => quota > 0));
}

const matchManifest = !process.argv.includes("--no-match-manifest");

let sample: ReturnType<typeof drawSample>;
if (matchManifest) {
  const evalRows = pool.filter((row) => evalIds.has(row.id));
  const quotas = manifestQuotas(evalRows, limit);
  const picked: Row[] = [];
  const shortfalls: string[] = [];
  for (const [country, quota] of [...quotas].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const byCountry = trainPool.filter((row) => row.country === country);
    const drawn = drawSample(byCountry, { size: quota, seed: `${seed}:${country}` });
    picked.push(...drawn.rows);
    if (drawn.rows.length < quota) shortfalls.push(`${country} ${drawn.rows.length}/${quota}`);
  }
  picked.sort((a, b) => (a.id < b.id ? -1 : 1));
  sample = {
    rows: picked,
    fingerprint: fingerprintOf(picked.map((row) => row.id)),
    seed,
    strata: new Set(picked.map((row) => row.cell)).size,
  };
  console.log(`quotas   ${quotas.size} countries matched to the eval manifest`);
  if (shortfalls.length > 0) {
    console.log(`short    train pool could not fill: ${shortfalls.join(", ")}`);
  }
} else {
  sample = drawSample(trainPool, { size: limit, seed });
}
const memory = new FileMemory(undefined, recallMode);

console.log(`pool     ${trainPool.length} train-eligible of ${pool.length} on disk`);
console.log(`sample   n=${sample.rows.length} seed=${seed} fp=${sample.fingerprint}`);
console.log(
  `memory   ${memory.path}, ${await memory.size()} lessons, ` +
    `recall ${recallMode} (limit ${RECALL_LIMIT} applies to top only)`,
);

let learned = 0;
let refused = 0;
const distances: number[] = [];

for (const [index, row] of sample.rows.entries()) {
  const attemptId = `${seed}:${row.id}`;
  const input: ExampleInput = { imageId: row.id, imagePath: row.imagePath };

  const result = await runTask(input, {
    memory,
    learn: async (guess) => {
      const distanceKm = haversineKm(guess, {
        latitude: row.latitude,
        longitude: row.longitude,
      });
      distances.push(distanceKm);

      const lesson = await reflect({
        attemptId,
        imagePath: row.imagePath,
        guess: { latitude: guess.latitude, longitude: guess.longitude, place: guess.place },
        truth: { latitude: row.latitude, longitude: row.longitude, country: row.country },
        distanceKm,
      });

      if (lesson === null) {
        refused++;
        return;
      }
      await memory.remember(lesson);
      learned++;
    },
  });

  if (result.ok) {
    const distanceKm = distances[distances.length - 1] ?? Number.NaN;
    console.log(
      `[${index + 1}/${sample.rows.length}] ${row.id} ${row.country} -> ` +
        `${result.guess.place} ${distanceKm.toFixed(0)} km` +
        `${result.hintCount > 0 ? ` | ${result.hintCount} hints, ~${result.hintTokens} tok` : ""}`,
    );
  } else {
    console.log(`[${index + 1}/${sample.rows.length}] ${row.id} FAILED ${result.failure}: ${result.message.slice(0, 120)}`);
  }

  if ((index + 1) % snapshotEvery === 0) {
    const id = await memory.snapshot();
    console.log(`         snapshot ${id}, ${await memory.size()} lessons`);
  }
}

const finalSnapshot = await memory.snapshot();
const sorted = distances.slice().sort((a, b) => a - b);
const median = sorted.length === 0 ? Number.NaN : (sorted[sorted.length >> 1] ?? Number.NaN);

console.log("---");
console.log(`attempts scored   ${distances.length}/${sample.rows.length}`);
console.log(`median distance   ${median.toFixed(1)} km  (training stream, not a benchmark)`);
console.log(`lessons written   ${learned}, reflection produced nothing ${refused} times`);
console.log(`memory size       ${await memory.size()} lessons`);
console.log(`final snapshot    ${finalSnapshot}`);
console.log(`evaluate it with  npm run experiment -- --snapshot ${finalSnapshot} --concurrency 1`);
