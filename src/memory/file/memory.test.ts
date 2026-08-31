import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFrozenMemorySnapshotBinding,
  isMemoryWriter,
  MemoryBindingError,
  MemoryWriteError,
  sharedMemoryPromptMetadata,
} from "../memory.ts";
import type { LegacyLesson, LegacyLessonInput, LessonInput } from "../memory.ts";
import type { RecallMode } from "./memory.ts";

const memoryDir = await mkdtemp(join(tmpdir(), "loci-file-memory-"));
process.env.MEMORY_DIR = memoryDir;

const { FileMemory, parseRecallMode, RECALL_MODES } = await import("./memory.ts");

test.after(async () => rm(memoryDir, { recursive: true, force: true }));

function makePath(): string {
  return join(memoryDir, `${randomUUID()}.jsonl`);
}

function makeLesson(overrides: Partial<LegacyLesson> = {}): LegacyLesson {
  return {
    id: `lesson-${randomUUID()}`,
    content: `lesson-${randomUUID()}`,
    sourceAttemptId: `attempt-${randomUUID()}`,
    triggers: ["default cue"],
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
    triggers: ["default cue"],
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

test("configured FileMemory exposes the application-owned common prompt metadata", () => {
  assert.deepEqual(makeSUT().sut.promptMetadata, sharedMemoryPromptMetadata());
});

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

test("read-only FileMemory rejects direct remember without changing the store", async () => {
  const { sut, path } = makeSUT({ readOnly: true });
  const existing = makeLesson({ id: "lesson-0001", content: "existing" });
  await writeLessons(path, [existing]);
  const before = await readFile(path, "utf8");

  await assert.rejects(
    sut.remember(makeInput({ content: "new lesson" })),
    (error) => {
      assert.ok(error instanceof MemoryWriteError);
      assert.equal(error.code, "write_failed");
      assert.match(error.message, /FileMemory is read-only/);
      return true;
    },
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("read-only FrozenMemory rejects direct remember with MemoryWriteError", async () => {
  const source = makeSUT();
  const frozen = makeLesson({ id: "lesson-0001", content: "frozen" });
  await writeLessons(source.path, [frozen]);
  const snapshotId = await source.sut.snapshot("legacy");
  const sut = await source.sut.loadSnapshot(snapshotId, "legacy");

  await assert.rejects(
    sut.remember(makeInput({ content: "new frozen lesson" })),
    (error) => {
      assert.ok(error instanceof MemoryWriteError);
      assert.equal(error.code, "write_failed");
      assert.match(error.message, /FrozenMemory is read-only/);
      return true;
    },
  );
  assert.equal(await readFile(source.path, "utf8"), `${JSON.stringify(frozen)}\n`);
});

test("read-only FileMemory rejects direct restore without changing the store", async () => {
  const source = makeSUT();
  const frozen = makeLesson({ id: "lesson-0001", content: "frozen" });
  await writeLessons(source.path, [frozen]);
  const snapshotId = await source.sut.snapshot("legacy");
  const { sut, path } = makeSUT({ readOnly: true });
  const existing = makeLesson({ id: "lesson-0002", content: "existing" });
  await writeLessons(path, [existing]);
  const before = await readFile(path, "utf8");

  await assert.rejects(sut.restore(snapshotId), /FileMemory is read-only/);
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

  const snapshotId = await sut.snapshot("legacy");

  assert.equal(snapshotId, expectedId);
  assert.equal(await readFile(join(memoryDir, `${expectedId}.jsonl`), "utf8"), `${body}\n`);
});

test("loadSnapshot rejects missing, invalid and malformed snapshots with typed failures", async () => {
  const { sut } = makeSUT();

  await assert.rejects(
    sut.loadSnapshot("not-a-snapshot"),
    (error) => error instanceof MemoryBindingError && error.code === "memory_not_found",
  );
  await assert.rejects(
    sut.loadSnapshot("0123456789ab"),
    (error) => error instanceof MemoryBindingError && error.code === "memory_not_found",
  );

  await writeFile(join(memoryDir, "0123456789ab.jsonl"), "{malformed}\n", "utf8");
  await assert.rejects(
    sut.loadSnapshot("0123456789ab"),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
});

test("loadSnapshot rejects every hash-valid semantic lesson violation", async () => {
  const { sut, path } = makeSUT();
  const valid = makeLesson({
    id: "lesson-valid",
    content: "valid lesson",
    sourceAttemptId: "attempt-valid",
    triggers: ["visible cue"],
    region: "BR",
    idempotencyKey: "idempotency-valid",
  });
  const invalidLessons = [
    { name: "content length", lesson: { ...valid, id: "lesson-content", content: "x".repeat(2_001) } },
    { name: "three sentences", lesson: { ...valid, id: "lesson-three-sentences", content: "One. Two. Three." } },
    {
      name: "raw content length before normalization",
      lesson: { ...valid, id: "lesson-raw-content", content: `${"x".repeat(1_999)}${" ".repeat(100)}` },
    },
    { name: "empty triggers", lesson: { ...valid, id: "lesson-empty-triggers", triggers: [] } },
    { name: "too many triggers", lesson: { ...valid, id: "lesson-many-triggers", triggers: Array.from({ length: 9 }, (_value, index) => `cue-${index}`) } },
    { name: "long trigger", lesson: { ...valid, id: "lesson-long-trigger", triggers: ["x".repeat(129)] } },
    { name: "invalid region", lesson: { ...valid, id: "lesson-region", region: "USA" } },
    { name: "duplicate idempotency", lesson: { ...valid, id: "lesson-duplicate", idempotencyKey: valid.idempotencyKey } },
  ];

  for (const scenario of invalidLessons) {
    const lessons = scenario.name === "duplicate idempotency"
      ? [valid, scenario.lesson]
      : [scenario.lesson];
    const body = lessons.map((lesson) => JSON.stringify(lesson)).join("\n");
    const snapshotId = createHash("sha256").update(body).digest("hex").slice(0, 12);
    await writeFile(join(memoryDir, `${snapshotId}.jsonl`), `${body}\n`, "utf8");
    await assert.rejects(
      sut.loadSnapshot(snapshotId),
      (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
      scenario.name,
    );
  }

  const lesson = makeLesson({ id: "lesson-0001", content: "original snapshot content" });
  await writeLessons(path, [lesson]);
  const snapshotId = await sut.snapshot("legacy");
  await writeFile(
    join(memoryDir, `${snapshotId}.jsonl`),
    `${JSON.stringify({ ...lesson, content: "edited snapshot content" })}\n`,
    "utf8",
  );

  await assert.rejects(
    sut.loadSnapshot(snapshotId),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
});

test("dynamic snapshots require complete deterministic provenance and legacy loading is explicit", async () => {
  const { sut, path } = makeSUT();
  const dynamic = {
    id: "lesson-dynamic",
    content: "A dynamic lesson.",
    sourceAttemptId: "attempt-dynamic",
    featureKey: "road_surface",
    memoryHitId: "attempt-dynamic/road_surface/hit",
    effect: "helped" as const,
    triggers: ["paved road"],
    region: "BR",
    idempotencyKey: "not-the-application-key",
    hits: 0,
    wins: 0,
  };
  await writeLessons(path, [dynamic]);
  const body = JSON.stringify(dynamic);
  const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
  await writeFile(join(memoryDir, `${id}.jsonl`), `${body}\n`, "utf8");

  await assert.rejects(
    sut.loadSnapshot(id),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );

  const legacy = makeLesson({ id: "lesson-legacy", content: "Legacy lesson." });
  const legacyBody = JSON.stringify(legacy);
  const legacyId = createHash("sha256").update(legacyBody).digest("hex").slice(0, 12);
  await writeFile(join(memoryDir, `${legacyId}.jsonl`), `${legacyBody}\n`, "utf8");
  await assert.rejects(
    sut.loadSnapshot(legacyId),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
  await assert.doesNotReject(sut.loadSnapshot(legacyId, "legacy"));

  const legacyStore = makeSUT();
  await legacyStore.sut.remember(makeInput({ content: "Legacy lesson." }));
  await assert.rejects(
    legacyStore.sut.snapshot(),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
  await assert.doesNotReject(legacyStore.sut.snapshot("legacy"));
});

test("FileMemory.remember rejects content with more than two sentences before writing", async () => {
  const { sut, path } = makeSUT();

  await assert.rejects(
    sut.remember(makeInput({ content: "One. Two. Three." })),
    /snapshot record .*content is invalid/,
  );
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("snapshot validates the live lesson records before writing a snapshot", async () => {
  const { sut, path } = makeSUT();
  const invalid = {
    id: "lesson-invalid-live",
    content: "x".repeat(2_001),
    sourceAttemptId: "attempt-invalid-live",
    triggers: ["visible cue"],
    region: "BR",
    hits: 0,
    wins: 0,
  };
  await writeFile(path, `${JSON.stringify(invalid)}\n`, "utf8");
  const expectedId = createHash("sha256").update(JSON.stringify(invalid)).digest("hex").slice(0, 12);

  await assert.rejects(
    sut.snapshot(),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
  await assert.rejects(readFile(join(memoryDir, `${expectedId}.jsonl`), "utf8"), { code: "ENOENT" });
});

test("restore replaces the working store with a frozen snapshot", async () => {
  const { sut, path } = makeSUT();
  const original = makeLesson({ id: "lesson-0001", content: "original" });
  await writeLessons(path, [original]);
  const snapshotId = await sut.snapshot("legacy");
  await sut.remember(makeInput({ content: "temporary" }));

  await sut.restore(snapshotId);

  assert.deepEqual(await readLessons(path), [original]);
});

test("FrozenMemory recalls without changing the snapshot and rejects remember", async () => {
  const source = makeSUT();
  const input = makeInput({ content: "frozen lesson", triggers: ["frozen cue"] });
  await source.sut.remember(input);
  const snapshotId = await source.sut.snapshot("legacy");
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  const before = await readFile(snapshotPath, "utf8");
  const frozen = await source.sut.loadSnapshot(snapshotId, "legacy");

  assert.deepEqual(await frozen.recall([]), [{ lessonId: "lesson-0001", text: `XX: ${input.content}` }]);
  assert.equal(await readFile(snapshotPath, "utf8"), before);
  await assert.rejects(frozen.remember(), /FrozenMemory is read-only/);
  await assert.rejects(frozen.restore(snapshotId), /FileMemory is read-only/);
  assert.equal(await readFile(snapshotPath, "utf8"), before);
});

test("FrozenMemory state cannot be changed through runtime property mutation", async () => {
  const source = makeSUT();
  await source.sut.remember(makeInput({ content: "immutable lesson", triggers: ["immutable cue"] }));
  const snapshotId = await source.sut.snapshot("legacy");
  const frozen = await source.sut.loadSnapshot(snapshotId, "legacy");

  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Reflect.set(frozen, "readOnly", false), false);
  assert.equal(Reflect.set(frozen, "snapshotLessons", []), false);
  assert.equal(Reflect.set(frozen, "snapshotId", "other-snapshot"), false);
  assert.throws(
    () => Object.defineProperty(frozen, "readOnly", { value: false }),
    TypeError,
  );

  assert.deepEqual(await frozen.recall("immutable cue", 1), [
    { lessonId: "lesson-0001", text: "XX: immutable lesson" },
  ]);
  await assert.rejects(frozen.remember(), /FrozenMemory is read-only/);
});

test("frozen readers deeply freeze prompts, lessons, and write capabilities", async () => {
  const source = makeSUT();
  await source.sut.remember(makeInput({ content: "nested immutable lesson", triggers: ["nested cue"] }));
  const snapshotId = await source.sut.snapshot("legacy");
  const frozen = await source.sut.loadSnapshot(snapshotId, "legacy");
  const featureScoped = frozen.asFeatureScopedReader();
  const readOnly = frozen.asReadOnlyReader();

  assert.equal(isMemoryWriter(frozen), false);
  for (const reader of [frozen, featureScoped, readOnly]) {
    const metadata = reader.promptMetadata!;
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(Object.isFrozen(metadata.retrieve), true);
    assert.equal(Object.isFrozen(metadata.store), true);
    assert.equal(Object.isFrozen(reader.promptPort), true);
    assert.equal(Object.isFrozen(reader.promptPort!.retrieve), true);
    assert.equal(Object.isFrozen(reader.promptPort!.store), true);
    assert.equal(isMemoryWriter(reader), false);
    assert.equal(Reflect.set(metadata.retrieve, "text", "tampered"), false);
    assert.equal(Reflect.set(metadata.store, "digest", "tampered"), false);
    assert.throws(
      () => Object.defineProperty(metadata.retrieve, "version", { value: "tampered" }),
      TypeError,
    );
    await assert.rejects(reader.promptPort!.store({
      memoryRef: "file",
      operation: "store",
      prompt: metadata.store,
      featureKey: "nested",
      lesson: makeInput({ content: "must not store" }) as LessonInput,
    }), MemoryWriteError);
  }

  assert.notEqual(featureScoped.promptMetadata, frozen.promptMetadata);
  assert.notEqual(readOnly.promptMetadata, frozen.promptMetadata);
  const lessons = (frozen as unknown as {
    snapshotLessons: readonly [{ triggers: readonly string[]; content: string }];
  }).snapshotLessons;
  assert.equal(Object.isFrozen(lessons), true);
  assert.equal(Object.isFrozen(lessons[0]), true);
  assert.equal(Object.isFrozen(lessons[0].triggers), true);
  assert.equal(Reflect.set(lessons[0], "content", "tampered"), false);
  assert.equal(Reflect.set(lessons[0].triggers, "0", "tampered"), false);

  await assert.rejects(frozen.snapshot("legacy"), MemoryWriteError);
  await unlink(join(memoryDir, snapshotId + ".jsonl"));
  await assert.rejects(frozen.snapshot("legacy"), MemoryWriteError);
  await assert.rejects(readFile(join(memoryDir, snapshotId + ".jsonl"), "utf8"), { code: "ENOENT" });
  await assert.rejects(frozen.remember(), MemoryWriteError);
  await assert.rejects(frozen.restore(snapshotId), /FileMemory is read-only/);
});

test("FileMemory shares sentence validation for abbreviations and compact boundaries", async () => {
  const accepted = ["One sentence.", "One sentence. Two sentence!", "Use e.g. this. Fine."];
  for (const content of accepted) {
    const { sut } = makeSUT();
    await assert.doesNotReject(sut.remember(makeInput({ content })));
  }

  const { sut, path } = makeSUT();
  for (const content of ["One. Two.Three.", "One. two.three."]) {
    await assert.rejects(
      sut.remember(makeInput({ content })),
      /snapshot record .*content is invalid/,
    );
  }
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("frozen capability rejects forged readers", async () => {
  const snapshotId = "0123456789ab";
  const live = makeSUT({ mode: "top" }).sut;
  const forged = {
    ...live,
    snapshotId,
  } as unknown as import("../memory.ts").MemoryReader;

  const source = makeSUT();
  await writeLessons(source.path, [makeLesson({ id: "lesson-frozen" })]);

  assert.throws(
    () => createFrozenMemorySnapshotBinding({
      memoryRef: "file",
      snapshotId,
      reader: forged,
    }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
  assert.throws(
    () => createFrozenMemorySnapshotBinding({
      memoryRef: "file",
      snapshotId,
      reader: forged,
    }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );
});

test("validated snapshot projections keep immutable data after the file is changed or removed", async () => {
  const { sut, path } = makeSUT();
  const original = makeLesson({
    id: "lesson-0001",
    content: "original immutable lesson",
    triggers: ["immutable cue"],
    region: "BR",
  });
  await writeLessons(path, [original]);
  const snapshotId = await sut.snapshot("legacy");
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  const selected = await sut.loadSnapshot(snapshotId, "legacy");

  const changed = { ...original, content: "changed live lesson" };
  await writeFile(snapshotPath, `${JSON.stringify(changed)}\n`, "utf8");
  assert.deepEqual(await selected.recall("immutable cue", 1), [
    { lessonId: "lesson-0001", text: "BR: original immutable lesson" },
  ]);

  await unlink(snapshotPath);
  assert.deepEqual(await selected.recall("immutable cue", 1), [
    { lessonId: "lesson-0001", text: "BR: original immutable lesson" },
  ]);
});

test("frozen feature and read-only projections fail closed after their snapshot is removed", async () => {
  const source = makeSUT();
  await source.sut.remember(makeInput({ content: "projection integrity", triggers: ["projection integrity"] }));
  const snapshotId = await source.sut.snapshot("legacy");
  const frozen = await source.sut.loadSnapshot(snapshotId, "legacy");
  const featureScoped = frozen.asFeatureScopedReader();
  const readOnly = frozen.asReadOnlyReader();

  await unlink(join(memoryDir, `${snapshotId}.jsonl`));

  for (const reader of [featureScoped, readOnly]) {
    assert.deepEqual(await reader.recall("projection integrity", 1), [
      { lessonId: "lesson-0001", text: "XX: projection integrity" },
    ]);
  }
});
