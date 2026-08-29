import { XmemoryMemoryError } from "./error.ts";

export type XmemoryIntegrationConfig = {
  apiKey: string;
  runtimeInstanceId: string;
  integrationInstanceId: string;
};

export function xmemoryIntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return env.XMEM_INTEGRATION === "1";
  } catch {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "The xmemory integration configuration is invalid",
    );
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      `${name} is required for xmemory integration`,
    );
  }
  return value;
}

export function loadXmemoryIntegrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): XmemoryIntegrationConfig {
  try {
    const apiKey = required(env, "XMEM_API_KEY");
    const runtimeInstanceId = required(env, "XMEM_INSTANCE_ID");
    const integrationInstanceId = required(env, "XMEM_INTEGRATION_INSTANCE_ID");
    if (runtimeInstanceId !== integrationInstanceId) {
      return { apiKey, runtimeInstanceId, integrationInstanceId };
    }
  } catch {
    // Collapse environment/Proxy failures to the same sanitized configuration error.
  }
  throw new XmemoryMemoryError(
    "unsupported_configuration",
    "schema",
    "The xmemory integration configuration is invalid",
  );
}
