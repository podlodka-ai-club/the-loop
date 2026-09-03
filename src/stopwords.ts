/**
 * Freezes the list of observation tokens too common to carry a match.
 *
 * Ranking a lesson by raw token overlap gave the match to whichever lesson used the
 * most ordinary words. Every observation names all twelve slots, so `road`, `terrain`
 * and `vegetation` appear in 100% of frames; `grey`, `green` and `flat` in over 85%.
 * A lesson triggered on "paved road" therefore matched a frame in Ethiopia as readily
 * as one in Saxony, and 97% of frames came back with hints regardless of relevance.
 *
 * The list is computed from the observation cache and written to a file rather than
 * derived at run time: a corpus-dependent threshold recomputed on every run would
 * change what memory retrieves without anything in the repository changing.
 *
 * Usage:
 *   node src/stopwords.ts [--threshold 0.30] [--out PATH]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STOPWORDS_PATH =
  process.env.OBSERVE_STOPWORDS ?? join("benchmark", "samples", "observation-stopwords.txt");

const CACHE_DIR = process.env.OBSERVE_CACHE_DIR ?? join("tmp", "cache", "observe");

/** Words a query and a trigger are cut into. Shared with the file memory adapter. */
export function words(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2) out.push(token);
    }
  }
  return out;
}

let cached: Set<string> | undefined;

/** The frozen list, or an empty set when it has not been generated yet. */
export async function loadStopwords(path = STOPWORDS_PATH): Promise<Set<string>> {
  if (cached) return cached;
  try {
    const text = await readFile(path, "utf8");
    // Each line is `token<TAB># frequency`: the frequency is there to be read by a
    // person deciding whether the threshold is right, so only the first field counts.
    cached = new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => line.split(/\s+/)[0] as string),
    );
  } catch {
    cached = new Set();
  }
  return cached;
}

async function main(): Promise<void> {
  const flag = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  const threshold = Number(flag("threshold", "0.30"));
  const out = flag("out", STOPWORDS_PATH);

  const files = (await readdir(CACHE_DIR)).filter((f) => f.endsWith(".json"));
  const documentFrequency = new Map<string, number>();
  let frames = 0;

  for (const file of files) {
    const features = JSON.parse(await readFile(join(CACHE_DIR, file), "utf8")) as unknown;
    if (!Array.isArray(features) || features.length === 0) continue;
    frames++;
    for (const token of new Set(words(features as string[]))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const common = [...documentFrequency.entries()]
    .filter(([, count]) => count / frames > threshold)
    .sort(([a, ca], [b, cb]) => cb - ca || (a < b ? -1 : 1));

  const body = [
    "# Observation tokens too common to carry a match.",
    "# Regenerate with: node src/stopwords.ts",
    `# frames: ${frames}`,
    `# threshold: ${threshold}`,
    ...common.map(([token, count]) => `${token}\t# ${((count / frames) * 100).toFixed(0)}%`),
    "",
  ].join("\n");
  await writeFile(out, body, "utf8");

  console.log(`frames     ${frames} observations in ${CACHE_DIR}`);
  console.log(`tokens     ${documentFrequency.size} distinct`);
  console.log(`stopwords  ${common.length} above ${(threshold * 100).toFixed(0)}% -> ${out}`);
}

if (process.argv[1]?.endsWith("stopwords.ts")) await main();
