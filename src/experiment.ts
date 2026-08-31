/**
 * Runs one OSV-5M evaluation as a Phoenix experiment.
 *
 * Usage:
 *   node src/experiment.ts [--manifest PATH] [--concurrency 8] [--name label]
 *                          [--backend file|mem0] [--snapshot ID] [--recall all]
 *                          [--head N] [--two-step]
 */

// Long base64 image payloads would otherwise land in `input.value` on every span.
// Truncating attribute values keeps every human-readable field intact while capping
// per-run storage. Set it before any OpenTelemetry module reads span limits.
process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT ??= "2000";

import { createDataset, getDatasetInfo } from "@arizeai/phoenix-client/datasets";
import { runExperiment } from "@arizeai/phoenix-client/experiments";
import { MODEL } from "./agent.ts";
import { geoEvaluators } from "./evaluators.ts";
import { DEFAULT_MANIFEST, loadFrozenSample } from "./manifest.ts";
import { RECALL_LIMIT } from "./memory/memory.ts";
import { parseRecallMode } from "./memory/file/memory.ts";
import { parseBackend, selectMemory } from "./memory/select.ts";
import { fingerprintOf, loadRows } from "./osv5m.ts";
import { runTask } from "./task.ts";
import type { ExampleInput } from "./task.ts";

const PHOENIX_URL = process.env.PHOENIX_BASE_URL ?? "http://localhost:6006";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const manifestPath = flag("manifest", DEFAULT_MANIFEST);
const concurrency = Number(flag("concurrency", "8"));
const label = flag("name", `${MODEL}-${new Date().toISOString().slice(0, 16)}`);

// Memory is read-only here on purpose. Evaluation that writes lessons is training
// with extra steps, and the held-out numbers stop meaning anything.
const snapshotId = flag("snapshot", "");
const recallMode = parseRecallMode(flag("recall", "all"));

// Two-step costs a second vision call per item. It is pointless without memory, and
// mandatory with a ranked or query-based backend, which has nothing to rank on
// otherwise.
const twoStep = process.argv.includes("--two-step");
const backend = parseBackend(flag("backend", "file"));
const selection = selectMemory({ backend, snapshotId, recall: flag("recall", "all") });
const memory = selection.memory;

// The sample is read from a file in the repository, never drawn afresh. `loadRows`
// sees only the image shards this machine holds, so a fresh draw would silently
// score a different set of images here than it did on the machine that reported the
// baseline. Freeze a new sample with `node src/sample.ts --freeze`.
/**
 * Score only the first N ids of the manifest instead of all of them.
 *
 * The eval corpus is 863 frames, and a full pass costs hours of provider quota once
 * rate-limit backoff is counted. A prefix is enough to read the sign and the order of a
 * delta, which is what decides whether the full pass is worth running at all. The prefix
 * is the manifest's own sorted order, so it is the same frames every time, and it gets
 * its own fingerprint - a partial run is a different benchmark and must never be filed
 * under the full one's numbers.
 *
 * A prefix is not a smaller balanced corpus. The manifest is sorted by id, and id order
 * has nothing to do with country, so the country match with the train corpus holds for
 * the whole file and not for a prefix of it.
 */
const head = Number(flag("head", "0"));

const { rows: pool, csvRowCount } = await loadRows();
const full = await loadFrozenSample(pool, manifestPath, "eval");
const sample =
  head > 0 && head < full.rows.length
    ? {
        ...full,
        rows: full.rows.slice(0, head),
        fingerprint: fingerprintOf(full.rows.slice(0, head).map((row) => row.id)),
        strata: new Set(full.rows.slice(0, head).map((row) => row.cell)).size,
      }
    : full;
const seed = sample.seed;

if (sample !== full) {
  console.log(`head    first ${sample.rows.length} of ${full.rows.length} manifest ids`);
}

console.log(
  `pool ${pool.length}/${csvRowCount} on disk | sample n=${sample.rows.length} ` +
    `strata=${sample.strata} seed=${sample.seed} fp=${sample.fingerprint}`,
);
console.log(
  `memory  ${selection.describe}${twoStep ? ", two-step (observe then guess)" : ""}` +
    `${selection.frozen ? "" : " [not frozen: reproducible only by convention]"}`,
);

const datasetName = `osv5m-${seed}-n${sample.rows.length}-${sample.fingerprint}`;

// Reuse the frozen set when it already exists, so every run scores the same items.
let datasetId: string;
try {
  datasetId = (await getDatasetInfo({ dataset: { datasetName } })).id;
  console.log(`dataset reused: ${datasetName}`);
} catch {
  datasetId = (
    await createDataset({
      name: datasetName,
      description:
        `OSV-5M test corpus. seed=${seed} n=${sample.rows.length} ` +
        `fingerprint=${sample.fingerprint}. Frozen id list from ${manifestPath}. Every ` +
        `frame was approved by a person and passed the burned-in coordinate screen. The ` +
        `pool of approved frames is cut into this corpus and its train counterpart so ` +
        `that the two match country by country and share no sequence, uploader or 25 km ` +
        `grid cell. Frames are used whole: nothing is cropped.`,
      examples: sample.rows.map((row) => ({
        id: row.id,
        input: {
          imageId: row.id,
          imagePath: row.imagePath,
        } satisfies ExampleInput,
        output: {
          latitude: row.latitude,
          longitude: row.longitude,
          country: row.country,
        },
        metadata: {
          cell: row.cell,
          sequence: row.sequence,
          creator: row.creator,
          capturedAt: row.capturedAt,
          region: row.region,
          subRegion: row.subRegion,
          city: row.city,
        },
      })),
    })
  ).datasetId;
  console.log(`dataset created: ${datasetName}`);
}

const experiment = await runExperiment({
  dataset: { datasetId },
  experimentName: label,
  experimentMetadata: {
    model: MODEL,
    seed,
    fingerprint: sample.fingerprint,
    sampleSize: sample.rows.length,
    memoryBackend: backend,
    memorySnapshot: snapshotId === "" ? "none" : snapshotId,
    memoryFrozen: selection.frozen,
    recallMode: snapshotId === "" ? "off" : recallMode,
    twoStep,
    recallLimit: RECALL_LIMIT,
  },
  task: (example) => runTask(example.input as ExampleInput, { memory, twoStep }),
  evaluators: geoEvaluators,
  concurrency,
});

// ---- aggregate ----------------------------------------------------------------

const scoresByMetric = new Map<string, number[]>();
for (const run of experiment.evaluationRuns ?? []) {
  const value = run.result?.score;
  if (typeof value !== "number") continue;
  const bucket = scoresByMetric.get(run.name);
  if (bucket) bucket.push(value);
  else scoresByMetric.set(run.name, [value]);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? Number.NaN;
}

const runCount = Object.keys(experiment.runs).length;
const errored = Object.values(experiment.runs).filter((run) => run.error !== null).length;

console.log(`\nexperiment ${experiment.id} | ${runCount} runs | ${errored} task errors`);
console.log(`${PHOENIX_URL}/datasets/${datasetId}/experiments\n`);

// Which provider actually served each item. With a fallback list this is no longer
// a constant, and a run split across providers is a run split across queues.
const providers = new Map<string, number>();
for (const run of Object.values(experiment.runs)) {
  const output = run.output as { ok?: boolean; guess?: { provider?: string } } | null;
  const name = output?.ok === true ? (output.guess?.provider ?? "unknown") : "failed";
  providers.set(name, (providers.get(name) ?? 0) + 1);
}
console.log(
  `providers ${[...providers.entries()].map(([name, count]) => `${name}=${count}`).join(" ")}\n`,
);

const distances = (scoresByMetric.get("distance_km") ?? []).slice().sort((a, b) => a - b);
const mean = (values: number[]) =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

console.log(`metric                n      value`);
for (const name of [
  "geoscore",
  "acc_1km",
  "acc_25km",
  "acc_200km",
  "acc_750km",
  "acc_2500km",
  "valid_output",
  "degenerate_coords",
  "place_names_country",
  "suspected_leak",
  "hints_in_prompt",
  "hint_tokens",
  "features_observed",
]) {
  const values = scoresByMetric.get(name) ?? [];
  const value = mean(values);
  const asCount =
    name === "geoscore" ||
    name === "hints_in_prompt" ||
    name === "hint_tokens" ||
    name === "features_observed";
  const shown = asCount ? value.toFixed(1) : `${(value * 100).toFixed(1)}%`;
  console.log(`${name.padEnd(21)} ${String(values.length).padStart(4)}   ${shown}`);
}
console.log(`${"distance_km mean".padEnd(21)} ${String(distances.length).padStart(4)}   ${mean(distances).toFixed(1)} km`);
console.log(`${"distance_km median".padEnd(21)} ${String(distances.length).padStart(4)}   ${quantile(distances, 0.5).toFixed(1)} km`);
console.log(`${"distance_km p90".padEnd(21)} ${String(distances.length).padStart(4)}   ${quantile(distances, 0.9).toFixed(1)} km`);
