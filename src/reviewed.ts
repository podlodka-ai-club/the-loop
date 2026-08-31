/**
 * Frames a person looked at and kept.
 *
 * This file is the other half of `rejects.ts`. Together they record what review saw:
 * an id here was approved, an id there was thrown out, and an id in neither was never
 * shown to anybody.
 *
 * The distinction is load-bearing, which is why the kept list is committed rather than
 * derived. A corpus built from "everything the draw offered minus the rejects" silently
 * includes every frame nobody has judged yet, and the defects review exists to catch -
 * a frame stored upside down above all - are invisible to the automatic screen. So the
 * corpus is built from this list, and an unreviewed frame is simply not in it.
 *
 * A kept frame carries no reason. Approval is the default verdict a reviewer gives, and
 * asking for a sentence to justify "this looks fine" would only produce noise. A
 * rejection is the exception and does need its reason, which is why `rejects.ts` demands
 * one and this file does not.
 */
import { appendFile, readFile } from "node:fs/promises";

export const REVIEWED_PATH = "benchmark/samples/reviewed.txt";

export const REVIEWED_HEADER = `# Frames seen in review and kept.
#
# One id per line. Written by \`npm run review\`, which does not show a listed frame
# again. Delete a line to review that frame once more.
#
# This list is the corpus pool: \`node src/sample.ts --freeze\` builds both corpora from
# it and from nothing else, so a frame nobody has looked at cannot reach a corpus.
#
# A dropped frame is not listed here: it goes to benchmark/samples/rejected.txt with a
# reason, and that file outranks this one.
`;

/**
 * Reads the kept list. A missing file means nothing has been reviewed yet, which is a
 * legitimate state for a fresh clone and not an error.
 */
export async function loadReviewed(path = REVIEWED_PATH): Promise<Set<string>> {
  const text = await readFile(path, "utf8").catch(() => "");
  const kept = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (id !== "" && !id.startsWith("#")) kept.add(id);
  }
  return kept;
}

/** Adds one approved frame. Appending, so an interrupted session keeps its verdicts. */
export async function appendReviewed(id: string, path = REVIEWED_PATH): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => "");
  const head = current === "" ? REVIEWED_HEADER : current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${head}${id}\n`, "utf8");
}
