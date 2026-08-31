/**
 * Decides whether a frame may enter a benchmark corpus.
 *
 * One defect is screened here, and it is rejected rather than repaired: a burned-in
 * overlay such as `62km/h N54.527850 E25.739254` or `4.241, 103.42229, 12.0m, 288°`. A
 * vision model reads that text and returns the ground truth instead of a guess.
 *
 * Cropping the strip away was tried first and abandoned: a crop has to decide how deep
 * to cut, that decision rests on detecting the strip, and a detector that misses one
 * strip leaves a readable coordinate in the corpus. Rejection has no such failure mode -
 * a missed detection costs a candidate, never a leak, and the pool holds several times
 * the frames a corpus needs.
 *
 * Only overlays are decided here. Defects that need judgement rather than a rule are
 * listed by a person in `rejects.ts`, and orientation is the one that forced that split:
 * OSV-5M ships a few percent of frames rotated with the rotation baked into the pixels,
 * and the sky-position heuristics tried for it reached only about 68% precision at a
 * useful recall. A rule that wrong either discards good frames or keeps bad ones, so no
 * orientation rule runs here.
 *
 * Every candidate goes to OCR. An earlier version gated OCR behind a cheap pixel test
 * for bright glyphs on a dark bar, which cut the pass from 13 minutes to 3. The gate was
 * unsound: an overlay printed straight onto bright road has no dark bar, so the test
 * never fired and the frame never reached OCR. Measured recall of that gate on leaking
 * frames was about 11%. The minutes are not worth a heuristic about what an overlay
 * looks like, so the gate is gone.
 *
 * Reading is an ensemble, and the axes are not decoration. Each one was added because
 * a frame escaped every configuration that lacked it:
 *  - Scale. A crisp modern readout reads at 2x; a ~7 px dashcam clock needs 4x.
 *  - Polarity. Strips come bright-on-dark and dark-on-bright.
 *  - Page segmentation. `SPARSE_TEXT` finds readouts scattered in corners, and misses
 *    `93km/h N54.489289 E25.836008` on frame 460108105293056, which `SINGLE_BLOCK`
 *    reads. Neither mode dominates the other.
 *  - Crop depth. A wide band lets global contrast stretch on road and flatten a small
 *    readout glued to the edge, so a shallow strip is read separately.
 * OCR output is unstable under small changes - the same frame reads differently from a
 * PNG and a JPEG of identical pixels - so coverage comes from breadth, never from one
 * tuned recipe.
 *
 * Only the bottom of the frame is inspected. Text elsewhere - a shop sign, a road sign
 * - is scene evidence the benchmark is about, and reading it is the skill under test.
 *
 * That choice assumes the frame is upright, because a frame stored upside down carries
 * its strip at the top, where this screen does not look. The assumption was checked
 * rather than trusted: OCR over the top band of the 368 most suspect frames returned two
 * hits, both phantom words, no coordinate and no date.
 *
 * `tesseract.js` is loaded by a dynamic import inside the pool factory, never at
 * module load, so a process that imports a constant from here does not pay the WASM
 * core load.
 */
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Scheduler } from "tesseract.js";

/** Below this, a "word" is road texture rather than ink. Phantom words are common. */
const MIN_WORD_CONFIDENCE = 60;

/**
 * Confident words on one OCR line that make a frame an overlay frame.
 *
 * The count must be per line, not pooled. An earlier version counted distinct words
 * across the whole band and every view, which rejected 26% of candidates: tesseract
 * reads isolated two-letter tokens off gravel, foliage and lane markings, and several
 * views of one frame supply plenty of them. Worse than the waste, those phantoms come
 * from textured surfaces, so pooling biased the corpus away from visually busy scenes.
 *
 * Line coherence separates the two cleanly. Measured over 18 frames whose band shows
 * no readout, the maximum words on any one line was 1 in every case. Of 16 visually
 * confirmed overlays, 13 put 2 or more words on a line; the rest are single readouts
 * such as `25/07/2020` that the date classifier catches on its own.
 *
 * The rule applies to `sparse` views only. `SINGLE_BLOCK` is in the ensemble because
 * it reads coordinate text that sparse layout misses, not because it groups lines
 * well - it forces the whole crop into one block, so road texture arrives as long
 * confident-looking lines. Applying the rule to both layouts pushed rejection from
 * 1.8% to 7.8% with no extra overlay caught.
 */
const MIN_LINE_WORDS = 2;

/** Page segmentation modes the ensemble spans. Values match tesseract's PSM enum. */
type Layout = "sparse" | "block";

type View = {
  /** Share of frame height to read. */
  fraction: number;
  /** Output width, as a multiple of frame width. */
  upscale?: number;
  /** Output width in pixels, for views that must see a fixed glyph scale. */
  fitWidth?: number;
  negate: boolean;
  layout: Layout;
};

const VIEWS: readonly View[] = [
  { fraction: 0.25, upscale: 2, negate: false, layout: "sparse" },
  { fraction: 0.25, upscale: 2, negate: true, layout: "sparse" },
  { fraction: 0.25, upscale: 4, negate: false, layout: "sparse" },
  { fraction: 0.25, upscale: 4, negate: true, layout: "sparse" },
  { fraction: 0.16, upscale: 4, negate: false, layout: "block" },
  { fraction: 0.16, upscale: 4, negate: true, layout: "block" },
  { fraction: 0.06, fitWidth: 1600, negate: false, layout: "block" },
  { fraction: 0.06, fitWidth: 1600, negate: true, layout: "block" },
];

/** Keeps `eng.traineddata` out of the repository root, which is where it lands by default. */
const OCR_CACHE_DIR = join(process.env["GEOLOCATE_CACHE_DIR"] ?? join("tmp", "cache"), "tesseract");

/**
 * Total OCR workers, split across the two layout pools. A single worker would
 * serialise the whole freeze: measured throughput is about 2.4 recognitions per
 * second per worker.
 */
const OCR_WORKERS = Number(process.env["GEOLOCATE_OCR_WORKERS"] ?? Math.min(8, availableParallelism()));

/** Why a frame may not enter a corpus. */
export type ScreenReason = "coordinates" | "timestamp" | "text";

export type Screen =
  | { ok: true }
  | { ok: false; reason: ScreenReason; text: string };

// Page segmentation is worker state, not a per-job argument, so a scheduler cannot mix
// the two modes without racing. One pool per layout keeps each worker's mode fixed.
const pools = new Map<Layout, Promise<Scheduler>>();

function ocr(layout: Layout): Promise<Scheduler> {
  let pool = pools.get(layout);
  if (pool === undefined) {
    pool = (async () => {
      const [{ createScheduler, createWorker, OEM, PSM }] = await Promise.all([
        import("tesseract.js"),
        mkdir(OCR_CACHE_DIR, { recursive: true }),
      ]);
      const mode = layout === "sparse" ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK;
      const scheduler = createScheduler();
      const size = Math.max(1, Math.round(OCR_WORKERS / 2));
      const workers = await Promise.all(
        Array.from({ length: size }, async () => {
          const worker = await createWorker("eng", OEM.LSTM_ONLY, { cachePath: OCR_CACHE_DIR });
          await worker.setParameters({ tessedit_pageseg_mode: mode });
          return worker;
        }),
      );
      for (const worker of workers) scheduler.addWorker(worker);
      return scheduler;
    })();
    pools.set(layout, pool);
  }
  return pool;
}

/** Releases every OCR pool. A CLI must call this or the process will not exit. */
export async function closeOcr(): Promise<void> {
  const pending = [...pools.values()];
  pools.clear();
  await Promise.all(pending.map(async (pool) => (await pool).terminate()));
}

/**
 * A hemisphere letter next to a decimal degree, for example `N54.527850` or
 * `-32.9596S`. Three fraction digits is already about 100 m, which is inside the
 * tightest metric the benchmark scores.
 */
const HEMISPHERE_LEADING = /(?<![A-Za-z\d])[NSEW]\s?-?\d{1,3}[.,\s]\d{3,}/i;
const HEMISPHERE_TRAILING = /-?\d{1,3}[.,\s]\d{3,}\s?[NSEW](?![A-Za-z\d])/i;

/**
 * Any decimal number with four or more fraction digits. Four decimals of a degree is
 * about 11 m, and nothing else printed on a dashcam frame carries that precision. The
 * separator may be a comma: `N54,489289` is how frame 460108105293056 prints it.
 */
const HIGH_PRECISION = /(?<![.,\d])-?\d{1,3}[.,]\d{4,}(?!\d)/;

/** A signed degree whose separator OCR lost, for example `-34 06945`. */
const SIGNED_DEGREE = /(?<![.,\d])-\d{1,3}[.,\s]\d{4,}(?!\d)/;

/**
 * Degrees, minutes and optional seconds, for example `54° 31' 40"`. The minutes part
 * is required, so a plain `25°C` temperature readout does not match.
 */
const DMS = /\d{1,3}\s*°\s*\d{1,2}\s*['\u2032\u2019](?:\s*\d{1,2}(?:[.,]\d+)?\s*(?:["\u2033\u201d]|''))?/;

/**
 * `2017/09/10`, `2017-09-10` and `10.09.2017`. The separator must repeat and the parts
 * must form a plausible date, so a version string or a score line does not match.
 */
const DATE_YMD = /(?<!\d)(\d{4})([./:-])(\d{1,2})\2(\d{1,2})/;
const DATE_DMY = /(?<!\d)(\d{1,2})([./:-])(\d{1,2})\2(\d{4})(?!\d)/;

/**
 * The same date with no separators at all, for example `20180807`. It is anchored on a
 * plausible year so that an eight digit device serial does not match.
 */
const DATE_COMPACT = /(?<!\d)(19\d{2}|20\d{2})(\d{2})(\d{2})(?!\d)/;

/** Pure classifier over band text. Exported so the parent can unit-check it. */
export function classifyBandText(text: string): { leaked: boolean; reason: ScreenReason | "" } {
  const probe = text.replace(/\s+/g, " ");
  // Coordinates are tested first: a frame that shows a coordinate and a timestamp
  // gains nothing from being filed under the weaker signal.
  const coordinate =
    HEMISPHERE_LEADING.test(probe) ||
    HEMISPHERE_TRAILING.test(probe) ||
    HIGH_PRECISION.test(probe) ||
    SIGNED_DEGREE.test(probe) ||
    DMS.test(probe);
  if (coordinate) return { leaked: true, reason: "coordinates" };
  if (hasFullDate(probe)) return { leaked: true, reason: "timestamp" };
  return { leaked: false, reason: "" };
}

function hasFullDate(text: string): boolean {
  const ymd = DATE_YMD.exec(text);
  if (ymd !== null && plausibleDate(ymd[1], ymd[3], ymd[4])) return true;
  const dmy = DATE_DMY.exec(text);
  // Day-month order is not knowable from the digits alone: `02/26/2019` is US order and
  // `26/02/2019` is not. Either reading counts. Requiring day-month order let frame
  // 285404933162215 into a corpus with `02/26/2019 15:17:24` printed on the bonnet.
  if (dmy !== null && (plausibleDate(dmy[4], dmy[3], dmy[1]) || plausibleDate(dmy[4], dmy[1], dmy[3]))) {
    return true;
  }
  const compact = DATE_COMPACT.exec(text);
  return compact !== null && plausibleDate(compact[1], compact[2], compact[3]);
}

function plausibleDate(year?: string, month?: string, day?: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  // Mapillary opened in 2013; the split ends in 2023. The bound stays loose because a
  // wrong dashcam clock is common, and a false positive costs one frame of thousands.
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** One view's confident tokens, and the most it put on any single line. */
type Reading = { words: string[]; maxLineWords: number };

/** Confident, word-like tokens in one preprocessed view of the frame bottom. */
async function readView(imagePath: string, width: number, height: number, view: View): Promise<Reading> {
  const tall = Math.max(1, Math.round(height * view.fraction));
  let pipe = sharp(imagePath)
    .extract({ left: 0, top: height - tall, width, height: tall })
    .greyscale()
    .normalise()
    .resize({ width: view.fitWidth ?? width * (view.upscale ?? 1), kernel: "lanczos3" });
  if (view.negate) pipe = pipe.negate();

  const scheduler = await ocr(view.layout);
  const { data } = await scheduler.addJob("recognize", await pipe.png().toBuffer(), undefined, { blocks: true });

  const words: string[] = [];
  let maxLineWords = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        let onLine = 0;
        for (const word of line.words) {
          if (word.confidence < MIN_WORD_CONFIDENCE) continue;
          const text = word.text.trim();
          // A lone glyph or a run of punctuation is texture, never a readout: every
          // real token in this dataset holds at least two characters and an
          // alphanumeric.
          if (text.length < 2 || !/[A-Za-z0-9]/.test(text)) continue;
          words.push(text);
          onLine++;
        }
        maxLineWords = Math.max(maxLineWords, onLine);
      }
    }
  }
  return { words, maxLineWords };
}

/** Decides whether one frame is clean enough to enter a corpus. */
export async function screenFrame(imagePath: string): Promise<Screen> {
  const { width, height } = await sharp(imagePath).metadata();
  if (width === undefined || height === undefined) {
    throw new Error(`cannot read image dimensions: ${imagePath}`);
  }

  // Text accumulates across views so that two views reading one half each of
  // `21/12/2020 14:12:02` still classify as a date. The reject count does not
  // accumulate: it is the most words any one view put on any one line, because that
  // is what distinguishes a readout from several sightings of the same phantom token.
  const seen = new Map<string, string>();
  for (const view of VIEWS) {
    const reading = await readView(imagePath, width, height, view);
    for (const word of reading.words) seen.set(word.toLowerCase(), word);

    const text = [...seen.values()].join(" ");
    const { leaked, reason } = classifyBandText(text);
    if (leaked && reason !== "") return { ok: false, reason, text };
    if (view.layout === "sparse" && reading.maxLineWords >= MIN_LINE_WORDS) {
      return { ok: false, reason: "text", text };
    }
  }
  return { ok: true };
}
