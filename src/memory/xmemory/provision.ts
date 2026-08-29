import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  XmemoryMemoryError,
  isXmemoryUnavailableCause,
  type XmemoryMemoryErrorCode,
} from "./error.ts";
import { createXmemoryAdminPort } from "./platform.ts";
import type { XmemoryAdminPort } from "./platform-contract.ts";
import {
  assertXmemorySchemaCompatible,
  loadXmemorySchema,
  type LoadedXmemorySchema,
} from "./schema.ts";

const ADMIN_TIMEOUT_MS = 60_000;
const INSTANCE_DESCRIPTION = "Disposable Loci xmemory pilot";

export type XmemoryProvisionConfig = {
  adminApiKey: string;
  clusterId: string;
  instanceName: string;
};

export type XmemoryProvisionSummary = {
  instanceId: string | null;
  instanceName: string | null;
  schemaSha256: string | null;
  created: boolean;
  schemaVerified: boolean;
  instanceRetired: boolean;
  errorCode: XmemoryMemoryErrorCode | null;
};

export type XmemoryProvisionDependencies = {
  admin?: XmemoryAdminPort;
  loadSchema?: () => Promise<LoadedXmemorySchema>;
  createInstanceName?: (purpose: XmemoryDisposablePurpose) => string;
};

export type XmemoryDisposablePurpose = "runtime" | "integration" | "pilot";

function configurationError(message: string): XmemoryMemoryError {
  return new XmemoryMemoryError("unsupported_configuration", "provision", message);
}

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") throw configurationError(`${name} is required`);
  return value;
}

function validateInstanceName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw configurationError("XMEM_INSTANCE_NAME is invalid");
  }
  return name;
}

function normalizeProvisionConfig(config: XmemoryProvisionConfig): XmemoryProvisionConfig {
  try {
    const adminApiKey = config.adminApiKey.trim();
    const clusterId = config.clusterId.trim();
    if (adminApiKey === "") throw configurationError("XMEM_ADMIN_API_KEY is required");
    if (clusterId === "") throw configurationError("XMEM_CLUSTER_ID is required");
    return {
      adminApiKey,
      clusterId,
      instanceName: validateInstanceName(config.instanceName),
    };
  } catch {
    throw configurationError("The xmemory provisioning configuration is invalid");
  }
}

export function loadXmemoryProvisionConfig(
  env: NodeJS.ProcessEnv = process.env,
): XmemoryProvisionConfig {
  try {
    return {
      adminApiKey: requiredEnvironmentValue(env, "XMEM_ADMIN_API_KEY"),
      clusterId: requiredEnvironmentValue(env, "XMEM_CLUSTER_ID"),
      instanceName: validateInstanceName(requiredEnvironmentValue(env, "XMEM_INSTANCE_NAME")),
    };
  } catch {
    throw configurationError("The xmemory provisioning configuration is invalid");
  }
}

type ProvisionStage = "preflight" | "create" | "post_create";

const PREFLIGHT_ERROR_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "unsupported_configuration",
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "protocol_error",
  "provisioning_conflict",
]);

const CREATE_REJECTION_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "provisioning_conflict",
]);

const POST_CREATE_ERROR_CODES: ReadonlySet<XmemoryMemoryErrorCode> = new Set([
  "invalid_input",
  "authentication",
  "authorization",
  "instance_not_found",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "protocol_error",
]);

function safeProvisionMessage(code: XmemoryMemoryErrorCode): string {
  switch (code) {
    case "authentication":
      return "xmemory provisioning authentication failed";
    case "authorization":
      return "xmemory provisioning authorization failed";
    case "instance_not_found":
      return "The xmemory provisioning target was not found";
    case "rate_limited":
      return "The xmemory provisioning rate limit was exceeded";
    case "quota_exceeded":
      return "The xmemory provisioning quota was exceeded";
    case "unavailable":
      return "xmemory provisioning is unavailable";
    case "invalid_input":
      return "xmemory rejected the provisioning request";
    case "schema_mismatch":
      return "The created xmemory schema does not match the committed schema";
    case "provisioning_conflict":
      return "An xmemory instance with this name already exists";
    case "provision_outcome_unknown":
      return "The xmemory instance creation outcome is unknown";
    default:
      return "xmemory provisioning failed";
  }
}

function sanitizeProvisionError(
  error: unknown,
  stage: ProvisionStage,
): XmemoryMemoryError {
  let code: XmemoryMemoryErrorCode =
    stage === "create" ? "provision_outcome_unknown" : "protocol_error";
  try {
    if (error instanceof XmemoryMemoryError && error.operation === "provision") {
      if (stage === "preflight" && PREFLIGHT_ERROR_CODES.has(error.code)) code = error.code;
      if (stage === "create" && CREATE_REJECTION_CODES.has(error.code)) code = error.code;
      if (stage === "create" && error.code === "provision_outcome_unknown") {
        code = "provision_outcome_unknown";
      }
      if (stage === "post_create" && POST_CREATE_ERROR_CODES.has(error.code)) code = error.code;
    } else if (stage !== "create" && isXmemoryUnavailableCause(error)) {
      code = "unavailable";
    }
  } catch {
    code = stage === "create" ? "provision_outcome_unknown" : "protocol_error";
  }
  return new XmemoryMemoryError(code, "provision", safeProvisionMessage(code));
}

function summary(input: Partial<XmemoryProvisionSummary> = {}): XmemoryProvisionSummary {
  return {
    instanceId: null,
    instanceName: null,
    schemaSha256: null,
    created: false,
    schemaVerified: false,
    instanceRetired: false,
    errorCode: null,
    ...input,
  };
}

export async function provisionXmemoryInstance(
  config: XmemoryProvisionConfig,
  dependencies: XmemoryProvisionDependencies = {},
): Promise<XmemoryProvisionSummary> {
  const normalized = normalizeProvisionConfig(config);

  let expected: LoadedXmemorySchema;
  let admin: XmemoryAdminPort;
  try {
    expected = await (dependencies.loadSchema ?? loadXmemorySchema)();
    admin = dependencies.admin ?? createXmemoryAdminPort({ adminApiKey: normalized.adminApiKey });
  } catch (error) {
    throw sanitizeProvisionError(error, "preflight");
  }

  try {
    const cluster = await admin.getCluster(normalized.clusterId, ADMIN_TIMEOUT_MS);
    if (cluster.id !== normalized.clusterId) throw new Error("cluster envelope mismatch");
    const instances = await admin.listInstances(ADMIN_TIMEOUT_MS);
    if (instances.some((instance) => instance.name === normalized.instanceName)) {
      throw new XmemoryMemoryError(
        "provisioning_conflict",
        "provision",
        "An xmemory instance with this name already exists",
      );
    }
  } catch (error) {
    throw sanitizeProvisionError(error, "preflight");
  }

  let instanceId: string;
  try {
    const created = await admin.createInstance({
      clusterId: normalized.clusterId,
      name: normalized.instanceName,
      description: INSTANCE_DESCRIPTION,
      schemaYml: expected.source,
      timeoutMs: ADMIN_TIMEOUT_MS,
    });
    if (typeof created.id !== "string" || created.id.trim() === "") {
      throw new XmemoryMemoryError(
        "provision_outcome_unknown",
        "provision",
        "The xmemory instance creation outcome is unknown",
      );
    }
    instanceId = created.id;
  } catch (error) {
    const normalizedError = sanitizeProvisionError(error, "create");
    if (normalizedError.code === "provision_outcome_unknown") {
      return summary({
        instanceName: normalized.instanceName,
        schemaSha256: expected.sha256,
        instanceRetired: true,
        errorCode: "provision_outcome_unknown",
      });
    }
    throw normalizedError;
  }

  let live: Record<string, unknown>;
  try {
    live = await admin.getSchema(instanceId, ADMIN_TIMEOUT_MS);
  } catch (error) {
    const normalizedError = sanitizeProvisionError(error, "post_create");
    return summary({
      instanceId,
      instanceName: normalized.instanceName,
      schemaSha256: expected.sha256,
      created: true,
      instanceRetired: true,
      errorCode: normalizedError.code,
    });
  }

  try {
    assertXmemorySchemaCompatible(expected, live);
  } catch {
    return summary({
      instanceId,
      instanceName: normalized.instanceName,
      schemaSha256: expected.sha256,
      created: true,
      instanceRetired: true,
      errorCode: "schema_mismatch",
    });
  }

  return summary({
    instanceId,
    instanceName: normalized.instanceName,
    schemaSha256: expected.sha256,
    created: true,
    schemaVerified: true,
  });
}

export async function provisionDisposableXmemoryInstance(
  purpose: XmemoryDisposablePurpose,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: XmemoryProvisionDependencies = {},
): Promise<XmemoryProvisionSummary> {
  let apiKey: string;
  let admin: XmemoryAdminPort;
  let clusterId: string;
  let instanceName: string;
  try {
    apiKey = requiredEnvironmentValue(env, "XMEM_API_KEY");
    admin = dependencies.admin ?? createXmemoryAdminPort({ adminApiKey: apiKey });
    const clusters = await admin.listClusters(ADMIN_TIMEOUT_MS);
    if (clusters.length !== 1) throw configurationError("Expected exactly one xmemory cluster");
    const cluster = clusters[0];
    if (cluster === undefined) throw configurationError("Expected one xmemory cluster");
    clusterId = cluster.id;
    instanceName = validateInstanceName(
      dependencies.createInstanceName?.(purpose) ??
        `loci-${purpose}-${randomUUID().slice(0, 8)}`,
    );
  } catch (error) {
    throw sanitizeProvisionError(error, "preflight");
  }

  return provisionXmemoryInstance(
    { adminApiKey: apiKey, clusterId, instanceName },
    { ...dependencies, admin },
  );
}

export type XmemoryProvisionCliOptions = {
  env?: NodeJS.ProcessEnv;
  dependencies?: XmemoryProvisionDependencies;
  writeStdout?: (value: string) => void;
};

export async function runXmemoryProvisionCli(
  options: XmemoryProvisionCliOptions = {},
): Promise<number> {
  let result: XmemoryProvisionSummary;
  try {
    result = await provisionDisposableXmemoryInstance(
      "runtime",
      options.env ?? process.env,
      options.dependencies,
    );
  } catch (error) {
    const normalizedError = sanitizeProvisionError(error, "preflight");
    result = summary({ errorCode: normalizedError.code });
  }
  (options.writeStdout ?? ((value) => process.stdout.write(value)))(`${JSON.stringify(result)}\n`);
  return result.errorCode === null ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runXmemoryProvisionCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
