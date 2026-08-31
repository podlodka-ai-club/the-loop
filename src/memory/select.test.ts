import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryBindingError } from "./memory.ts";
import { makeMemoryIdempotencyKey } from "./provenance.ts";

const memoryDir = await mkdtemp(join(tmpdir(), "loci-memory-selection-"));
process.env.MEMORY_DIR = memoryDir;

const { selectFeatureScopedEvaluationMemory, selectMemory } = await import("./select.ts");

test.after(async () => rm(memoryDir, { recursive: true, force: true }));

test("legacy file selection fails closed for missing and semantically invalid snapshots", async () => {
  await assert.rejects(
    selectMemory({ backend: "file", snapshotId: "ffffffffffff", recall: "top", snapshotMode: "legacy" }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_not_found",
  );

  const invalidBody = "{}";
  const invalidId = createHash("sha256").update(invalidBody).digest("hex").slice(0, 12);
  await writeFile(join(memoryDir, `${invalidId}.jsonl`), `${invalidBody}\n`, "utf8");

  await assert.rejects(
    selectMemory({ backend: "file", snapshotId: invalidId, recall: "top", snapshotMode: "legacy" }),
    (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
  );

  let providerCalls = 0;
  const validLesson = {
    id: "lesson-valid",
    content: "valid lesson",
    sourceAttemptId: "attempt-valid",
    triggers: ["visible cue"],
    region: "BR",
    hits: 0,
    wins: 0,
    idempotencyKey: "idempotency-valid",
  };
  for (const lesson of [
    { ...validLesson, id: "lesson-content", content: "x".repeat(2_001) },
    { ...validLesson, id: "lesson-triggers", triggers: Array.from({ length: 9 }, (_value, index) => `cue-${index}`) },
    { ...validLesson, id: "lesson-trigger-length", triggers: ["x".repeat(129)] },
    { ...validLesson, id: "lesson-region", region: "Brazil" },
  ]) {
    const body = JSON.stringify(lesson);
    const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
    await writeFile(join(memoryDir, `${id}.jsonl`), `${body}\n`, "utf8");
    await assert.rejects(
      selectFeatureScopedEvaluationMemory({
        backend: "file",
        snapshotId: id,
        recall: "top",
        memoryMode: "warm",
      }),
      (error) => error instanceof MemoryBindingError && error.code === "memory_mismatch",
    );
  }
  assert.equal(providerCalls, 0);
});

test("evaluation selection keeps an immutable snapshot after the source file is modified or removed", async () => {
  const lesson = {
    id: "lesson-immutable",
    content: "the selected snapshot lesson",
    sourceAttemptId: "attempt-immutable",
    featureKey: "road_surface",
    memoryHitId: "attempt-immutable/road_surface/hit",
    effect: "helped" as const,
    triggers: ["selected cue"],
    region: "BR",
    hits: 0,
    wins: 0,
    idempotencyKey: makeMemoryIdempotencyKey(
      "attempt-immutable",
      "road_surface",
      "attempt-immutable/road_surface/hit",
    ),
  };
  const body = JSON.stringify(lesson);
  const snapshotId = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const snapshotPath = join(memoryDir, `${snapshotId}.jsonl`);
  await writeFile(snapshotPath, `${body}\n`, "utf8");

  const selection = await selectFeatureScopedEvaluationMemory({
    backend: "file",
    snapshotId,
    recall: "top",
    memoryMode: "warm",
  });
  await writeFile(snapshotPath, `${JSON.stringify({ ...lesson, content: "changed live lesson" })}\n`, "utf8");
  assert.deepEqual(await selection.memoryBinding.reader.recall("selected cue", 1), [
    {
      lessonId: "lesson-immutable",
      text: "BR: the selected snapshot lesson",
      featureKey: "road_surface",
      effect: "helped",
    },
  ]);

  await unlink(snapshotPath);
  assert.deepEqual(await selection.memoryBinding.reader.recall("selected cue", 1), [
    {
      lessonId: "lesson-immutable",
      text: "BR: the selected snapshot lesson",
      featureKey: "road_surface",
      effect: "helped",
    },
  ]);
});
