/**
 * Turns a photo on disk into a data URI for the vision model.
 *
 * There is no transform left here, and that is the point. The file is the picture: a frame
 * under `benchmark/images/` was written upright by `src/collect.ts`, so reading it cannot
 * produce a sideways frame and nothing has to be looked up to find out which way is up.
 * See `src/frames.ts` for why the angle lives in the pixels.
 *
 * Two transforms were tried and both are gone.
 *
 * A crop removed the bottom strip, because some OSV-5M frames are dashcam captures whose
 * burned-in telemetry spells out the ground truth. It was dropped because a crop can only
 * be as good as the detector that sizes it, and a missed detection left a readable
 * coordinate in the corpus. Review reads the whole frame instead and drops it, so there is
 * no strip to remove. Dropping the crop also dropped a re-encode: the crop pass
 * recompressed at quality 92, which grew a median frame from 40 KB to 48 KB while
 * discarding pixels.
 *
 * A rotation turned the few percent of frames OSV-5M stores on their side. It was applied
 * here, per read, from the verdict in `benchmark/samples/rotated.txt`. It moved into the
 * committed file instead, because a reader that has to consult a second file to interpret
 * the first will eventually forget: the two-step observation cached features per path and
 * kept serving them after a frame was turned.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/**
 * The frame's bytes and the data URI built from them.
 *
 * Both from one read, for the caller that needs the pixels for a cache key and the URI for
 * the request. Reading twice would be two chances to disagree about what was sent.
 */
export async function readFrame(imagePath: string): Promise<{ bytes: Buffer; dataUri: string }> {
  const bytes = await readFile(imagePath);
  const mime = extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  return { bytes, dataUri: `data:${mime};base64,${bytes.toString("base64")}` };
}

/** Data URI of the frame exactly as it sits on disk. */
export async function toDataUri(imagePath: string): Promise<string> {
  return (await readFrame(imagePath)).dataUri;
}
