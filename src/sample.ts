/**
 * Checks, or freezes, the evaluation sample. Reads local files only.
 *
 * Run this before `src/experiment.ts`. It proves that the clone can score the same
 * 200 images as the reported baseline, and it costs no API calls.
 *
 * Usage:
 *   node src/sample.ts [--manifest PATH]
 *   node src/sample.ts --freeze [--manifest PATH] [--seed osv5m-v1] [--size 200]
 */
import { DEFAULT_MANIFEST, loadFrozenSample, writeManifest } from "./manifest.ts";
import { OSV5M_DIR, drawSample, loadRows } from "./osv5m.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const manifestPath = flag("manifest", DEFAULT_MANIFEST);
const freeze = process.argv.includes("--freeze");

const { rows: pool, csvRowCount } = await loadRows();
console.log(`dataset  ${OSV5M_DIR}`);
console.log(`pool     ${pool.length} images on disk of ${csvRowCount} rows in test.csv`);

if (freeze) {
  const sample = drawSample(pool, { size: Number(flag("size", "200")), seed: flag("seed", "osv5m-v1") });
  await writeManifest(manifestPath, sample);
  console.log(`frozen   ${manifestPath}`);
  console.log(`sample   n=${sample.rows.length} seed=${sample.seed} fp=${sample.fingerprint} strata=${sample.strata}`);
} else {
  const sample = await loadFrozenSample(pool, manifestPath);
  console.log(`manifest ${manifestPath}`);
  console.log(`sample   n=${sample.rows.length} seed=${sample.seed} fp=${sample.fingerprint} strata=${sample.strata}`);
  console.log("ready    every image in the frozen sample is on disk");
}
