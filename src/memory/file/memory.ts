/**
 * JSONL-backed Memory adapter.
 *
 * Lessons are stored as one JSON object per line. The file remains readable in a
 * diff, and a control run can swap the whole store for a different file without a
 * migration.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RECALL_LIMIT, renderHint } from "../memory.ts";
import { loadStopwords } from "../../stopwords.ts";
import type { Hint, Lesson, LessonInput, Memory } from "../memory.ts";

export const MEMORY_DIR = process.env.MEMORY_DIR ?? join("data", "memory");

/**
 * How recall decides what to show.
 *
 * `all` - every lesson in the store, no ranking at all. At the scale this project
 *   will reach in a sprint (a few hundred lessons, ~50 tokens each) that is ~10k
 *   tokens against a 262k context, so retrieval buys nothing and costs determinism.
 *   This is the default: it makes the memory-on/memory-off delta measurable today,
 *   and it turns ranking into an optimisation rather than a blocker.
 * `top`  - the ranked subset. See `FileMemory.recall` for what "ranked" means and
 *   why it is weaker than it sounds.
 * `off`  - nothing, even from a populated store. Lets one store serve as its own
 *   control without swapping files.
 */
export type RecallMode = "all" | "top" | "off";

export const RECALL_MODES: readonly RecallMode[] = ["all", "top", "off"];

export function parseRecallMode(value: string): RecallMode {
  if ((RECALL_MODES as readonly string[]).includes(value)) return value as RecallMode;
  throw new Error(`unknown recall mode "${value}", expected one of ${RECALL_MODES.join("|")}`);
}

/**
 * Words that carry a match, which is every word except the ones that carry none.
 *
 * Raw overlap gave the match to whichever lesson used the most ordinary vocabulary.
 * An observation names all twelve slots, so `road`, `terrain` and `vegetation` sit in
 * 100% of frames and `grey`, `green`, `flat` in over 85%; a lesson triggered on
 * "paved road" scored on every frame on Earth. With those dropped, a match has to
 * happen on something the frame actually distinguishes.
 */
function tokenize(values: readonly string[], stopwords: ReadonlySet<string>): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2 && !stopwords.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * How many rare triggers a lesson must share with the observation to be shown.
 *
 * One was too few even after stopwords: a single incidental word opens the prompt to
 * a rule about somewhere else, and a measurement on 430 frames found 97% of them
 * receiving hints regardless of relevance. Two forces the lesson and the frame to
 * agree on more than a coincidence.
 */
const MIN_OVERLAP = Number(process.env.MEMORY_MIN_OVERLAP ?? 2);

function parseLessons(text: string): Lesson[] {
  const lessons: Lesson[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lessons.push(JSON.parse(line) as Lesson);
  }
  return lessons;
}

/**
 * Ranking is deliberately the dumbest thing that can work: overlap between the
 * query's tokens and the lesson's trigger tokens. It is a placeholder for a real
 * retriever, and it is a *useful* placeholder only because it is deterministic -
 * comparing memory-on against memory-off requires that the same features pull the
 * same lessons every time.
 */
export class FileMemory implements Memory {
  readonly path: string;
  readonly mode: RecallMode;
  /** A read-only store never writes back, not even usage counters. */
  protected readonly readOnly: boolean;

  constructor(path = join(MEMORY_DIR, "live.jsonl"), mode: RecallMode = "all", readOnly = false) {
    this.path = path;
    this.mode = mode;
    this.readOnly = readOnly;
  }

  private async load(): Promise<Lesson[]> {
    try {
      return parseLessons(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async recall(features: string[], limit = RECALL_LIMIT): Promise<Hint[]> {
    if (this.mode === "off") return [];

    const lessons = await this.load();
    if (lessons.length === 0) return [];

    // Whole store, in a stable order. No query, no ranking, nothing to go wrong.
    if (this.mode === "all") {
      const every = lessons.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      await this.countHits(every.map((lesson) => lesson.id));
      return every.map(renderHint);
    }

    const stopwords = await loadStopwords();
    const query = tokenize(features, stopwords);

    // No query, no hints.
    //
    // This used to fall back to the most-applied lessons - the same set for every
    // frame, a standing prior rather than retrieval. A prior is exactly what the
    // 863-frame run showed to be harmful: naming 61 regions in every prompt put the
    // prediction inside one of them on 75% of frames against 5% without memory, and
    // on 67% of the frames whose true country no lesson mentions. Memory acted as a
    // menu and the model ordered from it. A frame that matches nothing must therefore
    // see nothing, so that no menu exists where no lesson applies.
    if (query.size === 0) return [];

    const ranked = lessons
      .map((lesson) => {
        const triggers = tokenize(lesson.triggers, stopwords);
        let overlap = 0;
        for (const token of triggers) if (query.has(token)) overlap++;
        return { lesson, overlap };
      })
      .filter((entry) => entry.overlap >= MIN_OVERLAP)
      // Ties break on id so the order never depends on file order or Map iteration.
      .sort((a, b) => b.overlap - a.overlap || (a.lesson.id < b.lesson.id ? -1 : 1))
      .slice(0, limit);

    if (ranked.length > 0) {
      await this.countHits(ranked.map((entry) => entry.lesson.id));
    }
    return ranked.map(({ lesson }) => renderHint(lesson));
  }

  async remember(input: LessonInput): Promise<void> {
    const existing = await this.load();
    const lesson: Lesson = {
      id: `lesson-${String(existing.length + 1).padStart(4, "0")}`,
      content: input.content,
      sourceAttemptId: input.sourceAttemptId,
      triggers: input.triggers,
      region: input.region,
      hits: 0,
      wins: 0,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(lesson)}\n`, "utf8");
  }

  /**
   * Bumps `hits` in place. Rewrites the file: it is small and stays diffable.
   *
   * Skipped entirely on a read-only store. A snapshot is addressed by the hash of
   * its own content, so incrementing a counter inside it would change the id of the
   * thing being measured, mid-measurement.
   */
  private async countHits(ids: readonly string[]): Promise<void> {
    if (this.readOnly) return;
    const bumped = new Set(ids);
    const lessons = (await this.load()).map((lesson) =>
      bumped.has(lesson.id) ? { ...lesson, hits: lesson.hits + 1 } : lesson,
    );
    await this.write(lessons);
  }

  private async write(lessons: readonly Lesson[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    await writeFile(this.path, lessons.length > 0 ? `${body}\n` : "", "utf8");
  }

  /**
   * The snapshot id is the hash of the content, not a counter, so two runs that
   * produced identical memory are provably the same state.
   */
  async snapshot(): Promise<string> {
    const lessons = await this.load();
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
    await mkdir(MEMORY_DIR, { recursive: true });
    await writeFile(join(MEMORY_DIR, `${id}.jsonl`), body === "" ? "" : `${body}\n`, "utf8");
    return id;
  }

  async restore(id: string): Promise<void> {
    const frozen = await readFile(join(MEMORY_DIR, `${id}.jsonl`), "utf8");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, frozen, "utf8");
  }

  async size(): Promise<number> {
    return (await this.load()).length;
  }
}

/** Reads a frozen snapshot without touching the working store. Used by eval runs. */
export class FrozenMemory extends FileMemory {
  constructor(snapshotId: string, mode: RecallMode = "all") {
    super(join(MEMORY_DIR, `${snapshotId}.jsonl`), mode, true);
  }
  override async remember(): Promise<void> {
    throw new Error("FrozenMemory is read-only: evaluation must not write lessons");
  }
}
