/**
 * Builds `benchmark/images/` from the two frozen manifests.
 *
 * This is the step that turns a pair of id lists into the committed dataset. It runs
 * after `node src/sample.ts --freeze`, and it is the only writer of that directory, so
 * the directory always says exactly what the manifests say and never accumulates frames
 * from an older freeze.
 *
 * Three kinds of frame leave the directory, and only one of them is kept anywhere:
 *
 *  - A frame a person dropped is **moved** to `tmp/dropped/`, not deleted. The reviewer
 *    may want to look at a verdict again, and `tmp/` is ignored by git, so the frames
 *    leave the committed dataset without leaving the machine. A dropped frame that has no
 *    copy in the directory is written there from the dataset, so the folder holds every
 *    id in `benchmark/samples/rejected.txt` whatever order the steps ran in.
 *  - A frame nobody reviewed is deleted. Nothing is lost: it is still in the OSV-5M
 *    shards under `tmp/datasets/`, which is where every frame here comes from.
 *  - A frame that changed sides between freezes is rewritten into its new corpus.
 *
 * Source frames are read only. Every copy is verified by sha256 against the bytes it was
 * meant to receive, because a silently truncated copy would be indistinguishable from a
 * real frame until a run failed on it.
 *
 * Frames are copied byte for byte, with one exception: a frame listed in
 * `benchmark/samples/rotated.txt` is turned upright first. Nothing is cropped, because
 * the screen rejects any frame carrying a burned-in overlay, so what ships here is what
 * the model sees.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MANIFEST, DEFAULT_TRAIN_MANIFEST, readManifest } from "./manifest.ts";
import { loadRejects } from "./rejects.ts";
import { loadRows } from "./osv5m.ts";
import { frameBytes } from "./rotations.ts";

const ROOT = join("benchmark", "images");

/** Where dropped frames go. Under `tmp/`, which `.gitignore` excludes whole. */
const DROPPED = join("tmp", "dropped");

const CORPORA = [
  { role: "eval", path: DEFAULT_MANIFEST },
  { role: "train", path: DEFAULT_TRAIN_MANIFEST },
] as const;

const { rows } = await loadRows();
const byId = new Map(rows.map((row) => [row.id, row]));
const rejects = await loadRejects();

/** Every frame in the directory now, and which role folder holds it. */
const before = new Map<string, string>();
for (const { role } of CORPORA) {
  for (const name of await readdir(join(ROOT, role)).catch(() => [])) {
    if (name.endsWith(".jpg")) before.set(name.slice(0, -4), role);
  }
}

/**
 * Moves a file across directories, falling back to copy and delete.
 *
 * `rename` fails with `EXDEV` when the two paths are on different volumes, which is a
 * normal setup: the dataset and `tmp/` often sit on a larger disk than the checkout.
 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await unlink(from);
  }
}

await mkdir(DROPPED, { recursive: true });

let moved = 0;
let written = 0;
const unknown: string[] = [];

for (const id of rejects.keys()) {
  const target = join(DROPPED, `${id}.jpg`);
  const role = before.get(id);
  if (role !== undefined) {
    await moveFile(join(ROOT, role, `${id}.jpg`), target);
    moved++;
    continue;
  }
  const row = byId.get(id);
  if (row === undefined) {
    // A dropped id that is not in the split on disk. Harmless, and worth naming: it means
    // the rejects file outlived the shard that held the frame.
    unknown.push(id);
    continue;
  }
  await copyFile(row.imagePath, target);
  written++;
}

type Credit = { id: string; role: string; creator: string };

const credits: Credit[] = [];
let copied = 0;
let bytes = 0;
let turned = 0;
const kept = new Set<string>();

for (const { role, path } of CORPORA) {
  const manifest = await readManifest(path);
  const dir = join(ROOT, role);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const missing: string[] = [];
  for (const id of manifest.ids) {
    const row = byId.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    const { bytes: wanted, angle } = await frameBytes(row.imagePath);
    const target = join(dir, `${id}.jpg`);
    await writeFile(target, wanted);

    const back = await readFile(target);
    const a = createHash("sha256").update(wanted).digest("hex");
    const b = createHash("sha256").update(back).digest("hex");
    if (a !== b) throw new Error(`copy differs from what was written: ${id}`);

    credits.push({ id, role, creator: row.creator });
    kept.add(id);
    copied++;
    if (angle !== 0) turned++;
    bytes += wanted.length;
  }

  if (missing.length > 0) {
    console.error(`failed ${role} is missing ${missing.length} frames, first ${missing[0]}`);
    process.exit(1);
  }
  console.log(`${role.padEnd(6)} ${manifest.ids.length} frames -> ${dir}`);
}

credits.sort((a, b) => (a.id < b.id ? -1 : 1));
await writeFile(
  join(ROOT, "credits.csv"),
  ["id,role,creator_username", ...credits.map((c) => `${c.id},${c.role},${c.creator}`)].join("\n") +
    "\n",
  "utf8",
);

const discarded = [...before.keys()].filter((id) => !kept.has(id) && !rejects.has(id));
const authors = new Set(credits.map((credit) => credit.creator).filter((name) => name !== ""));

console.log(`---`);
console.log(
  `copied  ${copied} frames, ${(bytes / 1024 / 1024).toFixed(0)} MB, ${authors.size} uploaders`,
);
console.log(`turned  ${turned} frames upright per benchmark/samples/rotated.txt`);
console.log(`dropped ${moved} moved and ${written} written to ${DROPPED}`);
console.log(`removed ${discarded.length} frames that no corpus claims any more`);
if (unknown.length > 0) {
  console.log(`absent  ${unknown.length} dropped ids are not in the shards on disk`);
}
