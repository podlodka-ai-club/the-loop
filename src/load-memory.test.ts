import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeMemoryIdempotencyKey } from "./memory/provenance.ts";

const memoryDir = await mkdtemp(join(tmpdir(), "loci-load-memory-"));
process.env.MEMORY_DIR = memoryDir;

const { lessonInputFromSnapshot, loadSnapshotForImport } = await import("./load-memory.ts");

test.after(async () => rm(memoryDir, { recursive: true, force: true }));

test("snapshot import validates records before reading and preserves dynamic provenance", async () => {
  const lesson = {
    id: "lesson-0001",
    content: "A useful cue.",
    sourceAttemptId: "attempt-1",
    featureKey: "road_surface",
    memoryHitId: "attempt-1/road_surface/hit",
    effect: "helped" as const,
    triggers: ["paved road"],
    region: "BR",
    idempotencyKey: makeMemoryIdempotencyKey("attempt-1", "road_surface", "attempt-1/road_surface/hit"),
    hits: 0,
    wins: 0,
  };
  const body = JSON.stringify(lesson);
  const snapshotId = createHash("sha256").update(body).digest("hex").slice(0, 12);
  await writeFile(join(memoryDir, `${snapshotId}.jsonl`), `${body}\n`, "utf8");

  assert.deepEqual(lessonInputFromSnapshot(lesson), {
    content: lesson.content,
    sourceAttemptId: lesson.sourceAttemptId,
    featureKey: lesson.featureKey,
    memoryHitId: lesson.memoryHitId,
    effect: lesson.effect,
    triggers: lesson.triggers,
    region: lesson.region,
    idempotencyKey: lesson.idempotencyKey,
  });
  assert.deepEqual(await loadSnapshotForImport(snapshotId), [lesson]);

  const invalid = { ...lesson, id: "lesson-invalid", region: "Brazil" };
  const invalidBody = JSON.stringify(invalid);
  const invalidId = createHash("sha256").update(invalidBody).digest("hex").slice(0, 12);
  await writeFile(join(memoryDir, `${invalidId}.jsonl`), `${invalidBody}\n`, "utf8");
  await assert.rejects(loadSnapshotForImport(invalidId), /snapshot .* is invalid/);
});
