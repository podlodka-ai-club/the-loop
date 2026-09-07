/**
 * The learning loop: run the agent over a training stream, and after every attempt
 * ask it to write down what it should have noticed.
 *
 * Usage:
 *   node src/train.ts [--limit 30] [--snapshot-every 10] [--seed train-v1]
 *                     [--pool-manifest benchmark/samples/osv5m-v4-train.txt]
 *
 * `--pool-manifest` restricts the pool to the ids of a frozen train corpus, so two
 * machines holding different shards train on the same frames. Without it the pool is
 * every train-eligible frame on disk.
 *
 * The training pool excludes every image in the frozen evaluation manifest, and
 * every image sharing a `sequence` with one. A sequence is one drive down one road,
 * so a neighbouring frame is the same place from a metre further along - training on
 * it would be training on the eval set.
 */
import { readManifest, DEFAULT_MANIFEST, DEFAULT_TRAIN_MANIFEST } from "./manifest.ts";
import { haversineKm } from "./geo.ts";
import { framePath } from "./frames.ts";
import {
  createFrozenMemorySnapshotBinding,
  createMemorySourceBinding,
  createMemorySourceResolver,
  createNoopMemoryBinding,
  RECALL_LIMIT,
  resolveMemoryBinding,
} from "./memory/memory.ts";
import { FileMemory, parseRecallMode } from "./memory/file/memory.ts";
import { createMem0Memory, loadMem0MemoryConfig } from "./memory/mem0/memory.ts";
import { createMem0PlatformPort } from "./memory/mem0/platform.ts";
import { loadCsvRows, loadRows } from "./osv5m.ts";
import { runTrainingTaskWithRuntime } from "./task-runtime.internal.ts";
import type { MemoryRunConfig } from "./tools/memory.ts";
import { parseBenchmarkMemoryMode } from "./benchmark-metrics.ts";
import { selectTrainingSample } from "./train-selection.ts";
import { parsePositiveSafeIntegerOption, readCliOption } from "./cli-options.ts";
import { loadHindsightConfigFromEnv, parseBackend } from "./memory/select.ts";
import { createHindsightMemory } from "./memory/hindsight/memory.ts";
import { createXmemoryMemory, loadXmemoryMemoryConfig } from "./memory/xmemory/memory.ts";

const limit = parsePositiveSafeIntegerOption("limit", readCliOption("limit", "30"));
const snapshotEvery = parsePositiveSafeIntegerOption("snapshot-every", readCliOption("snapshot-every", "10"));
const seed = readCliOption("seed", "train-v1");
const memoryMode = parseBenchmarkMemoryMode(readCliOption("memory-mode", "warm"));
const recallMode = parseRecallMode(readCliOption("recall", memoryMode === "cold" ? "off" : "top"));
const backend = parseBackend(readCliOption("backend", "file"));
if (memoryMode === "cold" && recallMode !== "off") {
  throw new Error("cold training requires --recall off");
}
if (memoryMode === "warm" && recallMode !== "top") {
  throw new Error("warm training requires --recall top");
}

const [{ rows: diskPool }, { rows: metadataRows }] = await Promise.all([loadRows(), loadCsvRows()]);
const manifest = await readManifest(readCliOption("manifest", DEFAULT_MANIFEST));
const poolManifestPath = readCliOption("pool-manifest", "");
const poolManifest = poolManifestPath === "" ? null : await readManifest(poolManifestPath);
if (poolManifest !== null && poolManifest.role !== "train") {
  throw new Error(`--pool-manifest ${poolManifestPath} has role ${poolManifest.role}, expected train (see ${DEFAULT_TRAIN_MANIFEST})`);
}
const poolIds = poolManifest === null ? null : new Set(poolManifest.ids);
// A frozen train corpus is read from its committed frames, where review rotations are
// already applied, not from the raw shard the row was indexed in.
const pool = poolIds === null
  ? diskPool
  : diskPool
      .filter((row) => poolIds.has(row.id))
      .map((row) => ({ ...row, imagePath: framePath(poolManifest!.role, row.id) }));
if (poolIds !== null && pool.length < poolIds.size) {
  console.log(`pool     ${poolIds.size - pool.length} of ${poolIds.size} train manifest ids are not on disk`);
}

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
const fileMemory = backend === "file" ? new FileMemory(undefined, recallMode) : null;
const mem0Config = backend === "mem0" ? loadMem0MemoryConfig() : null;
const mem0Platform = mem0Config === null ? null : createMem0PlatformPort({ apiKey: mem0Config.apiKey });
const hindsightConfig = backend === "hindsight" ? loadHindsightConfigFromEnv() : null;
const xmemoryConfig = backend === "xmemory" ? loadXmemoryMemoryConfig() : null;
const memory = fileMemory
  ?? (mem0Config !== null
    ? createMem0Memory({ snapshots: false }, mem0Config, { platform: mem0Platform! })
    : hindsightConfig !== null
      ? createHindsightMemory({ snapshots: false }, hindsightConfig)
      : xmemoryConfig !== null
        ? await createXmemoryMemory({ snapshots: false }, xmemoryConfig)
        : null);
if (memory === null) throw new Error(`memory backend ${backend} could not be initialized`);
const run = {
  memoryRef: memoryMode === "cold" || recallMode === "off" ? null : backend,
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: RECALL_LIMIT,
} satisfies MemoryRunConfig;
const memoryBinding = run.memoryRef === null
  ? createNoopMemoryBinding({ mode: "training", snapshotId: null })
  : backend === "file"
    ? await resolveMemoryBinding(run, createMemorySourceResolver(createMemorySourceBinding({
        memoryRef: "file",
        memory: fileMemory!,
        provider: "file",
        loadSnapshot: async (snapshotId) => createFrozenMemorySnapshotBinding({
          memoryRef: "file",
          snapshotId,
          reader: await fileMemory!.loadSnapshot!(snapshotId),
        }),
      })))
    : await resolveMemoryBinding(run, createMemorySourceResolver(createMemorySourceBinding({
        memoryRef: backend,
        memory,
        provider: backend,
      })));

console.log(`pool     ${trainPool.length} train-eligible of ${pool.length} on disk`);
console.log(`sample   n=${sample.rows.length} seed=${seed} fp=${sample.fingerprint}`);
console.log(`mode     ${memoryMode} training stream, observations use the versioned image cache`);
console.log(`backend  ${backend}`);
if (run.memoryRef === null) {
  console.log("memory   off (no memory reads, writes or snapshots)");
} else if (backend === "mem0") {
  console.log(`memory   Mem0 agent ${mem0Config!.agentId}, recall ${recallMode}; hosted memory has no snapshots`);
} else if (backend === "hindsight") {
  console.log(`memory   Hindsight bank ${hindsightConfig!.source.bankId}, recall ${recallMode}; hosted memory has no snapshots`);
} else if (backend === "xmemory") {
  console.log(`memory   xmemory instance ${xmemoryConfig!.instanceId}, recall ${recallMode}; hosted memory has no snapshots`);
} else {
  console.log(
    `memory   ${fileMemory!.path}, ${await fileMemory!.size()} lessons, ` +
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

  if (run.memoryRef !== null && backend === "file" && (index + 1) % snapshotEvery === 0) {
    const id = await fileMemory!.snapshot();
    console.log(`         snapshot ${id}, ${await fileMemory!.size()} lessons`);
  }
}

const finalSnapshot = run.memoryRef !== null && backend === "file" ? await fileMemory!.snapshot() : null;
const sorted = distances.slice().sort((a, b) => a - b);
const median = sorted.length === 0 ? Number.NaN : (sorted[sorted.length >> 1] ?? Number.NaN);

console.log("---");
console.log(`attempts scored   ${distances.length}/${sample.rows.length}`);
console.log(`median distance   ${median.toFixed(1)} km  (training stream, not a benchmark)`);
console.log(`lessons written   ${learned}, reflection produced nothing ${refused} times`);
if (run.memoryRef !== null) {
  if (backend === "file") {
    console.log(`memory size       ${await fileMemory!.size()} lessons`);
    console.log(`final snapshot    ${finalSnapshot}`);
    console.log(`evaluate it with  npm run experiment -- --snapshot ${finalSnapshot} --concurrency 1`);
  } else if (backend === "mem0") {
    const records = await mem0Platform!.list(mem0Config!.agentId);
    console.log(`memory size       ${records.length} Mem0 records`);
    console.log("final snapshot    unavailable (Mem0 Cloud does not support snapshots)");
    console.log(`evaluate it with  npm run experiment -- --backend mem0 --snapshot mem0-${mem0Config!.agentId} --memory-mode warm --flow legacy --two-step --concurrency 1`);
  } else if (backend === "xmemory") {
    console.log("final snapshot    unavailable (xmemory Cloud does not support snapshots)");
    console.log(`evaluate it with  npm run experiment -- --flow feature-scoped --backend xmemory --snapshot xmemory-${xmemoryConfig!.instanceId} --memory-mode warm --concurrency 1`);
  } else {
    console.log("final snapshot    unavailable (Hindsight Cloud does not support snapshots)");
    console.log(`evaluate it with  npm run experiment -- --flow feature-scoped --backend hindsight --snapshot hindsight-${hindsightConfig!.source.bankId} --memory-mode warm --concurrency 1`);
  }
}
