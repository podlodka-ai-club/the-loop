export function mem0IntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEM0_INTEGRATION === "1";
}
