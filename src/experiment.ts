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

import { createClient } from "@arizeai/phoenix-client";
import { createDataset, getDatasetInfo } from "@arizeai/phoenix-client/datasets";
import {
  resumeEvaluation,
  resumeExperiment,
  runExperiment,
} from "@arizeai/phoenix-client/experiments";
import { MODEL, provider } from "./agent.ts";
import { geoEvaluators } from "./evaluators.ts";
import { DEFAULT_MANIFEST, loadFrozenSample } from "./manifest.ts";
import { readFile } from "node:fs/promises";
import { RECALL_LIMIT } from "./memory/memory.ts";
import { parseRecallMode } from "./memory/file/memory.ts";
import { parseBackend, selectMemory } from "./memory/select.ts";
import { fingerprintOf, loadLabels } from "./osv5m.ts";
import { runTask } from "./task.ts";
import type { ExampleInput } from "./task.ts";

const PHOENIX_URL = process.env.PHOENIX_BASE_URL ?? "http://localhost:6006";

// `phoenix-client` uploads each evaluation score without awaiting the POST and
// without catching it ("We log this without awaiting", runExperiment.js). A refused
// connection therefore arrives as an unhandled rejection and ends the process after
// every model call is paid for. Count those instead. The summary below reports what
// the server is missing, and the next run under the same name writes it. A rejection
// from this script's own top-level await does not pass through here: Node reports
// that one itself.
let droppedUploads = 0;
process.on("unhandledRejection", (reason) => {
  droppedUploads += 1;
  if (droppedUploads <= 3) {
    console.warn(`upload dropped: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
});

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

/**
 * Score exactly the ids listed in a file, ignoring the rest of the manifest.
 *
 * For filling a hole rather than running a benchmark. A run that lost frames to
 * provider quota records them as completed with a failure payload, and Phoenix will
 * not re-run a completed run - deleting one is not allowed either. The frames are
 * therefore re-scored beside the original run and merged when the numbers are read.
 * Like any partial pass this gets its own fingerprint: it is a fill, and calling it
 * the corpus would be a lie.
 */
const idsFile = flag("ids", "");

const { rows: pool, csvRowCount } = await loadLabels();
const full = await loadFrozenSample(pool, manifestPath, "eval");
const wanted =
  idsFile === ""
    ? null
    : new Set(
        (await readFile(idsFile, "utf8"))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#")),
      );

const selected =
  wanted === null
    ? full
    : (() => {
        const rows = full.rows.filter((row) => wanted.has(row.id));
        if (rows.length !== wanted.size) {
          throw new Error(
            `${idsFile} lists ${wanted.size} ids, ${rows.length} of them are in the corpus`,
          );
        }
        return {
          ...full,
          rows,
          fingerprint: fingerprintOf(rows.map((row) => row.id)),
          strata: new Set(rows.map((row) => row.cell)).size,
        };
      })();

const sample =
  head > 0 && head < selected.rows.length
    ? {
        ...selected,
        rows: selected.rows.slice(0, head),
        fingerprint: fingerprintOf(selected.rows.slice(0, head).map((row) => row.id)),
        strata: new Set(selected.rows.slice(0, head).map((row) => row.cell)).size,
      }
    : selected;
const seed = sample.seed;

if (wanted !== null) {
  console.log(`ids     ${sample.rows.length} frames from ${idsFile}, fp=${sample.fingerprint}`);
} else if (sample !== full) {
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
        `frame was approved by a person, who dropped every frame showing a burned-in ` +
        `coordinate. The ` +
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

const client = createClient();

const experimentMetadata = {
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
};

const task = (example: { input: unknown }) =>
  runTask(example.input as ExampleInput, { memory, twoStep });

/** The experiment of this dataset that carries this name, or null. */
async function findExperiment(
  name: string,
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  let cursor: string | undefined;
  do {
    const page = await client.GET("/v1/datasets/{dataset_id}/experiments", {
      params: { path: { dataset_id: datasetId }, query: { cursor, limit: 50 } },
    });
    const entries = page.data?.data;
    if (!entries) throw new Error(`cannot list the experiments of dataset ${datasetId}`);
    const hit = entries.find((entry) => entry.name === name);
    if (hit) return { id: hit.id, metadata: hit.metadata };
    cursor = page.data?.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return null;
}

// A run that dies half way leaves its finished items on the server, and those items
// are the part that cost provider quota. Reusing the name continues that experiment:
// only missing runs are executed, and only missing scores are written. A name this
// dataset has not seen starts a new experiment.
const existing = await findExperiment(label);
let experimentId: string;

if (existing === null) {
  experimentId = (
    await runExperiment({
      client,
      dataset: { datasetId },
      experimentName: label,
      experimentMetadata,
      task,
      evaluators: geoEvaluators,
      concurrency,
    })
  ).id;
} else {
  // One name, two configurations would put both under a single experiment, and no
  // reader could tell which half produced which number.
  const changed = Object.keys(experimentMetadata).filter((key) => {
    const wanted = experimentMetadata[key as keyof typeof experimentMetadata];
    return JSON.stringify(existing.metadata[key]) !== JSON.stringify(wanted);
  });
  if (changed.length > 0) {
    const differences = changed
      .map((key) => {
        const wanted = experimentMetadata[key as keyof typeof experimentMetadata];
        return `${key} ${JSON.stringify(existing.metadata[key])} -> ${JSON.stringify(wanted)}`;
      })
      .join(", ");
    throw new Error(
      `experiment "${label}" exists with other settings: ${differences}. Repeat the ` +
        `original flags to resume it, or pass another --name.`,
    );
  }
  experimentId = existing.id;
  console.log(`experiment resumed: ${label} (${experimentId})`);
  await resumeExperiment({ client, experimentId, task, concurrency });
  await resumeEvaluation({ client, experimentId, evaluators: geoEvaluators, concurrency });
}

// ---- aggregate ----------------------------------------------------------------

/**
 * One run as the server stores it. The summary is read back from Phoenix instead of
 * taken from what this process holds: scores are uploaded one at a time, so a dropped
 * upload leaves a gap that only the server can report, and that gap is what the next
 * run under the same name repairs.
 */
type ExportedRun = {
  output: unknown;
  error: string | null;
  annotations?: { name: string; score?: number | null }[] | null;
};

const exported = await client.GET("/v1/experiments/{experiment_id}/json", {
  params: { path: { experiment_id: experimentId } },
});
// The OpenAPI document declares this endpoint `text/plain` and the server answers
// with `application/json`, so the parsed body does not match the generated type.
const report = exported.data as unknown as ExportedRun[] | undefined;
if (!report) throw new Error(`cannot read the runs of experiment ${experimentId}`);

const scoresByMetric = new Map<string, number[]>();
let scored = 0;
for (const run of report) {
  for (const annotation of run.annotations ?? []) {
    scored += 1;
    if (typeof annotation.score !== "number") continue;
    const bucket = scoresByMetric.get(annotation.name);
    if (bucket) bucket.push(annotation.score);
    else scoresByMetric.set(annotation.name, [annotation.score]);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? Number.NaN;
}

const errored = report.filter((run) => run.error !== null).length;

console.log(`\nexperiment ${experimentId} | ${report.length} runs | ${errored} task errors`);
console.log(`${PHOENIX_URL}/datasets/${datasetId}/experiments\n`);

if (droppedUploads > 0) {
  console.log(`dropped  ${droppedUploads} uploads to Phoenix`);
}
const expected = report.length * geoEvaluators.length;
if (scored < expected) {
  console.log(`scores   ${scored}/${expected} on the server, run --name ${label} again\n`);
}

// Which provider actually served each item. With a fallback list this is no longer
// a constant, and a run split across providers is a run split across queues.
const providers = new Map<string, number>();
for (const run of report) {
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

// Spans are batched, so the last of them reach Phoenix only on shutdown.
await provider.shutdown();
