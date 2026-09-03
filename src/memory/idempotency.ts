import type { MemoryWriteResult } from "./memory.ts";

/**
 * Process-wide composition-root guard for hosted adapters.
 *
 * Provider calls are not repeated for the same backing memory and idempotency
 * key, even when two adapter instances are created for that memory. The entry
 * is removed only when the provider operation fails, so a successful write is
 * durable for the lifetime of this process.
 */
const completed = new Map<string, Promise<string>>();

type IdempotentWriteValue = string | MemoryWriteResult;

export async function runIdempotentWrite(
  scope: string,
  idempotencyKey: string,
  write: () => Promise<IdempotentWriteValue>,
): Promise<MemoryWriteResult> {
  const key = `${scope}\0${idempotencyKey}`;
  const existing = completed.get(key);
  if (existing !== undefined) {
    return { status: "already_stored", lessonId: await existing };
  }

  const operation = Promise.resolve()
    .then(write)
    .then((value): MemoryWriteResult =>
      typeof value === "string" ? { status: "stored", lessonId: value } : value,
    );
  const lessonId = operation.then((value) => value.lessonId);
  completed.set(key, lessonId);
  try {
    return await operation;
  } catch (error) {
    if (completed.get(key) === lessonId) completed.delete(key);
    throw error;
  }
}
