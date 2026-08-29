import { createXmemoryAdminPortInternal, createXmemoryPlatformPortInternal } from "./platform-internal.ts";
import {
  XMEMORY_API_BASE_URL,
  type XmemoryAdminPort,
  type XmemoryPlatformPort,
} from "./platform-contract.ts";

export { XMEMORY_API_BASE_URL } from "./platform-contract.ts";

export function createXmemoryPlatformPort(config: {
  apiKey: string;
  instanceId: string;
}): XmemoryPlatformPort {
  return createXmemoryPlatformPortInternal(config, undefined, XMEMORY_API_BASE_URL);
}

export function createXmemoryAdminPort(config: { adminApiKey: string }): XmemoryAdminPort {
  return createXmemoryAdminPortInternal(config, undefined, XMEMORY_API_BASE_URL);
}
