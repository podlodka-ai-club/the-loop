/**
 * Copies a frozen file snapshot into a hosted memory backend.
 *
 * Hosted backends have no snapshot or restore, so a run against one is only as
 * reproducible as the namespace it reads. Loading from a file snapshot keeps the
 * lesson set identified by its content hash even when the store holding it cannot
 * identify itself - the snapshot id is the thing to quote in a result table.
 *
 * Usage:
 *   node src/load-memory.ts --snapshot <id> [--backend mem0]
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  loadValidatedSnapshotLessons,
  type SnapshotLesson,
} from "./memory/file/memory.ts";
import type { LegacyLessonInput, MemorySnapshotMode } from "./memory/memory.ts";
import { parseBackend, selectMemory } from "./memory/select.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

export function lessonInputFromSnapshot(lesson: SnapshotLesson): LegacyLessonInput {
  return {
    content: lesson.content,
    sourceAttemptId: lesson.sourceAttemptId,
    triggers: [...lesson.triggers],
    region: lesson.region,
    ...(lesson.featureKey === undefined ? {} : { featureKey: lesson.featureKey }),
    ...(lesson.memoryHitId === undefined ? {} : { memoryHitId: lesson.memoryHitId }),
    ...(lesson.effect === undefined ? {} : { effect: lesson.effect }),
    ...(lesson.idempotencyKey === undefined ? {} : { idempotencyKey: lesson.idempotencyKey }),
  };
}

export async function loadSnapshotForImport(
  snapshotId: string,
  mode: MemorySnapshotMode = "dynamic",
): Promise<SnapshotLesson[]> {
  return loadValidatedSnapshotLessons(snapshotId, mode);
}

async function main(): Promise<void> {
  const snapshotId = flag("snapshot", "");
  if (snapshotId === "") {
    console.error("usage: node src/load-memory.ts --snapshot <id> [--backend mem0]");
    process.exitCode = 2;
    return;
  }
  const backend = parseBackend(flag("backend", "mem0"));
  const snapshotMode = flag("snapshot-mode", "dynamic");
  if (snapshotMode !== "dynamic" && snapshotMode !== "legacy") {
    console.error("--snapshot-mode must be dynamic or legacy");
    process.exitCode = 2;
    return;
  }
  const lessons = await loadSnapshotForImport(snapshotId, snapshotMode);

  const { memory, describe } = await selectMemory({ backend, snapshotId, recall: "all", snapshotMode });
  console.log(`source   file snapshot ${snapshotId}, ${lessons.length} lessons`);
  console.log(`target   ${describe}`);

  const before = await memory.recall(["road", "horizon", "vegetation"], 50);
  console.log(`before   namespace answers a broad query with ${before.length} hints`);

  let written = 0;
  for (const lesson of lessons) {
    await memory.remember(lessonInputFromSnapshot(lesson));
    written++;
    if (written % 10 === 0) console.log(`         ${written}/${lessons.length}`);
  }
  console.log(`written  ${written} lessons`);

  // Ingestion is asynchronous. Reading back before it settles would start the run
  // against a half-filled store, and the first images would silently score without
  // memory.
  const after = await memory.recall(["road", "horizon", "vegetation"], 50);
  console.log(`after    the same broad query now returns ${after.length} hints`);
  if (after.length === 0) {
    console.log("warning  nothing is searchable yet - wait and re-check before measuring");
  }
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await main();
}
