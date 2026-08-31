/**
 * The frozen corpus, stored in the repository so a fresh clone scores the same items.
 *
 * Why a file and not only a seed: `loadRows` keeps a row only when its image is on
 * disk, and the OSV-5M test images ship as five separate shards. Two people who hold
 * different shards therefore get different samples from the same seed. The manifest
 * removes that dependency. It pins the ids; the labels still come from `test.csv`,
 * which is identical for everybody, so no ground truth is duplicated here.
 *
 * The file pins ids only. Frames are used whole: the corpus screen rejects any frame
 * that carries a burned-in overlay instead of cropping one away, so there is no
 * per-frame preprocessing left to record.
 */
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { framePath } from "./frames.ts";
import { fingerprintOf } from "./osv5m.ts";
import type { Row, Sample } from "./osv5m.ts";

export const DEFAULT_MANIFEST = "benchmark/samples/osv5m-v4-eval.txt";
export const DEFAULT_TRAIN_MANIFEST = "benchmark/samples/osv5m-v4-train.txt";

/**
 * What a corpus is for. `superseded` keeps a retired corpus readable without pretending
 * it is still the benchmark.
 */
export type ManifestRole = "eval" | "train" | "superseded";

const ROLES: Record<string, true> = { eval: true, train: true, superseded: true };

export type Manifest = {
  seed: string;
  role: ManifestRole;
  size: number;
  /** Digest of the ids, as written when the corpus was frozen. */
  fingerprint: string;
  /** Fingerprint of the corpus this one is held out from, or null when there is none. */
  counterpart: string | null;
  /** How many candidates screening dropped before this corpus filled. */
  rejected: number;
  /** The frozen ids, in the order they were written. */
  ids: string[];
};

/** Header values that the sample itself does not carry. */
export type ManifestHeader = {
  role: ManifestRole;
  counterpart: string | null;
  rejected: number;
};

/** The manifest does not describe the corpus it claims to describe. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const HEADER_KEYS = ["seed", "role", "size", "fingerprint", "counterpart", "rejected"] as const;

export function formatManifest(sample: Sample, header: ManifestHeader): string {
  const ids = sample.rows.map((row) => row.id).sort();

  return [
    "# OSV-5M frozen corpus.",
    "# Regenerate with: node src/sample.ts --freeze",
    `# seed: ${sample.seed}`,
    `# role: ${header.role}`,
    `# size: ${ids.length}`,
    `# fingerprint: ${sample.fingerprint}`,
    `# counterpart: ${header.counterpart ?? "none"}`,
    `# rejected: ${header.rejected}`,
    ...ids,
    "",
  ].join("\n");
}

export async function writeManifest(
  path: string,
  sample: Sample,
  header: ManifestHeader,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatManifest(sample, header), "utf8");
}

/** Reads a non-negative integer header value, or stops with what to do next. */
function integerHeader(path: string, header: Map<string, string>, key: string): number {
  const raw = header.get(key) as string;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ManifestError(
      `${path} has \`# ${key}: ${raw}\`, which is not a whole number. Regenerate the ` +
        `manifest with \`node src/sample.ts --freeze\` instead of editing the header.`,
    );
  }
  return value;
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
    // A body line pins one frame id. Frames are used whole, so nothing else is needed.
    if (/\s/.test(text)) {
      throw new ManifestError(
        `${path} has the body line \`${text}\`, which is not a bare frame id. A manifest ` +
          `with a cut column is the old format. Regenerate with \`node src/sample.ts --freeze\`.`,
      );
    }
    ids.push(text);
  }

  for (const key of HEADER_KEYS) {
    if (!header.has(key)) {
      throw new ManifestError(
        `${path} has no \`# ${key}:\` line. Regenerate it with ` +
          `\`node src/sample.ts --freeze\`; do not add the line by hand.`,
      );
    }
  }

  const role = header.get("role") as string;
  if (ROLES[role] !== true) {
    throw new ManifestError(
      `${path} declares role ${role}. Use eval, train, or superseded, so a reader knows ` +
        `whether this corpus still scores the benchmark.`,
    );
  }

  const size = integerHeader(path, header, "size");
  const rejected = integerHeader(path, header, "rejected");
  if (ids.length !== size) {
    throw new ManifestError(
      `${path} declares size ${size} but lists ${ids.length} frames. Regenerate it with ` +
        `\`node src/sample.ts --freeze\` rather than trimming the list.`,
    );
  }

  const fingerprint = header.get("fingerprint") as string;
  const actual = fingerprintOf(ids);
  if (actual !== fingerprint) {
    throw new ManifestError(
      `${path} was edited: header says fingerprint ${fingerprint}, the ids hash to ${actual}. ` +
        `Restore the committed file, or regenerate it with \`node src/sample.ts --freeze\`.`,
    );
  }

  const counterpartRaw = header.get("counterpart") as string;

  return {
    seed: header.get("seed") as string,
    role: role as ManifestRole,
    size,
    fingerprint,
    counterpart: counterpartRaw === "none" ? null : counterpartRaw,
    rejected,
    ids,
  };
}

/**
 * Resolves the manifest into the frames a run will read.
 *
 * Two files back one corpus item, and they answer different questions. `test.csv` holds
 * the ground truth, which is never duplicated into this repository. The frame under
 * `benchmark/images/<role>/` holds the pixels, already turned upright if review turned
 * them, and that is what `imagePath` points at. A reader therefore cannot get a frame
 * without its orientation, because the orientation is the frame.
 *
 * Rows are copied rather than edited. `pool` is shared with every other caller, and
 * repointing a row in place would silently change which file they read.
 *
 * Missing ids are fatal on purpose. A short run is not a cheaper run, it is a different
 * benchmark, and averaging over a smaller denominator hides that.
 */
export function selectByManifest(pool: readonly Row[], manifest: Manifest): Sample {
  const byId = new Map(pool.map((row) => [row.id, row]));
  const rows: Row[] = [];
  const missing: string[] = [];

  for (const id of manifest.ids) {
    const row = byId.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    // A retired corpus has no frame directory, so its rows keep pointing at the shards.
    // Nothing scores it; it stays readable for history.
    const imagePath =
      manifest.role === "superseded" ? row.imagePath : framePath(manifest.role, id);
    rows.push({ ...row, imagePath });
  }

  if (missing.length > 0) {
    throw new ManifestError(
      `${missing.length} of ${manifest.ids.length} frames in the frozen corpus have no row ` +
        `in test.csv on this machine, for example ${missing.slice(0, 3).join(", ")}. The ` +
        `labels come from the dataset: follow docs/benchmark/reproduce.md, then run ` +
        `\`node src/sample.ts\` again.`,
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
 * Reads the manifest, resolves it, and checks that every frame it names is on disk.
 *
 * The frame check belongs here rather than in the first reader. A run that discovers a
 * missing frame on item 400 has already spent 400 paid calls, and a run that treated the
 * gap as one lost row would report a mean over a denominator nobody chose.
 *
 * A missing frame or an edited manifest is an operator problem, not a defect, and a stack
 * trace buries the one line that says what to do next.
 *
 * `expected` is not ceremony. Distilling memories from the eval corpus, or scoring on the
 * train corpus, invalidates every number produced afterwards and leaves no trace in the
 * output that says so. The role is written into the file precisely so the wrong path is
 * refused instead of silently obeyed.
 */
export async function loadFrozenSample(
  pool: readonly Row[],
  path: string,
  expected?: ManifestRole,
): Promise<Sample> {
  try {
    const manifest = await readManifest(path);
    if (expected !== undefined && manifest.role !== expected) {
      throw new ManifestError(
        `${path} is the ${manifest.role} corpus, but this run needs the ${expected} corpus. ` +
          `Pass --manifest with the right file, or re-freeze with \`node src/sample.ts --freeze\`.`,
      );
    }

    const sample = selectByManifest(pool, manifest);
    const absent: string[] = [];
    await Promise.all(
      sample.rows.map(async (row) => {
        try {
          await access(row.imagePath);
        } catch {
          absent.push(row.id);
        }
      }),
    );
    if (absent.length > 0) {
      absent.sort();
      throw new ManifestError(
        `${absent.length} of ${sample.rows.length} frames of the ${manifest.role} corpus are ` +
          `not on disk, for example ${absent.slice(0, 3).join(", ")}. Rebuild them with ` +
          `\`npm run collect\`.`,
      );
    }
    return sample;
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    console.error(`failed   ${error.message}`);
    process.exit(1);
  }
}
