import { Mem0MemoryError } from "./error.ts";
import type {
  Mem0AddRequest,
  Mem0PlatformPort,
  Mem0Record,
  Mem0SearchRequest,
} from "./platform.ts";

export type Mem0SdkClient = {
  add(messages: Mem0AddRequest["messages"], options: Record<string, unknown>): Promise<unknown>;
  get(memoryId: string): Promise<unknown>;
  getAll(options: Record<string, unknown>): Promise<unknown>;
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
};

export type Mem0PlatformDependencies = {
  createClient: (apiKey: string, baseUrl: string) => Promise<Mem0SdkClient>;
  fetch: typeof fetch;
};

export type Mem0PlatformInternalConfig = {
  apiKey: string;
  baseUrl?: string;
};

type UnknownRecord = Record<string, unknown>;
type SdkModule = { MemoryClient: typeof import("mem0ai").MemoryClient };

let sdkModulePromise: Promise<SdkModule> | undefined;

function loadSdkModule(): Promise<SdkModule> {
  if (sdkModulePromise !== undefined) return sdkModulePromise;

  const previousTelemetry = process.env.MEM0_TELEMETRY;
  process.env.MEM0_TELEMETRY = "false";
  const loading = import("mem0ai")
    .then(({ MemoryClient }) => ({ MemoryClient }))
    .finally(() => {
      if (previousTelemetry === undefined) delete process.env.MEM0_TELEMETRY;
      else process.env.MEM0_TELEMETRY = previousTelemetry;
    });
  sdkModulePromise = loading;
  return loading;
}

async function createSdkClient(apiKey: string, baseUrl: string): Promise<Mem0SdkClient> {
  const sdk = await loadSdkModule();

  // Ping is only for telemetry identity and logs raw initialization failures.
  class ServerMemoryClient extends sdk.MemoryClient {
    override async ping(): Promise<void> {}
  }

  return new ServerMemoryClient({ apiKey, host: baseUrl });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function protocolError(operation: string): Mem0MemoryError {
  return new Mem0MemoryError("protocol_error", `Mem0 returned an invalid ${operation} response`);
}

function statusFromError(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const errorCode = error.errorCode;
  if (typeof errorCode === "string") {
    const match = /^HTTP_(\d{3})$/.exec(errorCode);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

function httpError(status: number, operation: string): Mem0MemoryError {
  if (status === 401) return new Mem0MemoryError("authentication", "Mem0 authentication failed");
  if (status === 403) return new Mem0MemoryError("authorization", "Mem0 authorization failed");
  if (status === 413) return new Mem0MemoryError("quota_exceeded", "Mem0 quota was exceeded");
  if (status === 429) {
    return new Mem0MemoryError("rate_limited", "Mem0 rate limit was exceeded", {
      context: "transient_operation",
    });
  }
  if (status === 404) return new Mem0MemoryError("agent_not_found", `Mem0 ${operation} target was not found`);
  if (status === 408 || status >= 500) {
    return new Mem0MemoryError("unavailable", `Mem0 ${operation} is unavailable`, {
      context: "transient_operation",
    });
  }
  if (status === 400 || status === 409 || status === 422) {
    return new Mem0MemoryError("invalid_input", `Mem0 rejected the ${operation} request`);
  }
  return protocolError(operation);
}

function normalizeProviderError(error: unknown, operation: string): Mem0MemoryError {
  if (error instanceof Mem0MemoryError) return error;

  const status = statusFromError(error);
  if (status !== undefined) return httpError(status, operation);

  const name = errorName(error);
  if (name === "AuthenticationError") {
    return new Mem0MemoryError("authentication", "Mem0 authentication failed");
  }
  if (name === "RateLimitError") {
    return new Mem0MemoryError("rate_limited", "Mem0 rate limit was exceeded", {
      context: "transient_operation",
    });
  }
  if (name === "MemoryQuotaExceededError") {
    return new Mem0MemoryError("quota_exceeded", "Mem0 quota was exceeded");
  }
  if (name === "NotFoundError" || name === "MemoryNotFoundError") {
    return new Mem0MemoryError("agent_not_found", `Mem0 ${operation} target was not found`);
  }
  if (name === "ValidationError" || name === "ConfigurationError") {
    return new Mem0MemoryError("invalid_input", `Mem0 rejected the ${operation} request`);
  }
  if (name === "NetworkError" || name === "AbortError" || error instanceof TypeError) {
    return new Mem0MemoryError("unavailable", `Mem0 ${operation} is unavailable`, {
      context: "transient_operation",
    });
  }
  return protocolError(operation);
}

function normalizeRecord(value: unknown, operation: string): Mem0Record {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.memory)) {
    throw protocolError(operation);
  }
  if (!isRecord(value.metadata)) throw protocolError(operation);
  if (value.score !== undefined && (typeof value.score !== "number" || !Number.isFinite(value.score))) {
    throw protocolError(operation);
  }

  return {
    id: value.id,
    memory: value.memory,
    ...(value.score === undefined ? {} : { score: value.score as number }),
    metadata: { ...value.metadata },
  };
}

function normalizeRecordArray(value: unknown, operation: string): Mem0Record[] {
  if (!Array.isArray(value)) throw protocolError(operation);
  return value.map((record) => normalizeRecord(record, operation));
}

function eventMemoryId(value: unknown): string | undefined {
  if (nonEmptyString(value)) return value;
  if (!isRecord(value)) return undefined;
  const id = value.memoryId ?? value.memory_id ?? value.id;
  return nonEmptyString(id) ? id : undefined;
}

function normalizeEventMemoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw protocolError("event");
  const ids = value.map(eventMemoryId);
  if (ids.some((id) => id === undefined)) throw protocolError("event");
  return ids as string[];
}

function normalizeEvent(value: unknown): Awaited<ReturnType<Mem0PlatformPort["getEvent"]>> {
  if (!isRecord(value)) throw protocolError("event");
  const eventId = value.eventId ?? value.event_id ?? value.id;
  if (!nonEmptyString(eventId)) throw protocolError("event");

  const status = value.status;
  if (status !== "PENDING" && status !== "RUNNING" && status !== "SUCCEEDED" && status !== "FAILED") {
    throw protocolError("event");
  }

  if (status === "SUCCEEDED") {
    const rawIds = value.memoryIds ?? value.memory_ids ?? value.results;
    if (rawIds === undefined) throw protocolError("event");
    return { eventId, status, memoryIds: normalizeEventMemoryIds(rawIds) };
  }
  if (status === "FAILED") {
    return { eventId, status, error: "Mem0 ingestion failed" };
  }
  return { eventId, status };
}

export function createMem0PlatformPortInternal(
  config: Mem0PlatformInternalConfig,
  dependencies: Mem0PlatformDependencies,
  platformBaseUrl: string,
): Mem0PlatformPort {
  const apiKey = config.apiKey.trim();
  if (apiKey === "") {
    throw new Mem0MemoryError("unsupported_configuration", "MEM0_API_KEY is required");
  }
  const baseUrl = config.baseUrl ?? platformBaseUrl;
  if (baseUrl !== platformBaseUrl) {
    throw new Mem0MemoryError("unsupported_configuration", "Mem0 Platform base URL is not supported");
  }

  let clientPromise: Promise<Mem0SdkClient> | undefined;
  const getClient = (): Promise<Mem0SdkClient> => {
    clientPromise ??= Promise.resolve().then(() => dependencies.createClient(apiKey, baseUrl));
    return clientPromise;
  };
  const withClient = async <T>(
    operation: string,
    call: (sdk: Mem0SdkClient) => Promise<T>,
  ): Promise<T> => {
    try {
      return await call(await getClient());
    } catch (error) {
      throw normalizeProviderError(error, operation);
    }
  };

  return {
    async add(request) {
      const value = await withClient("add", (sdk) =>
        sdk.add(request.messages, {
          agentId: request.agentId,
          infer: request.infer,
          temporalReasoning: request.temporalReasoning,
          agentCustomInstructions: request.agentCustomInstructions,
          metadata: request.metadata,
        }),
      );
      if (!isRecord(value)) throw protocolError("add");
      const eventId = value.eventId ?? value.event_id;
      if (!nonEmptyString(eventId) || value.status !== "PENDING") throw protocolError("add");
      return { eventId, status: "PENDING" };
    },

    async getEvent(eventId) {
      let response: Response;
      try {
        response = await dependencies.fetch(`${baseUrl}/v1/event/${encodeURIComponent(eventId)}/`, {
          method: "GET",
          headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" },
        });
      } catch (error) {
        throw normalizeProviderError(error, "event");
      }
      if (!response.ok) throw httpError(response.status, "event");

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw protocolError("event");
      }
      return normalizeEvent(value);
    },

    async get(memoryId) {
      try {
        const value = await (await getClient()).get(memoryId);
        return normalizeRecord(value, "get");
      } catch (error) {
        if (statusFromError(error) === 404 || errorName(error) === "MemoryNotFoundError") return null;
        throw normalizeProviderError(error, "get");
      }
    },

    async list(agentId) {
      return withClient("list", async (sdk) => {
        const memories: Mem0Record[] = [];
        const seenNext = new Set<string>();
        let expectedCount: number | undefined;
        let page = 1;

        while (true) {
          const value = await sdk.getAll({ filters: { agent_id: agentId }, page, pageSize: 200 });
          if (!isRecord(value) || !Array.isArray(value.results)) throw protocolError("list");
          if (!Number.isSafeInteger(value.count) || (value.count as number) < 0) {
            throw protocolError("list");
          }
          expectedCount ??= value.count as number;
          if (value.count !== expectedCount) throw protocolError("list");
          if (value.next !== null && !nonEmptyString(value.next)) throw protocolError("list");
          memories.push(...normalizeRecordArray(value.results, "list"));

          if (value.next === null) {
            if (memories.length !== expectedCount) throw protocolError("list");
            return memories;
          }
          if (seenNext.has(value.next)) throw protocolError("list");
          seenNext.add(value.next);
          page += 1;
        }
      });
    },

    async search(request: Mem0SearchRequest) {
      const value = await withClient("search", (sdk) =>
        sdk.search(request.query, {
          filters: request.filters,
          topK: request.topK,
          threshold: request.threshold,
          rerank: request.rerank,
          keywordSearch: request.keywordSearch,
        }),
      );
      if (!isRecord(value)) throw protocolError("search");
      return normalizeRecordArray(value.results, "search");
    },
  };
}

export function createProductionMem0PlatformPort(
  config: Mem0PlatformInternalConfig,
  platformBaseUrl: string,
): Mem0PlatformPort {
  return createMem0PlatformPortInternal(
    config,
    { createClient: createSdkClient, fetch: (...args) => globalThis.fetch(...args) },
    platformBaseUrl,
  );
}
