/**
 * Reads the local OSV-5M test split and draws a frozen, reproducible sample.
 *
 * Two hazards this module exists to avoid:
 *  1. Only part of the test split is on disk, so rows must be joined to real files.
 *  2. The split is clustered. Sampling by row order, by creator or by sequence
 *     inflates variance badly (sd of acc@200km goes from ~1.3pp to ~13pp), so the
 *     draw is stratified over the `cell` grid with sequence and creator caps.
 *  3. Two corpora cut from one split are not independent. A train row that shares an
 *     uploader, a sequence or a location with an eval row is not held out: the model
 *     can recall the neighbour instead of reading the frame. An `Exclusion` therefore
 *     removes everything a first corpus occupies before the second corpus is drawn.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse } from "csv-parse/sync";

export const OSV5M_DIR = process.env.OSV5M_DIR ?? join("tmp", "datasets", "osv5m");

export type Row = {
  id: string;
  latitude: number;
  longitude: number;
  country: string;
  region: string;
  subRegion: string;
  city: string;
  cell: string;
  sequence: string;
  creator: string;
  capturedAt: string;
  /** Absolute or repo-relative path to the JPEG on disk. */
  imagePath: string;
};

type RawRow = Record<string, string>;

/** Maps OSV-5M image id to its path, for the part of the split that is on disk. */
export async function indexImages(split = "test"): Promise<Map<string, string>> {
  const root = join(OSV5M_DIR, "images", split);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const index = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".jpg") continue;
    index.set(basename(entry.name, extname(entry.name)), join(entry.parentPath, entry.name));
  }
  return index;
}

/** Reads the split CSV and keeps only rows whose image is present locally. */
export async function loadRows(split = "test"): Promise<{ rows: Row[]; csvRowCount: number }> {
  const [csv, images] = await Promise.all([
    readFile(join(OSV5M_DIR, `${split}.csv`), "utf8"),
    indexImages(split),
  ]);
  const raw = parse(csv, { columns: true, skipEmptyLines: true }) as RawRow[];

  const rows: Row[] = [];
  for (const record of raw) {
    const id = record["id"];
    if (!id) continue;
    const imagePath = images.get(id);
    if (!imagePath) continue;
    const latitude = Number(record["latitude"]);
    const longitude = Number(record["longitude"]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    rows.push({
      id,
      latitude,
      longitude,
      country: record["country"] ?? "",
      region: record["region"] ?? "",
      subRegion: record["sub-region"] ?? "",
      city: record["city"] ?? "",
      cell: record["cell"] ?? "",
      sequence: record["sequence"] ?? "",
      creator: record["creator_username"] ?? "",
      capturedAt: record["captured_at"] ?? "",
      imagePath,
    });
  }
  return { rows, csvRowCount: raw.length };
}

/**
 * Stable pseudo-random rank in [0, 1). Depends only on the seed and the row id, so
 * the same seed always selects the same rows regardless of file or CSV order.
 */
function rank(seed: string, id: string): number {
  const digest = createHash("sha256").update(`${seed}:${id}`).digest();
  return Number(digest.readBigUInt64BE(0) >> 11n) / 2 ** 53;
}

export type SampleOptions = {
  size: number;
  seed: string;
  /** At most one row per capture sequence, since a sequence is one stretch of road. */
  onePerSequence?: boolean;
  /** Cap on rows from a single uploader. The top 15 creators hold ~21% of the split. */
  maxPerCreator?: number;
  /** Everything an earlier corpus occupies. Rows it covers never enter this draw. */
  exclude?: Exclusion;
};

export type Sample = {
  rows: Row[];
  /** Short digest of the selected ids. Identifies the frozen set across runs. */
  fingerprint: string;
  seed: string;
  /** Number of `cell` strata the draw covers. */
  strata: number;
};

/** Everything a corpus occupies, for keeping a second corpus disjoint from it. */
export type Exclusion = {
  ids: ReadonlySet<string>;
  sequences: ReadonlySet<string>;
  creators: ReadonlySet<string>;
  gridCells: ReadonlySet<string>;
};

/** Grid spacing used by every exclusion test, in kilometres. */
const DEFAULT_GRID_KM = 25;

/** Kilometres in one degree of latitude. Longitude shrinks with cos(latitude). */
const KM_PER_DEGREE = 111.32;

/**
 * Key of the ~`km`-sided grid cell holding this row.
 *
 * The `cell` column cannot do this job. It is a quadtree class with ~2000 members over
 * the planet, so two rows in one `cell` can be a continent apart, and neighbours across
 * a class boundary land in different classes. This grid is metric, so "no train frame
 * within ~25 km of an eval frame" becomes expressible. The longitude divisor clamps
 * cos(latitude) at 0.15, because it reaches zero at the pole and one cell would then
 * wrap the globe.
 */
export function gridCellOf(row: Row, km = DEFAULT_GRID_KM): string {
  const latStep = km / KM_PER_DEGREE;
  const lonStep = latStep / Math.max(Math.cos((row.latitude * Math.PI) / 180), 0.15);
  return `${Math.floor(row.latitude / latStep)}:${Math.floor(row.longitude / lonStep)}`;
}

/**
 * Everything a corpus occupies, for keeping a second corpus disjoint from it.
 *
 * Empty `sequence` and `creator` values are dropped. They mean "unknown", not "the same
 * uploader", and blocking on them would remove every anonymous row from the second draw.
 *
 * The result records cells, not the spacing that produced them, so a caller that passes
 * a non-default `km` uses it for its own analysis: `drawCandidates` always tests at
 * `DEFAULT_GRID_KM`.
 */
export function exclusionOf(rows: readonly Row[], km = DEFAULT_GRID_KM): Exclusion {
  const ids = new Set<string>();
  const sequences = new Set<string>();
  const creators = new Set<string>();
  const gridCells = new Set<string>();
  for (const row of rows) {
    ids.add(row.id);
    if (row.sequence !== "") sequences.add(row.sequence);
    if (row.creator !== "") creators.add(row.creator);
    gridCells.add(gridCellOf(row, km));
  }
  return { ids, sequences, creators, gridCells };
}

function isExcluded(exclusion: Exclusion, row: Row): boolean {
  if (exclusion.ids.has(row.id)) return true;
  if (row.sequence !== "" && exclusion.sequences.has(row.sequence)) return true;
  if (row.creator !== "" && exclusion.creators.has(row.creator)) return true;
  return exclusion.gridCells.has(gridCellOf(row, DEFAULT_GRID_KM));
}

/**
 * Short digest of a set of row ids, order-independent.
 *
 * Shared by the draw and by the committed manifest, so a replay can prove it scored
 * the same items instead of assuming it.
 */
export function fingerprintOf(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex")
    .slice(0, 12);
}

/**
 * The eligible pool in draw order, with the caps and the exclusion applied but no size
 * limit.
 *
 * Screening rejects frames after the draw, so a caller that needs exactly `size` rows
 * refills each rejected slot from further down this list. Ranking twice would move the
 * refill off the ranking that produced the corpus, so this is the only ranking path and
 * `drawSample` is a prefix of it.
 */
export function drawCandidates(pool: readonly Row[], options: SampleOptions): Row[] {
  const { seed, onePerSequence = true, maxPerCreator = 3, exclude } = options;

  const ranked = pool
    .map((row) => ({ row, r: rank(seed, row.id) }))
    .sort((a, b) => a.r - b.r || (a.row.id < b.row.id ? -1 : 1));

  // Decorrelate first: one row per sequence, and a cap per uploader. Both caps are
  // greedy over the rank order, so the survivors do not depend on the pool order.
  const seenSequence = new Set<string>();
  const creatorCount = new Map<string, number>();
  const eligible: Row[] = [];
  for (const { row } of ranked) {
    if (exclude !== undefined && isExcluded(exclude, row)) continue;
    if (onePerSequence && row.sequence !== "" && seenSequence.has(row.sequence)) continue;
    const used = creatorCount.get(row.creator) ?? 0;
    if (row.creator !== "" && used >= maxPerCreator) continue;
    seenSequence.add(row.sequence);
    creatorCount.set(row.creator, used + 1);
    eligible.push(row);
  }
  return eligible;
}

export function drawSample(pool: Row[], options: SampleOptions): Sample {
  const { size, seed } = options;

  // Take the first `size` by rank. Because `rank` is a hash, that is a simple random
  // sample of the decorrelated pool, so the draw stays dataset-weighted and the
  // metric remains comparable with full-test-set results.
  //
  // Do NOT allocate proportionally across the `cell` grid here. There are ~2000 cells
  // and far fewer sampled rows, so every quota floors to zero and largest-remainder
  // hands every slot to the densest cells. A 12-row draw came back entirely European.
  // Stratification only pays off when each stratum can hold several rows.
  const eligible = drawCandidates(pool, options);
  const chosen = eligible.slice(0, Math.min(size, eligible.length));

  chosen.sort((a, b) => (a.id < b.id ? -1 : 1));
  const fingerprint = fingerprintOf(chosen.map((row) => row.id));

  return {
    rows: chosen,
    fingerprint,
    seed,
    strata: new Set(chosen.map((row) => row.cell)).size,
  };
}
