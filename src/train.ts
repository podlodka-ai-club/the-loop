/**
 * The learning loop: run the agent over a training stream, and after every attempt
 * ask it to write down what it should have noticed.
 *
 * Usage:
 *   node src/train.ts [--limit 0] [--snapshot-every 10] [--two-step]
 *
 * The training stream is the frozen train corpus, not a draw made here. Holding the
 * two corpora apart is a property of the corpora, so it is decided once at freeze
 * time and recorded in the manifests: the train corpus shares no id, no `sequence`,
 * no uploader and no 25 km grid cell with the eval corpus. Drawing here instead
 * would re-derive that separation on every run, from whatever shards this machine
 * happens to hold.
 *
 * This replaced a run-time draw that copied country quotas off the eval manifest. The
 * requirement behind those quotas still holds and is now met earlier: a lesson about a
 * country the benchmark never shows cannot move the number, it only adds tokens, which
 * is exactly what the shuffled control is meant to isolate. `src/split.ts` gives the two
 * corpora matching country shares at freeze time, and `npm run sample` prints the gap
 * next to the smallest gap the pool allows, so the property is checked rather than
 * re-approximated per run.
 */
import { provider } from "./agent.ts";
import { DEFAULT_TRAIN_MANIFEST, loadFrozenSample } from "./manifest.ts";
import { haversineKm } from "./geo.ts";
import { RECALL_LIMIT } from "./memory/memory.ts";
import { FileMemory, parseRecallMode } from "./memory/file/memory.ts";
import { loadRows } from "./osv5m.ts";
import { reflect } from "./reflect.ts";
import { runTask } from "./task.ts";
import type { ExampleInput } from "./task.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

// 0 means the whole corpus. A smaller number takes a prefix, which is a shorter run
// over the same frozen items, not a different draw.
const limit = Number(flag("limit", "0"));
const snapshotEvery = Number(flag("snapshot-every", "10"));
const recallMode = parseRecallMode(flag("recall", "all"));
const twoStep = process.argv.includes("--two-step");

const { rows: pool } = await loadRows();
const corpus = await loadFrozenSample(pool, flag("manifest", DEFAULT_TRAIN_MANIFEST), "train");
const rows = limit > 0 ? corpus.rows.slice(0, limit) : corpus.rows;

const memory = new FileMemory(undefined, recallMode);

console.log(`corpus   train n=${corpus.rows.length} fp=${corpus.fingerprint} seed=${corpus.seed}`);
console.log(`stream   ${rows.length} of ${corpus.rows.length}${limit > 0 ? " (--limit prefix)" : ""}`);
console.log(
  `memory   ${memory.path}, ${await memory.size()} lessons, ` +
    `recall ${recallMode} (limit ${RECALL_LIMIT} applies to top only)`,
);

let learned = 0;
let refused = 0;
const distances: number[] = [];

for (const [index, row] of rows.entries()) {
  const attemptId = `${corpus.seed}:${row.id}`;
  const input: ExampleInput = { imageId: row.id, imagePath: row.imagePath };

  const result = await runTask(input, {
    memory,
    twoStep,
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
      `[${index + 1}/${rows.length}] ${row.id} ${row.country} -> ` +
        `${result.guess.place} ${distanceKm.toFixed(0)} km` +
        `${result.hintCount > 0 ? ` | ${result.hintCount} hints, ~${result.hintTokens} tok` : ""}`,
    );
  } else {
    console.log(`[${index + 1}/${rows.length}] ${row.id} FAILED ${result.failure}: ${result.message.slice(0, 120)}`);
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
console.log(`attempts scored   ${distances.length}/${rows.length}`);
console.log(`median distance   ${median.toFixed(1)} km  (training stream, not a benchmark)`);
console.log(`lessons written   ${learned}, reflection produced nothing ${refused} times`);
console.log(`memory size       ${await memory.size()} lessons`);
console.log(`final snapshot    ${finalSnapshot}`);
console.log(`evaluate it with  npm run experiment -- --snapshot ${finalSnapshot} --concurrency 1`);

// Spans are batched, so the last of them reach Phoenix only on shutdown.
await provider.shutdown();
