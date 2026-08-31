export type HindsightMemoryErrorCode =
  | "unsupported_operation"
  | "unsupported_configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "bank_not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "timeout"
  | "write_failed"
  | "write_outcome_unknown"
  | "observer_failed"
  | "protocol_error"
  | "instance_quarantined";

export type HindsightMemoryOperation = "config" | "read" | "write" | "snapshot" | "restore";

const ERROR_MESSAGES: Record<HindsightMemoryErrorCode, string> = {
  unsupported_operation: "Hindsight operation is not supported",
  unsupported_configuration: "Hindsight configuration is not supported",
  invalid_input: "Hindsight input is invalid",
  authentication: "Hindsight authentication failed",
  authorization: "Hindsight authorization failed",
  bank_not_found: "Hindsight bank was not found",
  rate_limited: "Hindsight rate limit was exceeded",
  quota_exceeded: "Hindsight quota was exceeded",
  unavailable: "Hindsight is unavailable",
  timeout: "Hindsight request timed out",
  write_failed: "Hindsight write failed",
  write_outcome_unknown: "Hindsight write outcome is unknown",
  observer_failed: "Hindsight completion observer failed",
  protocol_error: "Hindsight returned an invalid response",
  instance_quarantined: "HindsightMemory instance is quarantined",
};

const RETRYABLE_READ_CODES: ReadonlySet<HindsightMemoryErrorCode> = new Set([
  "rate_limited",
  "unavailable",
  "timeout",
]);

/** Stable, sanitized failure surface for the Hindsight adapter. */
export class HindsightMemoryError extends Error {
  readonly code: HindsightMemoryErrorCode;
  readonly operation: HindsightMemoryOperation;
  readonly retryable: boolean;

  constructor(code: HindsightMemoryErrorCode, operation: HindsightMemoryOperation) {
    super(ERROR_MESSAGES[code]);
    this.name = "HindsightMemoryError";
    this.code = code;
    this.operation = operation;
    this.retryable = operation === "read" && RETRYABLE_READ_CODES.has(code);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

/** Maps only the SDK's numeric statusCode into the stable adapter vocabulary. */
export function mapHindsightStatus(
  statusCode: number,
  operation: HindsightMemoryOperation,
): HindsightMemoryErrorCode {
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) return "authorization";
  if (statusCode === 404) return "bank_not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 402 || statusCode === 413) return "quota_exceeded";
  if (statusCode === 408 || (statusCode >= 500 && statusCode <= 599)) {
    return operation === "write" ? "write_outcome_unknown" : "unavailable";
  }
  if (statusCode === 409 || statusCode === 422) {
    return operation === "write" ? "write_failed" : "invalid_input";
  }
  return "protocol_error";
}

function readErrorProperty(error: unknown, property: string): unknown {
  if (!isObject(error)) return undefined;
  try {
    return error[property];
  } catch {
    return undefined;
  }
}

function isAbortFailure(error: unknown): boolean {
  const name = readErrorProperty(error, "name");
  return name === "AbortError" || name === "TimeoutError";
}

function isTransportFailure(error: unknown): boolean {
  try {
    if (error instanceof TypeError) return true;
    const name = readErrorProperty(error, "name");
    const code = readErrorProperty(error, "code");
    return (
      name === "NetworkError" ||
      name === "FetchError" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ETIMEDOUT"
    );
  } catch {
    return false;
  }
}

function transportCode(
  error: unknown,
  operation: HindsightMemoryOperation,
): HindsightMemoryErrorCode | undefined {
  if (isAbortFailure(error)) return operation === "write" ? "write_outcome_unknown" : "timeout";
  if (isTransportFailure(error)) return operation === "write" ? "write_outcome_unknown" : "unavailable";
  return undefined;
}

/**
 * Decodes an SDK/transport failure without retaining its object, message, details or cause.
 * Provider status decoding is deliberately kept in the SDK adapter, where the
 * value can first be proven to come from `HindsightError`.
 */
export function normalizeHindsightError(
  error: unknown,
  operation: HindsightMemoryOperation,
): HindsightMemoryError {
  try {
    if (error instanceof HindsightMemoryError) {
      return new HindsightMemoryError(error.code, operation);
    }
  } catch {
    return new HindsightMemoryError("protocol_error", operation);
  }

  const transport = transportCode(error, operation);
  if (transport !== undefined) return new HindsightMemoryError(transport, operation);

  return new HindsightMemoryError("protocol_error", operation);
}

export function hindsightError(
  code: HindsightMemoryErrorCode,
  operation: HindsightMemoryOperation,
): HindsightMemoryError {
  return new HindsightMemoryError(code, operation);
}
