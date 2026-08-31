/**
 * Freezes, or verifies, the two benchmark corpora. Reads local files only, and
 * costs no API call.
 *
 * There are two corpora because the memory is distilled from one and measured on the
 * other. They must not overlap in any way that lets a lesson be about the very frame it
 * is later scored on, so they share no `id`, no `sequence`, no uploader and no 25 km grid
 * cell.
 *
 * ## The pool is what review kept
 *
 * Both corpora come out of `benchmark/samples/reviewed.txt` and nothing else. That list
 * is the set of frames a person has looked at and approved, so a frame nobody has judged
 * cannot reach a corpus. The alternative - draw from the whole split and subtract the
 * rejects - keeps every unreviewed frame, and the defect review exists to catch is
 * invisible to the automatic screen: OSV-5M bakes rotation into the pixels of a few
 * percent of its frames, and no pixel rule was accurate enough to act on.
 *
 * The pool is therefore finite and has no refill. That is the reason a defect found here
 * stops the freeze instead of quietly costing a candidate: with nothing to refill from,
 * skipping a frame would shrink the corpus and reshape the split, and the kept list would
 * no longer describe the corpus built from it. The fix is always the same, and it is
 * recorded rather than improvised: name the frame in `benchmark/samples/rejected.txt`.
 *
 * ## Leak control is the review, not a rule
 *
 * A frame whose burned-in strip spells out its own coordinates is not a geolocation
 * question, and such frames used to be caught here by an eight-pass OCR ensemble over the
 * bottom of every candidate. That pass is gone. Review looked at each frame in the pool
 * and dropped the ones that showed a readout, which is a stronger check than the ensemble
 * was: a person reads the whole frame, in any orientation, and does not mistake gravel for
 * a coordinate. The ensemble's own failure mode argues the same way - it rejected frames on
 * two confident words in one line, which road texture supplies freely.
 *
 * What remains is what a person cannot do by eye: an unreadable file, and two frames whose
 * bytes are identical. Both are cheap, and both are checked at every freeze.
 *
 * Usage:
 *   node src/sample.ts                      verify the frozen corpora
 *   node src/sample.ts --freeze [--concurrency 8] [--seed split-v1]
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { REJECTS_PATH, loadRejects } from "./rejects.ts";
import { REVIEWED_PATH, loadReviewed } from "./reviewed.ts";
import {
  DEFAULT_MANIFEST,
  DEFAULT_TRAIN_MANIFEST,
  loadFrozenSample,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import { OSV5M_DIR, exclusionOf, fingerprintOf, gridCellOf, loadRows } from "./osv5m.ts";
import { SplitError, balanceOf, splitBalanced } from "./split.ts";
import type { Balance } from "./split.ts";
import type { Row, Sample } from "./osv5m.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const freeze = process.argv.includes("--freeze");
const concurrency = Number(flag("concurrency", "8"));
const evalPath = flag("eval-manifest", DEFAULT_MANIFEST);
const trainPath = flag("train-manifest", DEFAULT_TRAIN_MANIFEST);

/**
 * Tie-break key for the partition. It is not a draw seed: the pool is taken whole, and
 * the seed only decides which of two equally balanced arrangements is chosen.
 */
const seed = flag("seed", "split-v1");

const { rows: pool, csvRowCount } = await loadRows();
console.log(`dataset  ${OSV5M_DIR}`);
console.log(`pool     ${pool.length} images on disk of ${csvRowCount} rows in test.csv`);

const [rejects, reviewed] = await Promise.all([loadRejects(), loadReviewed()]);
console.log(`review   ${reviewed.size} frames kept, ${rejects.size} dropped`);

/**
 * The frames both corpora are built from: approved by review, and not later dropped.
 *
 * The rejects file outranks the kept list. A reviewer who approves a frame and drops it
 * afterwards leaves an id in both, and the later, stronger verdict is the rejection.
 */
const curated = pool.filter((row) => reviewed.has(row.id) && !rejects.has(row.id));

// A kept frame whose image is not on disk is an incomplete shard set, not a smaller
// corpus. Freezing through it would produce a corpus that no other clone can reproduce.
const present = new Set(curated.map((row) => row.id));
const absent = [...reviewed].filter((id) => !rejects.has(id) && !present.has(id));
if (absent.length > 0) {
  console.error(
    `failed   ${absent.length} of ${reviewed.size} kept frames are not on disk, for example ` +
      `${absent.slice(0, 3).join(", ")}. Download the missing test image shards listed in ` +
      `docs/benchmark/reproduce.md.`,
  );
  process.exit(1);
}
console.log(`curated  ${curated.length} frames in the pool both corpora are cut from`);

/** A frame in the pool that may not enter a corpus, and why. */
type Flaw = { id: string; reason: string; detail: string };

type Inspection =
  | { ok: true; row: Row; digest: string }
  | { ok: false; row: Row; reason: string; detail: string };

/**
 * Reads every frame in the pool and reports what is wrong with it.
 *
 * Chunks are planned in parallel and consumed in order, so the list of flaws does not
 * depend on which worker finished first. That mattered more when this pass ran OCR; it is
 * kept because the duplicate report names the lower id first either way.
 */
async function inspect(rows: readonly Row[]): Promise<Flaw[]> {
  const flaws: Flaw[] = [];
  const firstSeen = new Map<string, string>();

  for (let start = 0; start < rows.length; start += concurrency) {
    const chunk = rows.slice(start, start + concurrency);
    const results: Inspection[] = await Promise.all(
      chunk.map(async (row): Promise<Inspection> => {
        try {
          const bytes = await readFile(row.imagePath);
          return { ok: true, row, digest: createHash("sha256").update(bytes).digest("hex") };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { ok: false, row, reason: "unreadable", detail };
        }
      }),
    );

    for (const result of results) {
      if (!result.ok) {
        flaws.push({ id: result.row.id, reason: result.reason, detail: result.detail });
        continue;
      }
      // A byte-identical frame is the same photograph twice. Two copies inflate whatever
      // the model does with it and, across corpora, quietly reunite the two halves.
      const twin = firstSeen.get(result.digest);
      if (twin !== undefined) {
        flaws.push({ id: result.row.id, reason: "duplicate", detail: `same bytes as ${twin}` });
        continue;
      }
      firstSeen.set(result.digest, result.row.id);
    }
  }
  console.log(`read     ${rows.length} frames, ${flaws.length} unusable`);
  return flaws;
}

function sampleOf(rows: readonly Row[]): Sample {
  return {
    rows: [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)),
    fingerprint: fingerprintOf(rows.map((row) => row.id)),
    seed,
    strata: new Set(rows.map((row) => row.cell)).size,
  };
}

function describe(name: string, sample: Sample): void {
  console.log(
    `${name.padEnd(8)} n=${sample.rows.length} seed=${sample.seed} fp=${sample.fingerprint} ` +
      `strata=${sample.strata} countries=${new Set(sample.rows.map((row) => row.country)).size}`,
  );
}

/**
 * Prints the country gap next to the smallest gap this pool allows.
 *
 * The bound is the point of the line. A gap of 109 means nothing on its own; a gap of 109
 * against a floor of 109 says the halves match as closely as whole groups can be made to
 * match, and a gap above the floor says the partition left something on the table.
 */
function reportBalance(balance: Balance): boolean {
  const optimal = balance.gap <= balance.floor;
  const worst = balance.worst === null ? "none" : `${balance.worst.country}+${balance.worst.gap}`;
  console.log(
    `balance  country gap=${balance.gap} floor=${balance.floor} worst=${worst}` +
      `${optimal ? "  (optimal)" : "  FAILED"}`,
  );
  return optimal;
}

type Overlap = { ids: number; sequences: number; creators: number; gridCells: number };

/** Overlap between the two corpora on every axis the separation rule covers. */
function overlaps(a: readonly Row[], b: readonly Row[]): Overlap {
  const left = exclusionOf(a);
  let ids = 0;
  let sequences = 0;
  let creators = 0;
  let gridCells = 0;
  for (const row of b) {
    if (left.ids.has(row.id)) ids++;
    if (row.sequence !== "" && left.sequences.has(row.sequence)) sequences++;
    if (row.creator !== "" && left.creators.has(row.creator)) creators++;
    if (left.gridCells.has(gridCellOf(row))) gridCells++;
  }
  return { ids, sequences, creators, gridCells };
}

function reportOverlap(counts: Overlap): boolean {
  const clean = Object.values(counts).every((count) => count === 0);
  console.log(
    `overlap  ids=${counts.ids} sequences=${counts.sequences} ` +
      `creators=${counts.creators} cells=${counts.gridCells}` +
      `${clean ? "  (disjoint)" : "  FAILED"}`,
  );
  return clean;
}

if (freeze) {
  const flaws = await inspect(curated);

  if (flaws.length > 0) {
    const byReason = new Map<string, number>();
    for (const flaw of flaws) byReason.set(flaw.reason, (byReason.get(flaw.reason) ?? 0) + 1);
    console.error(
      `failed   ${flaws.length} frames in the pool may not enter a corpus ` +
        `(${[...byReason].map(([reason, count]) => `${reason}=${count}`).join(" ")}).`,
    );
    for (const flaw of flaws.slice(0, 10)) {
      console.error(`${" ".repeat(8)} ${flaw.id} ${flaw.reason}: ${flaw.detail.slice(0, 60)}`);
    }
    console.error(
      `${" ".repeat(8)} The pool has no refill, so nothing takes their place. Add each id to ` +
        `${REJECTS_PATH} with a reason, then freeze again.`,
    );
    process.exit(1);
  }

  let split;
  try {
    split = splitBalanced(curated, seed);
  } catch (error) {
    if (!(error instanceof SplitError)) throw error;
    console.error(`failed   ${error.message}`);
    process.exit(1);
  }

  const evalSample = sampleOf(split.evalRows);
  const trainSample = sampleOf(split.trainRows);

  await writeManifest(evalPath, evalSample, {
    role: "eval",
    counterpart: trainSample.fingerprint,
    rejected: rejects.size,
  });
  await writeManifest(trainPath, trainSample, {
    role: "train",
    counterpart: evalSample.fingerprint,
    rejected: rejects.size,
  });

  console.log("---");
  console.log(`groups   ${split.groups} indivisible groups in ${curated.length} frames`);
  describe("eval", evalSample);
  describe("train", trainSample);
  reportBalance(split.balance);
  reportOverlap(overlaps(split.evalRows, split.trainRows));
  console.log(`frozen   ${evalPath}`);
  console.log(`frozen   ${trainPath}`);
  console.log(`next     node src/collect.ts rebuilds benchmark/images/ from these files`);
} else {
  const evalManifest = await readManifest(evalPath);
  const trainManifest = await readManifest(trainPath);
  const evalSample = await loadFrozenSample(pool, evalPath, "eval");
  const trainSample = await loadFrozenSample(pool, trainPath, "train");

  describe("eval", evalSample);
  describe("train", trainSample);
  console.log(
    `${" ".repeat(8)} ${evalManifest.rejected} frames dropped by review at freeze time` +
      `${evalManifest.rejected === trainManifest.rejected ? "" : "  FAILED"}`,
  );

  // The cross-link is what makes the pair a pair. Two files frozen in separate runs can
  // each be internally valid and still describe corpora that were never checked against
  // one another.
  const linked =
    evalManifest.counterpart === trainManifest.fingerprint &&
    trainManifest.counterpart === evalManifest.fingerprint;
  console.log(
    `link     eval->${evalManifest.counterpart ?? "none"} train->${trainManifest.counterpart ?? "none"}` +
      `${linked ? "  (paired)" : "  FAILED"}`,
  );

  // The corpora and the review lists drift apart in two directions, and both matter. A
  // frame dropped after the last freeze is still being scored; a frame approved after the
  // last freeze is being ignored. Either way the lists have stopped describing the
  // corpora, and silence would let that stand.
  const frozen = [...evalSample.rows, ...trainSample.rows];
  const barred = frozen.filter((row) => rejects.has(row.id));
  const unreviewed = frozen.filter((row) => !reviewed.has(row.id));
  const held = new Set(frozen.map((row) => row.id));
  const orphans = curated.filter((row) => !held.has(row.id));

  console.log(
    `review   ${barred.length} dropped and ${unreviewed.length} unreviewed frames in the ` +
      `corpora, ${orphans.length} kept frames outside them` +
      `${barred.length + unreviewed.length + orphans.length === 0 ? "" : "  FAILED"}`,
  );
  for (const row of [...barred, ...unreviewed, ...orphans].slice(0, 10)) {
    const state = rejects.get(row.id) ?? (reviewed.has(row.id) ? "kept but not frozen" : "unreviewed");
    console.log(`${" ".repeat(8)} ${row.id} ${state}`);
  }

  const balanced = reportBalance(balanceOf(evalSample.rows, trainSample.rows, evalManifest.seed));
  const disjoint = reportOverlap(overlaps(evalSample.rows, trainSample.rows));

  if (
    !disjoint ||
    !linked ||
    !balanced ||
    barred.length + unreviewed.length + orphans.length > 0 ||
    evalManifest.rejected !== trainManifest.rejected
  ) {
    console.error(
      `failed   the corpora do not match ${REVIEWED_PATH} and ${REJECTS_PATH}, or are not a ` +
        `matched, disjoint, balanced pair. Re-freeze with \`node src/sample.ts --freeze\`.`,
    );
    process.exit(1);
  }
  console.log(
    "ready    every frame is on disk, reviewed, kept, and in exactly one balanced half",
  );
}
