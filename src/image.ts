/**
 * Turns a photo on disk into a data URI for the vision model, with the bottom strip
 * removed.
 *
 * Why the crop: some OSV-5M images are dashcam frames with a burned-in telemetry
 * overlay that spells out the exact ground-truth coordinates, for example
 * `2017-11-02 02:18:08Z -32.9596S 149.8421E 804M 298D 68.709KPH`. A vision model
 * reads that text and returns the label. In a 24-image sample, 3 predictions matched
 * ground truth to four decimal places for this reason, which put acc@1km at 12.5%.
 * Cropping the strip removes the leak.
 *
 * Cropped bytes are cached on disk, so repeated runs over a frozen sample pay the
 * decode cost once.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";

/**
 * Fraction of image height removed from the bottom. The observed overlay is ~16 px
 * of 512, or 3.1%, so 5% clears it with margin while costing only road surface.
 */
export const CROP_BOTTOM_FRACTION = Number(process.env.GEOLOCATE_CROP_BOTTOM ?? 0.05);

const CACHE_DIR = join(
  process.env.GEOLOCATE_CACHE_DIR ?? join("tmp", "cache"),
  `crop-${CROP_BOTTOM_FRACTION}`,
);

let cacheReady: Promise<unknown> | undefined;

async function cropped(imagePath: string): Promise<Buffer> {
  const key = createHash("sha256").update(imagePath).digest("hex").slice(0, 16);
  const cachePath = join(CACHE_DIR, `${basename(imagePath, extname(imagePath))}-${key}.jpg`);

  try {
    return await readFile(cachePath);
  } catch {
    // Not cached yet.
  }

  const image = sharp(imagePath);
  const { width, height } = await image.metadata();
  if (width === undefined || height === undefined) {
    throw new Error(`cannot read image dimensions: ${imagePath}`);
  }
  const keep = Math.max(1, Math.round(height * (1 - CROP_BOTTOM_FRACTION)));
  const bytes = await image
    .extract({ left: 0, top: 0, width, height: keep })
    .jpeg({ quality: 92 })
    .toBuffer();

  cacheReady ??= mkdir(CACHE_DIR, { recursive: true });
  await cacheReady;
  await writeFile(cachePath, bytes);
  return bytes;
}

/** JPEG data URI with the telemetry strip removed. */
export async function toDataUri(imagePath: string): Promise<string> {
  if (CROP_BOTTOM_FRACTION <= 0) {
    const mime = extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${(await readFile(imagePath)).toString("base64")}`;
  }
  return `data:image/jpeg;base64,${(await cropped(imagePath)).toString("base64")}`;
}
