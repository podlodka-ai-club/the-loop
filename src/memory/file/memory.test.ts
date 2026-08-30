import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LegacyLesson, LegacyLessonInput, LessonInput } from "../memory.ts";
import type { RecallMode } from "./memory.ts";

const memoryDir = await mkdtemp(join(tmpdir(), "loci-file-memory-"));
process.env.MEMORY_DIR = memoryDir;

const { FileMemory, FrozenMemory, parseRecallMode, RECALL_MODES } = await import("./memory.ts");

test.after(async () => rm(memoryDir, { recursive: true, force: true }));

function makePath(): string {
  return join(memoryDir, `${randomUUID()}.jsonl`);
}

function makeLesson(overrides: Partial<LegacyLesson> = {}): LegacyLesson {
  return {
    id: `lesson-${randomUUID()}`,
    content: `lesson-${randomUUID()}`,
    sourceAttemptId: `attempt-${randomUUID()}`,
    triggers: [],
    region: "XX",
    hits: 0,
    wins: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<LegacyLessonInput> = {}): LegacyLessonInput {
  return {
    content: `lesson-${randomUUID()}`,
    sourceAttemptId: `attempt-${randomUUID()}`,
    triggers: [],
    region: "XX",
    ...overrides,
  };
}

function makeSUT({
  path = makePath(),
  mode = "all",
  readOnly = false,
}: Partial<{ path: string; mode: RecallMode; readOnly: boolean }> = {}) {
  const sut = new FileMemory(path, mode, readOnly);
  return { sut, path };
}

async function writeLessons(path: string, lessons: readonly LegacyLesson[]): Promise<void> {
  const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
  await writeFile(path, body === "" ? "" : `${body}\n`, "utf8");
}

async function readLessons(path: string): Promise<LegacyLesson[]> {
  const body = await readFile(path, "utf8");
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LegacyLesson);
}

test("remember creates the directory and appends lessons with sequential ids", async () => {
  const path = join(memoryDir, randomUUID(), "nested", "live.jsonl");
  const { sut } = makeSUT({ path });
  const first = makeInput({ content: "first lesson", sourceAttemptId: "attempt-1" });
  const second = makeInput({ content: "second lesson", sourceAttemptId: "attempt-2" });

  await sut.remember(first);
  await sut.remember(second);

  assert.deepEqual(await readLessons(path), [
    { id: "lesson-0001", ...first, hits: 0, wins: 0 },
    { id: "lesson-0002", ...second, hits: 0, wins: 0 },
  ]);
  assert.equal(await sut.size(), 2);
});

test("remember stores episode provenance and duplicate idempotency returns existing lesson", async () => {
  const { sut, path } = makeSUT();
  const input: LessonInput = {
    content: "Wooden crossarms helped separate the region.",
    sourceAttemptId: "attempt-episode",
    featureKey: "poles",
    memoryHitId: "attempt-episode/poles/hit",
    effect: "helped",
    triggers: ["wooden crossarms"],
    region: "BR",
    idempotencyKey: "attempt-episode:poles:hit",
  };

  assert.deepEqual(await sut.remember(input), { status: "stored", lessonId: "lesson-0001" });
  assert.deepEqual(await sut.remember(input), { status: "already_stored", lessonId: "lesson-0001" });
  assert.deepEqual(await new FileMemory(path).remember(input), {
    status: "already_stored",
    lessonId: "lesson-0001",
  });
  assert.deepEqual(await readLessons(path), [{ id: "lesson-0001", ...input, hits: 0, wins: 0 }]);
  assert.deepEqual(await sut.recall(["wooden crossarms"], 1), [
    {
      lessonId: "lesson-0001",
      text: "BR: Wooden crossarms helped separate the region.",
      featureKey: "poles",
      effect: "helped",
    },
  ]);
});

test("recall rendering keeps non-helped effects visible in text and metadata", async () => {
  const { sut, path } = makeSUT({ mode: "top" });
  const misleading: LessonInput = {
    content: "Single yellow center lines were too broad for this road type.",
    sourceAttemptId: "attempt-negative",
    featureKey: "road_markings",
    memoryHitId: "attempt-negative/road_markings/hit",
    effect: "misleading",
    triggers: ["single yellow center lines"],
    region: "BR",
    idempotencyKey: "attempt-negative:road_markings:hit",
  };
  const insufficient: LessonInput = {
    ...misleading,
    content: "[effect=insufficient] Wooden poles alone were not enough.",
    memoryHitId: "attempt-negative/poles/hit",
    featureKey: "poles",
    effect: "insufficient",
    triggers: ["wooden poles"],
    idempotencyKey: "attempt-negative:poles:hit",
  };
  await sut.remember(misleading);
  await sut.remember(insufficient);

  assert.deepEqual(await readLessons(path), [
    { id: "lesson-0001", ...misleading, hits: 0, wins: 0 },
    { id: "lesson-0002", ...insufficient, hits: 0, wins: 0 },
  ]);
  assert.deepEqual(await sut.recall(["yellow"], 2), [
    {
      lessonId: "lesson-0001",
      text: "BR: [effect=misleading] Single yellow center lines were too broad for this road type.",
      featureKey: "road_markings",
      effect: "misleading",
    },
  ]);
  assert.deepEqual(await sut.recall(["wooden poles"], 2), [
    {
      lessonId: "lesson-0002",
      text: "BR: [effect=insufficient] Wooden poles alone were not enough.",
      featureKey: "poles",
      effect: "insufficient",
    },
  ]);
});

test("recall and size treat a missing store as empty", async () => {
  const { sut, path } = makeSUT();

  assert.deepEqual(await sut.recall(["ignored"]), []);
  assert.equal(await sut.size(), 0);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("recall off returns without reading or changing the store", async () => {
  const { sut, path } = makeSUT({ mode: "off" });
  const malformed = "{not-json}\n";
  await writeFile(path, malformed, "utf8");

  assert.deepEqual(await sut.recall(["anything"], 1), []);
  assert.equal(await readFile(path, "utf8"), malformed);
});

test("recall all returns every lesson in id order and increments every hit", async () => {
  const { sut, path } = makeSUT({ mode: "all" });
  const later = makeLesson({ id: "lesson-0002", content: "later", hits: 4 });
  const earlier = makeLesson({ id: "lesson-0001", content: "earlier", hits: 1 });
  await writeLessons(path, [later, earlier]);

  const hints = await sut.recall(["ignored"], 1);

  assert.deepEqual(hints, [
    { lessonId: "lesson-0001", text: "XX: earlier" },
    { lessonId: "lesson-0002", text: "XX: later" },
  ]);
  assert.deepEqual(await readLessons(path), [
    { ...later, hits: 5 },
    { ...earlier, hits: 2 },
  ]);
});

test("recall top without features uses hit count and stable id ordering", async () => {
  const { sut, path } = makeSUT({ mode: "top" });
  const later = makeLesson({ id: "lesson-0002", content: "later", hits: 4 });
  const earlier = makeLesson({ id: "lesson-0001", content: "earlier", hits: 4 });
  const ignored = makeLesson({ id: "lesson-0003", content: "ignored", hits: 1 });
  await writeLessons(path, [later, earlier, ignored]);

  const hints = await sut.recall([], 2);

  assert.deepEqual(hints, [
    { lessonId: "lesson-0001", text: "XX: earlier" },
    { lessonId: "lesson-0002", text: "XX: later" },
  ]);
  assert.deepEqual(await readLessons(path), [
    { ...later, hits: 5 },
    { ...earlier, hits: 5 },
    ignored,
  ]);
});

test("recall top ranks normalized trigger overlap and breaks ties by id", async () => {
  const { sut, path } = makeSUT({ mode: "top" });
  const second = makeLesson({
    id: "lesson-0002",
    content: "second",
    triggers: ["yellow roadside"],
  });
  const first = makeLesson({
    id: "lesson-0001",
    content: "first",
    triggers: ["yellow dry"],
  });
  const third = makeLesson({ id: "lesson-0003", content: "third", triggers: ["roadside"] });
  await writeLessons(path, [second, first, third]);

  const hints = await sut.recall(["YELLOW, roadside; dry!"], 2);

  assert.deepEqual(hints, [
    { lessonId: "lesson-0001", text: "XX: first" },
    { lessonId: "lesson-0002", text: "XX: second" },
  ]);
  assert.deepEqual(await readLessons(path), [
    { ...second, hits: 1 },
    { ...first, hits: 1 },
    third,
  ]);
});

test("recall top returns no matches without rewriting the store", async () => {
  const { sut, path } = makeSUT({ mode: "top" });
  const lesson = makeLesson({ id: "lesson-0001", triggers: ["roadside"] });
  await writeLessons(path, [lesson]);
  const before = await readFile(path, "utf8");

  assert.deepEqual(await sut.recall(["mountain"], 5), []);
  assert.equal(await readFile(path, "utf8"), before);
});

test("recall propagates malformed JSON from the store", async () => {
  const { sut, path } = makeSUT();
  await writeFile(path, "{not-json}\n", "utf8");

  await assert.rejects(sut.recall([]), SyntaxError);
});

test("parseRecallMode accepts the supported modes and rejects unknown values", () => {
  assert.deepEqual(RECALL_MODES, ["all", "top", "off"]);
  for (const mode of RECALL_MODES) assert.equal(parseRecallMode(mode), mode);
  assert.throws(() => parseRecallMode("unknown"), /unknown recall mode/);
});

test("snapshot writes the content hash and exact JSONL content", async () => {
  const { sut, path } = makeSUT();
  const lesson = makeLesson({ id: "lesson-0001", content: "snapshot lesson" });
  await writeLessons(path, [lesson]);
  const body = JSON.stringify(lesson);
  const expectedId = createHash("sha256").update(body).digest("hex").slice(0, 12);

  const snapshotId = await sut.snapshot();

  assert.equal(snapshotId, expectedId);
  assert.equal(await readFile(join(memoryDir, `${expectedId}.jsonl`), "utf8"), `${body}\n`);
});

test("restore replaces the working store with a frozen snapshot", async () => {
  const { sut, path } = makeSUT();
  const original = makeLesson({ id: "lesson-0001", content: "original" });
  await writeLessons(path, [original]);
  const snapshotId = await sut.snapshot();
  await sut.remember(makeInput({ content: "temporary" }));

  await sut.restore(snapshotId);

  assert.deepEqual(await readLessons(path), [original]);
});

test("FrozenMemory recalls without changing the snapshot and rejects remember", async () => {
  const source = makeSUT();
  const input = makeInput({ content: "frozen lesson" });
  await source.sut.remember(input);
  const snapshotId = await source.sut.snapshot();
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  const before = await readFile(snapshotPath, "utf8");
  const frozen = new FrozenMemory(snapshotId, "all");

  assert.deepEqual(await frozen.recall([]), [{ lessonId: "lesson-0001", text: `XX: ${input.content}` }]);
  assert.equal(await readFile(snapshotPath, "utf8"), before);
  await assert.rejects(frozen.remember(), /FrozenMemory is read-only/);
});
