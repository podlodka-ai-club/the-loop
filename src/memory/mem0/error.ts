export type Mem0MemoryErrorCode =
  | "unsupported_operation"
  | "unsupported_configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "ingestion_failed"
  | "ingestion_outcome_unknown"
  | "observer_failed"
  | "protocol_error"
  | "instance_quarantined";

export type Mem0MemoryErrorContext = "non_retryable" | "transient_operation";

type Mem0MemoryErrorOptions = {
  eventId?: string;
  context?: Mem0MemoryErrorContext;
};

const TRANSIENT_CODES: ReadonlySet<Mem0MemoryErrorCode> = new Set([
  "rate_limited",
  "unavailable",
]);

function isRetryable(code: Mem0MemoryErrorCode, context: Mem0MemoryErrorContext): boolean {
  return context === "transient_operation" && TRANSIENT_CODES.has(code);
}

/**
 * Stable public failure surface shared by the adapter and provider port.
 *
 * Provider errors are deliberately not accepted as a cause. Retryability is derived
 * from the normalized code plus the operation context, never supplied as a free boolean.
 */
export class Mem0MemoryError extends Error {
  readonly code: Mem0MemoryErrorCode;
  readonly eventId?: string;
  readonly retryable: boolean;

  constructor(code: Mem0MemoryErrorCode, message: string, options: Mem0MemoryErrorOptions = {}) {
    super(message);
    this.name = "Mem0MemoryError";
    this.code = code;
    this.eventId = options.eventId;
    this.retryable = isRetryable(code, options.context ?? "non_retryable");
  }
}
