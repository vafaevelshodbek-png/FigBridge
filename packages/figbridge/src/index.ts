/**
 * Programmatic API. Most users run the CLI (`npx figbridge mcp`); these exports are for
 * embedding the hub or writing custom tools.
 */

// Used by the optional browser-capture importer shipped alongside this bundle.
export { SlideSchema } from "@figbridge/scene";
export { type HubClient, type InvokeOptions, LocalHubClient, RemoteHubClient } from "./client.js";
export {
  CommentsInputSchema,
  type CommentsResult,
  FigmaCommentsClient,
  parseFileKey,
} from "./comments.js";
export { DEFAULT_PORT, hubPort, loadOrCreateToken, stateDir } from "./config.js";
export { BlobStore } from "./hub/blob-store.js";
export { Hub, type HubCallOptions, type SessionSummary } from "./hub/hub.js";
export { HubServer } from "./hub/server.js";
export { createMcpServer, serveMcp } from "./mcp/server.js";
export { TOOLS, type ToolDefinition } from "./mcp/tools.js";
export { type Runtime, startRuntime } from "./runtime.js";
export { VERSION } from "./version.js";
