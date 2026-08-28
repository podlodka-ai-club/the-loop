export type XmemoryMemoryErrorCode =
  | "unsupported_operation"
  | "unsupported_configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "instance_not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "write_failed"
  | "write_outcome_unknown"
  | "observer_failed"
  | "protocol_error"
  | "schema_mismatch"
  | "provisioning_conflict"
  | "provision_outcome_unknown"
  | "instance_quarantined";

export type XmemoryOperation =
  | "schema"
  | "provision"
  | "write"
  | "read"
  | "snapshot"
  | "restore";

type XmemoryMemoryErrorOptions = { traceId?: string };

const RETRYABLE_READ_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "rate_limited",
  "unavailable",
]);

/** Stable sanitized error surface. Raw provider failures are never retained as causes. */
export class XmemoryMemoryError extends Error {
  readonly code: XmemoryMemoryErrorCode;
  readonly operation: XmemoryOperation;
  readonly retryable: boolean;
  readonly traceId?: string;

  constructor(
    code: XmemoryMemoryErrorCode,
    operation: XmemoryOperation,
    message: string,
    options: XmemoryMemoryErrorOptions = {},
  ) {
    super(message);
    this.name = "XmemoryMemoryError";
    this.code = code;
    this.operation = operation;
    this.retryable = operation === "read" && RETRYABLE_READ_CODES.has(code);
    if (options.traceId !== undefined) this.traceId = options.traceId;
  }
}

/** Conservative transport detection for injected ports outside the SDK adapter boundary. */
export function isXmemoryUnavailableCause(error: unknown): boolean {
  try {
    if (error instanceof TypeError) return true;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
    const value = error as Record<string, unknown>;
    if (value.name === "AbortError" || value.name === "TimeoutError") return true;
    if (
      value.code === "ECONNRESET" ||
      value.code === "ECONNREFUSED" ||
      value.code === "ENOTFOUND" ||
      value.code === "EAI_AGAIN" ||
      value.code === "ETIMEDOUT"
    ) {
      return true;
    }
    return (
      typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      (value.status === 408 || (value.status >= 500 && value.status <= 599))
    );
  } catch {
    return false;
  }
}
