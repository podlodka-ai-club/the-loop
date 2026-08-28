import { SchemaType, XmemoryClient } from "xmemory";
import { XmemoryMemoryError, type XmemoryOperation } from "./error.ts";
import {
  decodeXmemoryChanges,
  type XmemoryAdminPort,
  type XmemoryPlatformPort,
} from "./platform.ts";

type UnknownRecord = Record<string, unknown>;

export type XmemorySdkInstance = {
  readonly id: string;
  getSchema(options: { timeoutMs: number }): Promise<unknown>;
  write(text: string, options: {
    extractionLogic: "deep";
    diffEngine: true;
    timeoutMs: number;
  }): Promise<unknown>;
  read(query: string, options: {
    readMode: "single-answer" | "raw-tables";
    traceId: string;
    timeoutMs: number;
  }): Promise<unknown>;
};

export type XmemorySdkAdmin = {
  getCluster(clusterId: string, options: { timeoutMs: number }): Promise<unknown>;
  listInstances(options: { timeoutMs: number }): Promise<unknown>;
  createInstance(
    clusterId: string,
    name: string,
    schemaYml: string,
    schemaType: typeof SchemaType.YML,
    options: { description: string; timeoutMs: number },
  ): Promise<unknown>;
  getInstanceSchema(instanceId: string, options: { timeoutMs: number }): Promise<unknown>;
};

export type XmemorySdkClient = {
  readonly admin: XmemorySdkAdmin;
  instance(instanceId: string): XmemorySdkInstance;
};

export type XmemoryPlatformDependencies = {
  createClient: (apiKey: string, baseUrl: string) => XmemorySdkClient;
};

type StateChangingOperation = "none" | "write" | "create";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function protocolFailure(
  operation: XmemoryOperation,
  stateChanging: StateChangingOperation = "none",
): XmemoryMemoryError {
  if (stateChanging === "write") {
    return new XmemoryMemoryError(
      "write_outcome_unknown",
      operation,
      "The xmemory write outcome is unknown",
    );
  }
  if (stateChanging === "create") {
    return new XmemoryMemoryError(
      "provision_outcome_unknown",
      operation,
      "The xmemory instance creation outcome is unknown",
    );
  }
  return new XmemoryMemoryError(
    "protocol_error",
    operation,
    `xmemory returned an invalid ${operation} response`,
  );
}

function statusFromError(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function codeFromError(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const name = errorName(error);
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = codeFromError(error);
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT"
  );
}

const PROVIDER_CODES = {
  UNAUTHORIZED: { status: 401, code: "authentication" },
  FORBIDDEN: { status: 403, code: "authorization" },
  QUOTA_EXCEEDED: { status: 402, code: "quota_exceeded" },
  RATE_LIMITED: { status: 429, code: "rate_limited" },
  NOT_FOUND: { status: 404, code: "instance_not_found" },
} as const;

function normalizedMessage(code: string, operation: XmemoryOperation): string {
  switch (code) {
    case "authentication":
      return "xmemory authentication failed";
    case "authorization":
      return "xmemory authorization failed";
    case "instance_not_found":
      return "The xmemory instance was not found";
    case "rate_limited":
      return "The xmemory rate limit was exceeded";
    case "quota_exceeded":
      return "The xmemory quota was exceeded";
    case "invalid_input":
      return `xmemory rejected the ${operation} request`;
    case "unavailable":
      return `xmemory ${operation} is unavailable`;
    default:
      return `xmemory ${operation} failed`;
  }
}

function knownHttpCode(status: number): keyof typeof PROVIDER_CODES | undefined {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 402:
      return "QUOTA_EXCEEDED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RATE_LIMITED";
    default:
      return undefined;
  }
}

export function normalizeXmemoryProviderError(
  error: unknown,
  operation: XmemoryOperation,
  stateChanging: StateChangingOperation = "none",
): XmemoryMemoryError {
  if (error instanceof XmemoryMemoryError) return error;

  const status = statusFromError(error);
  const providerCode = codeFromError(error);
  const knownProvider =
    providerCode === undefined
      ? undefined
      : PROVIDER_CODES[providerCode as keyof typeof PROVIDER_CODES];

  if (knownProvider !== undefined) {
    if (status !== undefined && status !== knownProvider.status) {
      return protocolFailure(operation, stateChanging);
    }
    return new XmemoryMemoryError(
      knownProvider.code,
      operation,
      normalizedMessage(knownProvider.code, operation),
    );
  }

  if (status !== undefined) {
    const fallback = knownHttpCode(status);
    if (fallback !== undefined) {
      const normalized = PROVIDER_CODES[fallback].code;
      return new XmemoryMemoryError(normalized, operation, normalizedMessage(normalized, operation));
    }
    if (status === 400 || status === 409 || status === 422) {
      return new XmemoryMemoryError(
        "invalid_input",
        operation,
        normalizedMessage("invalid_input", operation),
      );
    }
    if (status === 408 || status >= 500) {
      if (stateChanging !== "none") return protocolFailure(operation, stateChanging);
      return new XmemoryMemoryError(
        "unavailable",
        operation,
        normalizedMessage("unavailable", operation),
      );
    }
    if (status >= 400 && status < 500) return protocolFailure(operation, stateChanging);
  }

  if (isTransportFailure(error)) {
    if (stateChanging !== "none") return protocolFailure(operation, stateChanging);
    return new XmemoryMemoryError(
      "unavailable",
      operation,
      normalizedMessage("unavailable", operation),
    );
  }
  return protocolFailure(operation, stateChanging);
}

function requireConfig(value: string, name: string, operation: "schema" | "provision"): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      operation,
      `${name} is required`,
    );
  }
  return normalized;
}

function defaultDependencies(): XmemoryPlatformDependencies {
  return {
    createClient: (apiKey, baseUrl) => new XmemoryClient({ apiKey, url: baseUrl }),
  };
}

function decodeSchemaEnvelope(
  value: unknown,
  operation: "schema" | "provision",
): Record<string, unknown> {
  if (!isRecord(value) || !Object.hasOwn(value, "data_schema") || !isRecord(value.data_schema)) {
    throw protocolFailure(operation);
  }
  return value.data_schema;
}

function decodeNullableTrace(
  value: unknown,
  operation: "write" | "read",
): string | null {
  if (value === null || typeof value === "string") return value;
  throw protocolFailure(operation, operation === "write" ? "write" : "none");
}

export function createXmemoryPlatformPortInternal(
  config: { apiKey: string; instanceId: string; baseUrl?: string },
  dependencies: XmemoryPlatformDependencies | undefined,
  platformBaseUrl: string,
): XmemoryPlatformPort {
  const apiKey = requireConfig(config.apiKey, "XMEM_API_KEY", "schema");
  const instanceId = requireConfig(config.instanceId, "XMEM_INSTANCE_ID", "schema");
  const baseUrl = config.baseUrl ?? platformBaseUrl;
  if (baseUrl !== platformBaseUrl) {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "A custom xmemory base URL is not supported",
    );
  }
  let instance: XmemorySdkInstance;
  try {
    const client = (dependencies ?? defaultDependencies()).createClient(apiKey, baseUrl);
    instance = client.instance(instanceId);
  } catch (error) {
    throw normalizeXmemoryProviderError(error, "schema");
  }

  return {
    async getSchema(timeoutMs) {
      try {
        return decodeSchemaEnvelope(await instance.getSchema({ timeoutMs }), "schema");
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "schema");
      }
    },
    async write(request) {
      try {
        const value = await instance.write(request.text, {
          extractionLogic: request.extractionLogic,
          diffEngine: request.diffEngine,
          timeoutMs: request.timeoutMs,
        });
        if (!isRecord(value) || !nonEmptyString(value.write_id)) {
          throw protocolFailure("write", "write");
        }
        return {
          writeId: value.write_id,
          traceId: decodeNullableTrace(value.trace_id, "write"),
          changes: decodeXmemoryChanges(value.changes),
        };
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "write", "write");
      }
    },
    async read(request) {
      try {
        const value = await instance.read(request.query, {
          readMode: request.readMode,
          traceId: request.traceId,
          timeoutMs: request.timeoutMs,
        });
        if (!isRecord(value) || !Object.hasOwn(value, "reader_result")) {
          throw protocolFailure("read");
        }
        return {
          traceId: decodeNullableTrace(value.trace_id, "read"),
          readerResult: value.reader_result,
        };
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "read");
      }
    },
  };
}

function decodeId(
  value: unknown,
  stateChanging: StateChangingOperation = "none",
): { id: string } {
  if (!isRecord(value) || !nonEmptyString(value.id)) {
    throw protocolFailure("provision", stateChanging);
  }
  return { id: value.id };
}

export function createXmemoryAdminPortInternal(
  config: { adminApiKey: string; baseUrl?: string },
  dependencies: XmemoryPlatformDependencies | undefined,
  platformBaseUrl: string,
): XmemoryAdminPort {
  const apiKey = requireConfig(config.adminApiKey, "XMEM_ADMIN_API_KEY", "provision");
  const baseUrl = config.baseUrl ?? platformBaseUrl;
  if (baseUrl !== platformBaseUrl) {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "provision",
      "A custom xmemory base URL is not supported",
    );
  }
  let admin: XmemorySdkAdmin;
  try {
    admin = (dependencies ?? defaultDependencies()).createClient(apiKey, baseUrl).admin;
  } catch (error) {
    throw normalizeXmemoryProviderError(error, "provision");
  }

  return {
    async getCluster(clusterId, timeoutMs) {
      try {
        return decodeId(await admin.getCluster(clusterId, { timeoutMs }));
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "provision");
      }
    },
    async listInstances(timeoutMs) {
      try {
        const value = await admin.listInstances({ timeoutMs });
        if (!Array.isArray(value)) throw protocolFailure("provision");
        return value.map((item) => {
          const { id } = decodeId(item);
          if (!isRecord(item) || !nonEmptyString(item.name)) {
            throw protocolFailure("provision");
          }
          return { id, name: item.name };
        });
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "provision");
      }
    },
    async createInstance(request) {
      try {
        return decodeId(
          await admin.createInstance(
            request.clusterId,
            request.name,
            request.schemaYml,
            SchemaType.YML,
            { description: request.description, timeoutMs: request.timeoutMs },
          ),
          "create",
        );
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "provision", "create");
      }
    },
    async getSchema(instanceId, timeoutMs) {
      try {
        return decodeSchemaEnvelope(
          await admin.getInstanceSchema(instanceId, { timeoutMs }),
          "provision",
        );
      } catch (error) {
        throw normalizeXmemoryProviderError(error, "provision");
      }
    },
  };
}
