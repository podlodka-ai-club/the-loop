/**
 * Turns a photo on disk into a data URI for the vision model.
 *
 * Frames are sent whole. Nothing is cropped, because the corpus screen in
 * `src/screen.ts` rejects any frame that carries a burned-in overlay, so no strip is
 * left to remove. An earlier design cropped each frame by a per-frame amount recorded
 * in the manifest; it was dropped because a crop can only be as good as the detector
 * that sizes it, and a missed detection left a readable coordinate in the corpus.
 *
 * Sending the original bytes also removes a re-encode. The crop pass recompressed at
 * quality 92, which grew a median frame from 40 KB to 48 KB while discarding pixels.
 *
 * One transform survives, and only for the few percent of frames a person marked in
 * `benchmark/samples/rotated.txt`: OSV-5M bakes rotation into the pixels, and a frame
 * shown to the model upside down is not the frame the reviewer approved. The rotation
 * is a human verdict on a named frame, not a detector output, so it cannot silently
 * damage a frame nobody looked at.
 */
import { extname } from "node:path";
import { frameBytes } from "./rotations.ts";

/** Data URI of the frame as review left it. */
export async function toDataUri(imagePath: string): Promise<string> {
  const { bytes, angle } = await frameBytes(imagePath);
  // A rotated frame comes back re-encoded as JPEG whatever it started as.
  const png = angle === 0 && extname(imagePath).toLowerCase() === ".png";
  return `data:${png ? "image/png" : "image/jpeg"};base64,${bytes.toString("base64")}`;
}
