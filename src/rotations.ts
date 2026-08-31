/**
 * Human rotation verdicts, and the single place that applies them.
 *
 * OSV-5M ships a few percent of frames rotated, and the rotation is baked into the
 * pixels. `rejects.ts` explains why no automatic rule turns them upright: the pixel
 * heuristics tried for orientation reached about 68% precision, so a rule that rotates
 * would corrupt a good frame on every false positive. A person therefore decides, in
 * `src/review.ts`, and the decision is written here.
 *
 * This list is a build input, not runtime metadata. `src/collect.ts` reads it once to
 * write `benchmark/images/<role>/`, and after that the committed frame is upright and
 * answers for itself; see `src/frames.ts`. Nothing on the run path opens this file. The
 * list stays committed because a re-freeze rebuilds the frame directory from the shards,
 * and no code can rederive which frames a person turned.
 *
 * Rotation is applied to the pristine dataset frame, never to an already rotated file.
 * Four presses of the arrow key therefore cost one re-encode, not four, and returning to
 * 0 restores the original bytes exactly.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";

export const ROTATIONS_PATH = "benchmark/samples/rotated.txt";

/** Clockwise degrees a frame needs. Nothing else is a rotation of a photograph. */
export type Angle = 90 | 180 | 270;

/** How a frame must be read: `0` means the bytes on disk are already right. */
export type Turn = Angle | 0;

const ANGLES: Record<string, Angle> = { "90": 90, "180": 180, "270": 270 };

/**
 * Quality of the one re-encode a rotated frame gets. 92 matches the value the retired
 * crop pass used, so a rotated frame is no smaller in detail than that pass produced.
 */
const QUALITY = 92;

const HEADER = `# Frames turned upright by review.
#
# One frame per line: <id> <degrees clockwise>. Allowed values are 90, 180 and 270.
#
# This file is a build input, not metadata about a frame. \`npm run collect\` reads it once
# and writes benchmark/images/<role>/ with the rotation already in the pixels. After that
# the committed frame is the picture, and nothing on the run path opens this file.
#
# It stays committed because a re-freeze rebuilds that directory from the OSV-5M shards,
# which ship these frames on their side, and no code can rederive which ones a person
# turned. The rotation is applied to the pristine shard frame, so deleting a line here and
# rebuilding restores the frame exactly as the dataset shipped it.
#
# A frame listed in benchmark/samples/rejected.txt has no line here. It is in no corpus,
# so nothing would ever apply the rotation, and a line nobody reads goes stale unnoticed.
#
# Written by \`npm run review\`. After editing by hand, rebuild the frames:
#   npm run collect
`;

/** The file says something the loader cannot act on. */
export class RotationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationsError";
  }
}

/**
 * Reads the rotation list. A missing file means nothing has been rotated yet, which is a
 * legitimate state and not an error.
 */
export async function loadRotations(path = ROTATIONS_PATH): Promise<Map<string, Angle>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const missing =
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (missing) return new Map();
    throw error;
  }

  const rotations = new Map<string, Angle>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const split = trimmed.search(/\s/);
    if (split === -1) {
      throw new RotationsError(
        `${path}:${index + 1} \`${trimmed}\` has no angle. Write: <id> 90|180|270`,
      );
    }
    const id = trimmed.slice(0, split);
    const angle = ANGLES[trimmed.slice(split).trim()];
    if (angle === undefined) {
      throw new RotationsError(
        `${path}:${index + 1} \`${id}\` has the angle \`${trimmed.slice(split).trim()}\`. ` +
          `Use 90, 180 or 270 clockwise degrees, or delete the line.`,
      );
    }
    if (rotations.has(id)) {
      throw new RotationsError(`${path}:${index + 1} \`${id}\` is listed twice`);
    }
    rotations.set(id, angle);
  }
  return rotations;
}

/**
 * Rewrites the whole list, sorted by id. A rotation can be undone, so lines disappear as
 * well as appear, and appending alone cannot express that.
 */
export async function saveRotations(
  rotations: ReadonlyMap<string, Angle>,
  path = ROTATIONS_PATH,
): Promise<void> {
  const lines = [...rotations.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, angle]) => `${id.padEnd(18)}${angle}`);
  await writeFile(path, `${HEADER}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

let cached: Promise<Map<string, Angle>> | undefined;

/**
 * The verdict for one frame id, read from the list once per process.
 *
 * Deliberately not exported. A reader that can ask for an angle is a reader that can
 * forget to, which is the mistake this module used to invite.
 */
async function rotationOf(id: string): Promise<Turn> {
  cached ??= loadRotations();
  return (await cached).get(id) ?? 0;
}

/** The pristine frame turned upright. The only re-encode a rotated frame gets. */
export function renderRotated(sourcePath: string, angle: Angle): Promise<Buffer> {
  return sharp(sourcePath).rotate(angle).jpeg({ quality: QUALITY }).toBuffer();
}

/**
 * A frame as `src/collect.ts` must write it: original bytes when review left it alone, and
 * the rotated re-encode when review turned it upright. The one place the angle is applied.
 */
export async function frameBytes(sourcePath: string): Promise<{ bytes: Buffer; angle: Turn }> {
  const angle = await rotationOf(basename(sourcePath, extname(sourcePath)));
  const bytes = angle === 0 ? await readFile(sourcePath) : await renderRotated(sourcePath, angle);
  return { bytes, angle };
}
