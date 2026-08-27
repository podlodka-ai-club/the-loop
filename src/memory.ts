/**
 * Memory: lessons the agent wrote about its own past attempts, and the retrieval
 * that puts them back in front of it.
 *
 * Stored as JSONL, one lesson per line, never a database. Two reasons: a lesson has
 * to be readable in a diff, and a control run has to be able to swap the whole store
 * for a different file without a migration.
 *
 * The lesson body is free text, matching `memory_note` in docs/workflows/models.md.
 * Everything a retriever needs to rank it lives outside that text, so ranking never
 * has to parse prose.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MEMORY_DIR = process.env.MEMORY_DIR ?? join("data", "memory");

/** Default number of lessons a single recall may put into the prompt. */
export const RECALL_LIMIT = Number(process.env.MEMORY_RECALL_LIMIT ?? 5);

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

export type Lesson = {
  id: string;
  /** Free text, the transferable part. Written by the model during reflection. */
  content: string;
  /** Which attempt produced it, so a lesson can be traced back to its episode. */
  sourceAttemptId: string;
  /** Observable features that make this lesson relevant. Used for ranking. */
  triggers: string[];
  /** Country or area the lesson talks about. Diagnostic, not used for ranking. */
  region: string;
  /** Times the lesson reached a prompt. */
  hits: number;
  /** Times it reached a prompt and the guess landed closer than the run baseline. */
  wins: number;
};

/** What reflection produces, before the store assigns provenance and counters. */
export type LessonInput = {
  content: string;
  sourceAttemptId: string;
  triggers: string[];
  region: string;
};

export type Hint = {
  lessonId: string;
  text: string;
};

export interface Memory {
  /** Lessons worth showing, most relevant first. Never throws on an empty store. */
  recall(features: string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<void>;
  /** Freezes the current store to its own file and returns that file's id. */
  snapshot(): Promise<string>;
  /** Replaces the working store with a frozen one. */
  restore(id: string): Promise<void>;
}

/** Baseline: the agent never sees a lesson. Every memory-off run uses this. */
export class NullMemory implements Memory {
  async recall(): Promise<Hint[]> {
    return [];
  }
  async remember(): Promise<void> {}
  async snapshot(): Promise<string> {
    return "null";
  }
  async restore(id: string): Promise<void> {
    if (id !== "null") throw new Error(`NullMemory cannot restore snapshot ${id}`);
  }
}

/** Lowercased word set, so ranking compares features the way they were written. */
function tokenize(values: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2) tokens.add(token);
    }
  }
  return tokens;
}

function parseLessons(text: string): Lesson[] {
  const lessons: Lesson[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lessons.push(JSON.parse(line) as Lesson);
  }
  return lessons;
}

/**
 * JSONL-backed store.
 *
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
      return every.map((lesson) => ({ lessonId: lesson.id, text: lesson.content }));
    }

    const query = tokenize(features);

    // NOT retrieval. With no observed features there is no query to rank against, so
    // this returns the most-applied lessons - the same set for every task, i.e. a
    // global prior. It is listed under `top` for continuity, but read it as "the
    // memory the agent always carries", not "the memory relevant to this image".
    // Real ranking needs a query, which needs something to have looked at the frame
    // first - see the two-step mode.
    if (query.size === 0) {
      const prior = lessons
        .slice()
        .sort((a, b) => b.hits - a.hits || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
      await this.countHits(prior.map((lesson) => lesson.id));
      return prior.map((lesson) => ({ lessonId: lesson.id, text: lesson.content }));
    }

    const ranked = lessons
      .map((lesson) => {
        const triggers = tokenize(lesson.triggers);
        let overlap = 0;
        for (const token of triggers) if (query.has(token)) overlap++;
        return { lesson, overlap };
      })
      .filter((entry) => entry.overlap > 0)
      // Ties break on id so the order never depends on file order or Map iteration.
      .sort((a, b) => b.overlap - a.overlap || (a.lesson.id < b.lesson.id ? -1 : 1))
      .slice(0, limit);

    if (ranked.length > 0) {
      await this.countHits(ranked.map((entry) => entry.lesson.id));
    }
    return ranked.map(({ lesson }) => ({ lessonId: lesson.id, text: lesson.content }));
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
