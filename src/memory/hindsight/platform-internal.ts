import { HindsightClient, HindsightError } from "@vectorize-io/hindsight-client";
import {
  HindsightMemoryError,
  hindsightError,
  mapHindsightStatus,
  normalizeHindsightError,
  type HindsightMemoryOperation,
} from "./error.ts";
import {
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RETAIN_CONTEXT,
} from "./constants.ts";
import type {
  HindsightMemoryResult,
  HindsightDocumentLookup,
  HindsightPlatformPort,
  HindsightRecallRequest,
  HindsightRecallResponse,
  HindsightRetainRequest,
  HindsightRetainResponse,
} from "./platform-contract.ts";

type RetainOptions = {
  context?: string;
  metadata?: Record<string, string>;
  documentId?: string;
  async?: boolean;
  signal?: AbortSignal;
  retainMission?: string;
};

type RecallOptions = {
  types?: string[];
  preferObservations?: boolean;
  maxTokens?: number;
  budget?: "low" | "mid" | "high";
  includeSourceFacts?: boolean;
  includeChunks?: boolean;
  includeEntities?: boolean;
  signal?: AbortSignal;
};

export type HindsightSdkClient = {
  retain(bankId: string, content: string, options?: RetainOptions): Promise<unknown>;
  recall(bankId: string, query: string, options?: RecallOptions): Promise<unknown>;
  getDocument(bankId: string, documentId: string, options?: { signal?: AbortSignal }): Promise<unknown | null>;
  getVersion(options?: { signal?: AbortSignal }): Promise<unknown>;
  listDocuments(bankId: string, options?: {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

export type HindsightPlatformDependencies = {
  createClient?: (config: {
    baseUrl: string;
    apiKey: string;
    userAgent: string;
  }) => HindsightSdkClient;
};

const HINDSIGHT_USER_AGENT = "loci-hindsight-adapter/1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveTimeout(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 600_000;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasAbortSignal(value: unknown): value is AbortSignal {
  try {
    return (
      isRecord(value) &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function"
    );
  } catch {
    return false;
  }
}

function decodeStringOrNull(value: unknown, present: boolean): string | null {
  if (!present || value === null) return null;
  if (typeof value !== "string") throw hindsightError("protocol_error", "read");
  return value;
}

function decodeMetadata(value: unknown, present: boolean): Record<string, string> | null {
  if (!present || value === null) return null;
  if (!isRecord(value)) throw hindsightError("protocol_error", "read");
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw hindsightError("protocol_error", "read");
    metadata[key] = item;
  }
  return metadata;
}

function decodeStringArray(value: unknown, present: boolean): string[] | null {
  if (!present || value === null) return null;
  if (!Array.isArray(value)) {
    throw hindsightError("protocol_error", "read");
  }
  const decoded: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") {
      throw hindsightError("protocol_error", "read");
    }
    decoded.push(value[index]);
  }
  return decoded;
}

function decodeScores(value: unknown, present: boolean): Record<string, number | null> | null {
  if (!present || value === null) return null;
  if (!isRecord(value)) throw hindsightError("protocol_error", "read");
  const scores: Record<string, number | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && (typeof item !== "number" || !Number.isFinite(item))) {
      throw hindsightError("protocol_error", "read");
    }
    scores[key] = item as number | null;
  }
  return scores;
}

function decodeResult(value: unknown): HindsightMemoryResult {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.text)) {
    throw hindsightError("protocol_error", "read");
  }
  return {
    id: value.id,
    text: value.text,
    type: decodeStringOrNull(value.type, Object.hasOwn(value, "type")),
    context: decodeStringOrNull(value.context, Object.hasOwn(value, "context")),
    metadata: decodeMetadata(value.metadata, Object.hasOwn(value, "metadata")),
    documentId: decodeStringOrNull(value.document_id, Object.hasOwn(value, "document_id")),
    sourceFactIds: decodeStringArray(value.source_fact_ids, Object.hasOwn(value, "source_fact_ids")),
    scores: decodeScores(value.scores, Object.hasOwn(value, "scores")),
  };
}

function decodeRetainResponse(value: unknown): HindsightRetainResponse {
  if (
    !isRecord(value) ||
    typeof value.success !== "boolean" ||
    !isNonEmptyString(value.bank_id) ||
    !Number.isSafeInteger(value.items_count) ||
    (value.items_count as number) < 0 ||
    value.async !== false
  ) {
    throw hindsightError("protocol_error", "write");
  }

  const operationId = value.operation_id;
  if (operationId !== undefined && operationId !== null && !isNonEmptyString(operationId)) {
    throw hindsightError("protocol_error", "write");
  }

  const usageValue = value.usage;
  let usage: Record<string, number> | null = null;
  if (usageValue !== undefined && usageValue !== null) {
    if (!isRecord(usageValue)) throw hindsightError("protocol_error", "write");
    usage = {};
    for (const [key, item] of Object.entries(usageValue)) {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        throw hindsightError("protocol_error", "write");
      }
      usage[key] = item as number;
    }
  }

  return {
    success: value.success,
    bankId: value.bank_id,
    itemsCount: value.items_count as number,
    async: false,
    operationId: operationId === undefined ? null : operationId,
    usage,
  };
}

function decodeRecallResponse(value: unknown): HindsightRecallResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw hindsightError("protocol_error", "read");
  }
  const results: HindsightMemoryResult[] = [];
  for (let index = 0; index < value.results.length; index += 1) {
    if (!Object.hasOwn(value.results, index)) {
      throw hindsightError("protocol_error", "read");
    }
    results.push(decodeResult(value.results[index]));
  }
  return { results };
}

function decodeVersionResponse(value: unknown): { apiVersion: string } {
  if (!isRecord(value) || !isNonEmptyString(value.api_version)) {
    throw hindsightError("protocol_error", "config");
  }
  return { apiVersion: value.api_version };
}

function decodeListDocumentsResponse(value: unknown): { total: number } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0
  ) {
    throw hindsightError("protocol_error", "read");
  }
  return { total: value.total as number };
}

function decodeDocumentLookupResponse(value: unknown): HindsightDocumentLookup | null {
  if (value === null) return null;
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    throw hindsightError("protocol_error", "read");
  }
  return { documentId: value.id };
}

type PreparedSignal = { signal: AbortSignal; timeoutSignal: AbortSignal };

function prepareSignal(
  timeoutMs: number,
  requestSignal: AbortSignal,
  operation: HindsightMemoryOperation,
): PreparedSignal {
  if (!isPositiveTimeout(timeoutMs) || !hasAbortSignal(requestSignal)) {
    throw hindsightError("protocol_error", operation);
  }
  if (requestSignal.aborted) {
    throw hindsightError("timeout", operation);
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    timeoutSignal,
    signal: AbortSignal.any([requestSignal, timeoutSignal]),
  };
}

async function callWithBoundary<T>(
  timeoutMs: number,
  requestSignal: AbortSignal,
  operation: HindsightMemoryOperation,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let prepared: PreparedSignal | undefined;
  try {
    prepared = prepareSignal(timeoutMs, requestSignal, operation);
    const result = await action(prepared.signal);
    if (requestSignal.aborted || prepared.timeoutSignal.aborted) {
      throw hindsightError(operation === "write" ? "write_outcome_unknown" : "timeout", operation);
    }
    return result;
  } catch (error) {
    if (
      prepared !== undefined &&
      (requestSignal.aborted || prepared.timeoutSignal.aborted)
    ) {
      throw hindsightError(operation === "write" ? "write_outcome_unknown" : "timeout", operation);
    }
    throw normalizePlatformError(error, operation);
  }
}

function isHindsightSdkError(error: unknown): error is HindsightError {
  try {
    return error instanceof HindsightError;
  } catch {
    return false;
  }
}

function normalizePlatformError(
  error: unknown,
  operation: HindsightMemoryOperation,
): HindsightMemoryError {
  if (!isHindsightSdkError(error)) return normalizeHindsightError(error, operation);

  let statusCode: unknown;
  try {
    statusCode = error.statusCode;
  } catch {
    return hindsightError("protocol_error", operation);
  }
  if (typeof statusCode !== "number" || !Number.isInteger(statusCode)) {
    return hindsightError("protocol_error", operation);
  }
  return new HindsightMemoryError(mapHindsightStatus(statusCode, operation), operation);
}

type CapturedRetainRequest = {
  bankId: string;
  content: string;
  documentId: string;
  retainMission: string;
  context: string;
  metadata: Record<string, string | null>;
  async: false;
  timeoutMs: number;
  signal: AbortSignal;
};

function retainMetadataMap(value: unknown): value is Record<string, string | null> {
  try {
    return (
      isRecord(value) &&
      Object.entries(value).every(([key, item]) =>
        typeof item === "string" || (key === "loci_memory_hit_id" && item === null),
      )
    );
  } catch {
    return false;
  }
}

function toNativeRetainMetadata(
  metadata: Record<string, string | null>,
): Record<string, string> {
  const nativeMetadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null) nativeMetadata[key] = value;
  }
  return nativeMetadata;
}

function captureRetainRequest(request: unknown): CapturedRetainRequest | null {
  try {
    if (
      !isRecord(request) ||
      typeof request.bankId !== "string" ||
      typeof request.content !== "string" ||
      typeof request.documentId !== "string" ||
      typeof request.retainMission !== "string" ||
      request.retainMission.trim() === "" ||
      request.context !== HINDSIGHT_RETAIN_CONTEXT ||
      !retainMetadataMap(request.metadata) ||
      request.async !== false ||
      !isPositiveTimeout(request.timeoutMs) ||
      !hasAbortSignal(request.signal)
    ) {
      return null;
    }
    return {
      bankId: request.bankId,
      content: request.content,
      documentId: request.documentId,
      retainMission: request.retainMission,
      context: request.context,
      metadata: request.metadata,
      async: false,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    };
  } catch {
    return null;
  }
}

type CapturedRecallRequest = {
  bankId: string;
  query: string;
  maxTokens: number;
  budget: "low" | "mid" | "high";
  types: ["world", "experience", "observation"];
  preferObservations: true;
  includeSourceFacts: false;
  includeChunks: false;
  includeEntities: false;
  timeoutMs: number;
  signal: AbortSignal;
};

function denseStringArray(value: unknown): value is string[] {
  try {
    return (
      Array.isArray(value) &&
      Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean) &&
      value.every((item) => typeof item === "string")
    );
  } catch {
    return false;
  }
}

function captureRecallRequest(request: unknown): CapturedRecallRequest | null {
  try {
    if (
      !isRecord(request) ||
      typeof request.bankId !== "string" ||
      typeof request.query !== "string" ||
      !isPositiveInteger(request.maxTokens) ||
      !denseStringArray(request.types) ||
      request.types.length !== 3 ||
      request.types[0] !== "world" ||
      request.types[1] !== "experience" ||
      request.types[2] !== "observation" ||
      request.preferObservations !== true ||
      request.includeSourceFacts !== false ||
      request.includeChunks !== false ||
      request.includeEntities !== false ||
      !isPositiveTimeout(request.timeoutMs) ||
      !hasAbortSignal(request.signal) ||
      (request.budget !== "low" && request.budget !== "mid" && request.budget !== "high")
    ) {
      return null;
    }
    return {
      bankId: request.bankId,
      query: request.query,
      maxTokens: request.maxTokens,
      budget: request.budget,
      types: ["world", "experience", "observation"],
      preferObservations: true,
      includeSourceFacts: false,
      includeChunks: false,
      includeEntities: false,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    };
  } catch {
    return null;
  }
}

function captureBasicRequest(
  request: unknown,
): { timeoutMs: number; signal: AbortSignal } | null {
  try {
    if (
      !isRecord(request) ||
      !isPositiveTimeout(request.timeoutMs) ||
      !hasAbortSignal(request.signal)
    ) {
      return null;
    }
    return { timeoutMs: request.timeoutMs, signal: request.signal };
  } catch {
    return null;
  }
}

function captureListDocumentsRequest(request: unknown):
  | { bankId: string; timeoutMs: number; signal: AbortSignal }
  | null {
  try {
    const basic = captureBasicRequest(request);
    if (!basic || !isRecord(request) || typeof request.bankId !== "string") return null;
    return { bankId: request.bankId, ...basic };
  } catch {
    return null;
  }
}

function captureGetDocumentRequest(request: unknown):
  | { bankId: string; documentId: string; timeoutMs: number; signal: AbortSignal }
  | null {
  try {
    const basic = captureBasicRequest(request);
    if (
      !basic ||
      !isRecord(request) ||
      !isNonEmptyString(request.bankId) ||
      !isNonEmptyString(request.documentId)
    ) return null;
    return { bankId: request.bankId, documentId: request.documentId, ...basic };
  } catch {
    return null;
  }
}

function validateFactoryConfig(config: { apiKey: string; baseUrl: string }): void {
  try {
    if (
      !isRecord(config) ||
      typeof config.apiKey !== "string" ||
      config.apiKey.trim() === "" ||
      config.baseUrl !== HINDSIGHT_CLOUD_BASE_URL
    ) {
      throw new Error("invalid platform configuration");
    }
  } catch {
    throw hindsightError("unsupported_configuration", "config");
  }
}

export function createHindsightPlatformPortInternal(
  config: { apiKey: string; baseUrl: string },
  dependencies: HindsightPlatformDependencies = {},
): HindsightPlatformPort {
  validateFactoryConfig(config);

  const createClient =
    dependencies.createClient ??
    ((clientConfig) => new HindsightClient(clientConfig));
  let client: HindsightSdkClient | undefined;

  const getClient = (): HindsightSdkClient => {
    if (client === undefined) {
      client = createClient({
        baseUrl: HINDSIGHT_CLOUD_BASE_URL,
        apiKey: config.apiKey,
        userAgent: HINDSIGHT_USER_AGENT,
      });
    }
    return client;
  };

  return {
    supportsAtomicIdempotency: true,
    async retain(request: HindsightRetainRequest): Promise<HindsightRetainResponse> {
      const captured = captureRetainRequest(request);
      if (captured === null) throw hindsightError("protocol_error", "write");
      return callWithBoundary(captured.timeoutMs, captured.signal, "write", async (signal) => {
        const response = await getClient().retain(captured.bankId, captured.content, {
          documentId: captured.documentId,
          retainMission: captured.retainMission,
          context: captured.context,
          metadata: toNativeRetainMetadata(captured.metadata),
          async: captured.async,
          signal,
        });
        return decodeRetainResponse(response);
      });
    },

    async recall(request: HindsightRecallRequest): Promise<HindsightRecallResponse> {
      const captured = captureRecallRequest(request);
      if (captured === null) throw hindsightError("protocol_error", "read");
      return callWithBoundary(captured.timeoutMs, captured.signal, "read", async (signal) => {
        const response = await getClient().recall(captured.bankId, captured.query, {
          types: captured.types,
          preferObservations: captured.preferObservations,
          maxTokens: captured.maxTokens,
          budget: captured.budget,
          includeSourceFacts: captured.includeSourceFacts,
          includeChunks: captured.includeChunks,
          includeEntities: captured.includeEntities,
          signal,
        });
        return decodeRecallResponse(response);
      });
    },

    async getDocument(request: {
      bankId: string;
      documentId: string;
      timeoutMs: number;
      signal: AbortSignal;
    }): Promise<HindsightDocumentLookup | null> {
      const captured = captureGetDocumentRequest(request);
      if (captured === null) throw hindsightError("protocol_error", "read");
      return callWithBoundary(captured.timeoutMs, captured.signal, "read", async (signal) => {
        const response = await getClient().getDocument(captured.bankId, captured.documentId, { signal });
        return decodeDocumentLookupResponse(response);
      });
    },

    async getVersion(request: { timeoutMs: number; signal: AbortSignal }): Promise<{ apiVersion: string }> {
      const captured = captureBasicRequest(request);
      if (captured === null) throw hindsightError("protocol_error", "config");
      return callWithBoundary(captured.timeoutMs, captured.signal, "config", async (signal) => {
        const response = await getClient().getVersion({ signal });
        return decodeVersionResponse(response);
      });
    },

    async listDocuments(request: {
      bankId: string;
      timeoutMs: number;
      signal: AbortSignal;
    }): Promise<{ total: number }> {
      const captured = captureListDocumentsRequest(request);
      if (captured === null) throw hindsightError("protocol_error", "read");
      return callWithBoundary(captured.timeoutMs, captured.signal, "read", async (signal) => {
        const response = await getClient().listDocuments(captured.bankId, {
          limit: 1,
          offset: 0,
          signal,
        });
        return decodeListDocumentsResponse(response);
      });
    },
  };
}
