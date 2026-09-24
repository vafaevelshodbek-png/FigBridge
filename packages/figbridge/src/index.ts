/**
 * Programmatic API. Most users run the CLI (`npx figbridge mcp`); these exports are for
 * embedding the hub or writing custom tools.
 */
export { type HubClient, type InvokeOptions, LocalHubClient, RemoteHubClient } from "./client.js";
export { DEFAULT_PORT, hubPort, loadOrCreateToken, stateDir } from "./config.js";
export { BlobStore } from "./hub/blob-store.js";
export { Hub, type HubCallOptions, type SessionSummary } from "./hub/hub.js";
export { HubServer } from "./hub/server.js";
export { createMcpServer, serveMcp } from "./mcp/server.js";
export { TOOLS, type ToolDefinition } from "./mcp/tools.js";
export { type Runtime, startRuntime } from "./runtime.js";
export { VERSION } from "./version.js";
