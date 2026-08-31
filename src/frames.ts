/**
 * Where a corpus frame lives, and the rule that makes the file the whole truth about it.
 *
 * A frame under `benchmark/images/<role>/` is the picture, finished. If OSV-5M shipped it
 * on its side, the file here is already turned upright: nothing a reader has to look up
 * separately, no orientation to apply, no chance of applying it twice. `toDataUri` reads
 * the bytes and sends them.
 *
 * It used to work the other way. The frame came from the OSV-5M shards and every reader
 * was expected to consult `benchmark/samples/rotated.txt` on the way past. That put a fact
 * about the picture next to the picture instead of in it, and the cost showed up quickly:
 * the two-step observation cached its features per path, so a frame turned upright after a
 * run kept answering with the features of the orientation review had rejected. The bug was
 * not the cache. The bug was that a reader could take the pixels and miss the angle.
 *
 * `rotated.txt` still exists and is still committed, because `src/collect.ts` has to be
 * able to rebuild this directory from the shards after a re-freeze and cannot rederive
 * which frames a person turned. It is a build input, read once by the builder, and it is
 * never consulted when a frame is read.
 */
import { join } from "node:path";

export const FRAMES_ROOT = join("benchmark", "images");

/** The directory holding one corpus's frames. A retired corpus has none on disk. */
export function frameDir(role: string): string {
  return join(FRAMES_ROOT, role);
}

/**
 * The one path a frame is read from.
 *
 * Ids are validated where they enter the process - a manifest body line must be a bare id,
 * and the review app serves only `[0-9A-Za-z_-]+` - so this joins rather than sanitises.
 */
export function framePath(role: string, id: string): string {
  return join(frameDir(role), `${id}.jpg`);
}
