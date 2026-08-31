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
 * What a frozen corpus is.
 *
 * There is no draw function here any more. Corpora used to be ranked by
 * `sha256(seed:id)` and cut at a size; they are now a partition of the frames review
 * approved, computed by `src/split.ts`. The ranking is gone rather than kept for
 * reference, because a caller that ranked the whole split again would build a corpus
 * out of frames nobody has looked at, which is the one thing the review gate exists to
 * prevent. The caps that ranking enforced - one frame per `sequence`, at most three per
 * uploader - are checked directly by `checkCaps` in `src/split.ts`.
 */
export type Sample = {
  rows: Row[];
  /** Short digest of the selected ids. Identifies the frozen set across runs. */
  fingerprint: string;
  seed: string;
  /** Number of `cell` strata the corpus covers. */
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
 * a non-default `km` uses it for its own analysis. Every separation check runs at
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

