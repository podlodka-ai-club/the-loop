import { HINDSIGHT_CLOUD_BASE_URL } from "./constants.ts";
import type { HindsightPlatformPort } from "./platform-contract.ts";
import { createHindsightPlatformPortInternal } from "./platform-internal.ts";

export { HINDSIGHT_CLOUD_BASE_URL } from "./constants.ts";

export function createHindsightPlatformPort(config: {
  apiKey: string;
  baseUrl: typeof HINDSIGHT_CLOUD_BASE_URL;
}): HindsightPlatformPort {
  return createHindsightPlatformPortInternal(config);
}
