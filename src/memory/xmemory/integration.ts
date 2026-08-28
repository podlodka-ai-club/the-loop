import { XmemoryMemoryError } from "./error.ts";

export type XmemoryIntegrationConfig = {
  apiKey: string;
  runtimeInstanceId: string;
  integrationInstanceId: string;
};

export function xmemoryIntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XMEM_INTEGRATION === "1";
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
  const apiKey = required(env, "XMEM_API_KEY");
  const runtimeInstanceId = required(env, "XMEM_INSTANCE_ID");
  const integrationInstanceId = required(env, "XMEM_INTEGRATION_INSTANCE_ID");
  if (runtimeInstanceId === integrationInstanceId) {
    throw new XmemoryMemoryError(
      "unsupported_configuration",
      "schema",
      "The xmemory integration instance must be distinct from the runtime instance",
    );
  }
  return { apiKey, runtimeInstanceId, integrationInstanceId };
}
