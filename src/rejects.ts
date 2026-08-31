/**
 * Frames barred from every corpus by review.
 *
 * The automatic screen in `screen.ts` catches burned-in overlays. It cannot catch
 * everything that makes a frame a bad benchmark item, and the clearest example is
 * orientation: OSV-5M ships a few percent of frames rotated, the rotation is baked into
 * the pixels, and the pixel heuristics tried for it reached only about 68% precision at
 * a useful recall. At that accuracy an automatic rule either discards good frames or
 * keeps bad ones, and a rule that rotates instead of rejecting would corrupt a good
 * frame on every false positive.
 *
 * So a person decides, and the decision is written down here rather than re-derived. The
 * file is committed for the same reason the manifests are: a fresh clone must reach the
 * same corpora, and a judgement that lives only in someone's session is lost.
 *
 * Rejection refills from the ranked pool, so removing a frame costs one candidate out of
 * several times more than a corpus needs. Adding an id here therefore has a bounded
 * price and no effect on any other frame.
 */
import { appendFile, readFile } from "node:fs/promises";

export const REJECTS_PATH = "benchmark/samples/rejected.txt";

/** A rejected frame and why it was rejected. */
export type Reject = { id: string; reason: string };

/** The file says something the loader cannot act on. */
export class RejectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectsError";
  }
}

/**
 * Reads the review list. A missing file means nothing has been rejected yet, which is a
 * legitimate state and not an error.
 *
 * Every entry needs a reason. An id with no reason is how a list becomes undeletable:
 * nobody later can tell whether the frame was upside down or simply disliked, so nobody
 * dares put it back.
 */
export async function loadRejects(path = REJECTS_PATH): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const missing =
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (missing) return new Map();
    throw error;
  }

  const rejects = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const split = trimmed.search(/\s/);
    if (split === -1) {
      throw new RejectsError(`${path}:${index + 1} \`${trimmed}\` has no reason. Write: <id> <why>`);
    }
    const id = trimmed.slice(0, split);
    const reason = trimmed.slice(split).trim();
    if (reason === "") {
      throw new RejectsError(`${path}:${index + 1} \`${id}\` has no reason. Write: <id> <why>`);
    }
    if (rejects.has(id)) {
      throw new RejectsError(`${path}:${index + 1} \`${id}\` is listed twice`);
    }
    rejects.set(id, reason);
  }
  return rejects;
}

/**
 * Adds one frame to the review list.
 *
 * Appends rather than rewrites, because the committed lines carry reasons written by
 * hand and a rewrite would have to reproduce them. The caller is expected to have read
 * the list already, so a duplicate id is a caller bug and stops here rather than
 * quietly growing the file.
 */
export async function appendReject(
  id: string,
  reason: string,
  path = REJECTS_PATH,
): Promise<void> {
  const text = reason.trim();
  if (text === "") throw new RejectsError(`\`${id}\` needs a reason. Write: <id> <why>`);
  if ((await loadRejects(path)).has(id)) {
    throw new RejectsError(`\`${id}\` is already listed in ${path}`);
  }
  // A file whose last line lacks its newline would otherwise swallow the new entry.
  const current = await readFile(path, "utf8").catch(() => "");
  const gap = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${gap}${id.padEnd(18)}${text}\n`, "utf8");
}
