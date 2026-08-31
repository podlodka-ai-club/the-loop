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
import {
  createFrozenMemorySnapshotBinding,
  createMemorySourceBinding,
  createMemorySourceResolver,
  createNoopMemoryBinding,
  RECALL_LIMIT,
  resolveMemoryBinding,
} from "./memory/memory.ts";
import { FileMemory, parseRecallMode } from "./memory/file/memory.ts";
import { loadCsvRows, loadRows } from "./osv5m.ts";
import { runTrainingTaskWithRuntime } from "./task-runtime.internal.ts";
import type { MemoryRunConfig } from "./tools/memory.ts";
import { parseBenchmarkMemoryMode } from "./benchmark-metrics.ts";
import { selectTrainingSample } from "./train-selection.ts";
import { parsePositiveSafeIntegerOption, readCliOption } from "./cli-options.ts";

const limit = parsePositiveSafeIntegerOption("limit", readCliOption("limit", "30"));
const snapshotEvery = parsePositiveSafeIntegerOption("snapshot-every", readCliOption("snapshot-every", "10"));
const seed = readCliOption("seed", "train-v1");
const memoryMode = parseBenchmarkMemoryMode(readCliOption("memory-mode", "warm"));
const recallMode = parseRecallMode(readCliOption("recall", memoryMode === "cold" ? "off" : "top"));
if (memoryMode === "cold" && recallMode !== "off") {
  throw new Error("cold training requires --recall off");
}
if (memoryMode === "warm" && recallMode !== "top") {
  throw new Error("warm training requires --recall top");
}

const [{ rows: pool }, { rows: metadataRows }] = await Promise.all([loadRows(), loadCsvRows()]);
const manifest = await readManifest(readCliOption("manifest", DEFAULT_MANIFEST));

const matchManifest = !process.argv.includes("--no-match-manifest");

/**
 * Restrict the draw to these countries, keeping their manifest quotas.
 *
 * Used to top up a store after a run came up short: the local shard holds only part
 * of the split, so some quotas cannot be filled until more images are unpacked.
 * Re-running the whole stream to add the missing few would pay for every attempt
 * again.
 */
const onlyCountries = new Set(
  readCliOption("only", "")
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== ""),
);

const selection = selectTrainingSample(pool, manifest, {
  limit,
  seed,
  matchManifest,
  metadataRows,
  onlyCountries,
});
const { trainPool, sample } = selection;
if (matchManifest) {
  console.log(`quotas   ${selection.quotas.size} countries matched to the eval manifest`);
  if (selection.shortfalls.length > 0) {
    console.log(`short    train pool could not fill: ${selection.shortfalls.join(", ")}`);
  }
}
const memory = new FileMemory(undefined, recallMode);
const run = {
  memoryRef: memoryMode === "cold" || recallMode === "off" ? null : "file",
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: RECALL_LIMIT,
} satisfies MemoryRunConfig;
const memoryBinding = run.memoryRef === null
  ? createNoopMemoryBinding({ mode: "training", snapshotId: null })
  : await resolveMemoryBinding(run, createMemorySourceResolver(createMemorySourceBinding({
      memoryRef: "file",
      memory,
      provider: "file",
      loadSnapshot: async (snapshotId) => createFrozenMemorySnapshotBinding({
        memoryRef: "file",
        snapshotId,
        reader: await memory.loadSnapshot!(snapshotId),
      }),
    })));

console.log(`pool     ${trainPool.length} train-eligible of ${pool.length} on disk`);
console.log(`sample   n=${sample.rows.length} seed=${seed} fp=${sample.fingerprint}`);
console.log(`mode     ${memoryMode} training stream, observations use the versioned image cache`);
if (run.memoryRef === null) {
  console.log("memory   off (no memory reads, writes or snapshots)");
} else {
  console.log(
    `memory   ${memory.path}, ${await memory.size()} lessons, ` +
      `recall ${recallMode} (limit ${RECALL_LIMIT} applies to top only)`,
  );
}

let learned = 0;
let refused = 0;
const distances: number[] = [];

for (const [index, row] of sample.rows.entries()) {
  const attemptId = `${seed}:${row.id}`;
  const result = await runTrainingTaskWithRuntime({
    imageId: row.id,
    imagePath: row.imagePath,
    attemptId,
    truth: { latitude: row.latitude, longitude: row.longitude, country: row.country },
  }, {
    memoryBinding,
    run,
  });

  if (result.ok) {
    const distanceKm = haversineKm(result.guess, {
      latitude: row.latitude,
      longitude: row.longitude,
    });
    distances.push(distanceKm);
    console.log(
      `[${index + 1}/${sample.rows.length}] ${row.id} ${row.country} -> ` +
        `${result.guess.place} ${distanceKm.toFixed(0)} km` +
        `${result.hintCount > 0 ? ` | ${result.hintCount} hints, ~${result.hintTokens} tok` : ""}` +
        `${result.episodes.length > 0 ? ` | ${result.episodes.length} episodes` : ""}`,
    );
    learned += result.episodes.filter((episode) =>
      episode.reflectionStatus === "stored" || episode.reflectionStatus === "already_stored"
    ).length;
    refused += result.episodes.filter((episode) => episode.reflectionStatus === "reflection_failed").length;
  } else {
    console.log(`[${index + 1}/${sample.rows.length}] ${row.id} FAILED ${result.failure}: ${result.message.slice(0, 120)}`);
    if (result.failure === "memory_not_found" || result.failure === "memory_mismatch" || result.failure === "unavailable" || result.failure === "timeout") {
      throw new Error(`training aborted after memory failure: ${result.failure}`);
    }
  }

  if (run.memoryRef !== null && (index + 1) % snapshotEvery === 0) {
    const id = await memory.snapshot();
    console.log(`         snapshot ${id}, ${await memory.size()} lessons`);
  }
}

const finalSnapshot = run.memoryRef === null ? null : await memory.snapshot();
const sorted = distances.slice().sort((a, b) => a - b);
const median = sorted.length === 0 ? Number.NaN : (sorted[sorted.length >> 1] ?? Number.NaN);

console.log("---");
console.log(`attempts scored   ${distances.length}/${sample.rows.length}`);
console.log(`median distance   ${median.toFixed(1)} km  (training stream, not a benchmark)`);
console.log(`lessons written   ${learned}, reflection produced nothing ${refused} times`);
if (run.memoryRef !== null) {
  console.log(`memory size       ${await memory.size()} lessons`);
  console.log(`final snapshot    ${finalSnapshot}`);
  console.log(`evaluate it with  npm run experiment -- --snapshot ${finalSnapshot} --concurrency 1`);
}
