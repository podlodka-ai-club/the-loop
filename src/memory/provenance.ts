import { createHash } from "node:crypto";

/**
 * The idempotency key is application-owned and derived from the complete
 * episode identity. Keeping this primitive below the tool dispatcher lets
 * persistence validate dynamic snapshots without importing the dispatcher.
 */
export function makeMemoryIdempotencyKey(
  attemptId: string,
  featureKey: string,
  memoryHitId: string | null,
): string {
  return createHash("sha256")
    .update(`${attemptId}\0${featureKey}\0${memoryHitId ?? ""}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
