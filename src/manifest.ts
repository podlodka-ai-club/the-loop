/**
 * The frozen sample, stored in the repository so a fresh clone scores the same items.
 *
 * Why a file and not only a seed: `loadRows` keeps a row only when its image is on
 * disk, and the OSV-5M test images ship as five separate shards. Two people who hold
 * different shards therefore get different samples from the same seed. The manifest
 * removes that dependency. It pins the ids; the labels still come from `test.csv`,
 * which is identical for everybody, so no ground truth is duplicated here.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprintOf } from "./osv5m.ts";
import type { Row, Sample } from "./osv5m.ts";

export const DEFAULT_MANIFEST = "benchmark/samples/osv5m-v1-n200.txt";

export type Manifest = {
  seed: string;
  size: number;
  /** Digest of the ids, as written when the sample was frozen. */
  fingerprint: string;
  ids: string[];
};

/** The manifest does not describe the sample it claims to describe. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const HEADER_KEYS = ["seed", "size", "fingerprint"] as const;

export function formatManifest(sample: Sample): string {
  const ids = sample.rows.map((row) => row.id).sort();
  return [
    "# OSV-5M frozen evaluation sample.",
    "# Regenerate with: node src/sample.ts --freeze",
    `# seed: ${sample.seed}`,
    `# size: ${ids.length}`,
    `# fingerprint: ${sample.fingerprint}`,
    ...ids,
    "",
  ].join("\n");
}

export async function writeManifest(path: string, sample: Sample): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatManifest(sample), "utf8");
}

export async function readManifest(path: string): Promise<Manifest> {
  const header = new Map<string, string>();
  const ids: string[] = [];

  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    if (text.startsWith("#")) {
      const match = /^#\s*([a-z]+):\s*(\S+)$/.exec(text);
      if (match?.[1] !== undefined && match[2] !== undefined) header.set(match[1], match[2]);
      continue;
    }
    ids.push(text);
  }

  for (const key of HEADER_KEYS) {
    if (!header.has(key)) throw new ManifestError(`${path} has no \`# ${key}:\` line`);
  }

  const size = Number(header.get("size"));
  if (ids.length !== size) {
    throw new ManifestError(`${path} declares size ${size} but lists ${ids.length} ids`);
  }

  const fingerprint = header.get("fingerprint") as string;
  const actual = fingerprintOf(ids);
  if (actual !== fingerprint) {
    throw new ManifestError(
      `${path} was edited: header says fingerprint ${fingerprint}, the ids hash to ${actual}`,
    );
  }

  return { seed: header.get("seed") as string, size, fingerprint, ids };
}

/**
 * Resolves the manifest against the rows that are on disk.
 *
 * Missing ids are fatal on purpose. A short run is not a cheaper run, it is a
 * different benchmark, and averaging over a smaller denominator hides that.
 */
export function selectByManifest(pool: readonly Row[], manifest: Manifest): Sample {
  const byId = new Map(pool.map((row) => [row.id, row]));
  const rows: Row[] = [];
  const missing: string[] = [];

  for (const id of manifest.ids) {
    const row = byId.get(id);
    if (row === undefined) missing.push(id);
    else rows.push(row);
  }

  if (missing.length > 0) {
    throw new ManifestError(
      `${missing.length} of ${manifest.ids.length} images from the frozen sample are not on ` +
        `disk, for example ${missing.slice(0, 3).join(", ")}. Download the test image shards ` +
        `listed in docs/benchmark/reproduce.md, then run \`node src/sample.ts\` again.`,
    );
  }

  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    rows,
    fingerprint: manifest.fingerprint,
    seed: manifest.seed,
    strata: new Set(rows.map((row) => row.cell)).size,
  };
}

/**
 * Reads the manifest and resolves it, or stops with the reason.
 *
 * A missing shard or an edited manifest is an operator problem, not a defect, and a
 * stack trace buries the one line that says what to do next.
 */
export async function loadFrozenSample(pool: readonly Row[], path: string): Promise<Sample> {
  try {
    return selectByManifest(pool, await readManifest(path));
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    console.error(`failed   ${error.message}`);
    process.exit(1);
  }
}
