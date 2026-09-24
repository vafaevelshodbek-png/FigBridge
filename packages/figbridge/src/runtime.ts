/**
 * Process-level wiring: own the hub if the port is free, otherwise attach to the hub that
 * another figbridge process already runs (several MCP clients can share one plugin).
 */

import { type HubClient, LocalHubClient, RemoteHubClient } from "./client.js";
import { hubPort, loadOrCreateToken } from "./config.js";
import { BlobStore } from "./hub/blob-store.js";
import { Hub } from "./hub/hub.js";
import { HubServer, SERVICE_NAME } from "./hub/server.js";
import { createLogger } from "./log.js";
import { VERSION } from "./version.js";

export interface Runtime {
  client: HubClient;
  /** True when this process owns the hub (and must keep running for the plugin). */
  owner: boolean;
  port: number;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  readOnly?: boolean;
  /** Fail instead of attaching when another process already owns the port. */
  requireOwnership?: boolean;
}

export async function startRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const port = hubPort();
  const token = loadOrCreateToken();
  const logger = createLogger();
  const hub = new Hub({ readOnly: options.readOnly ?? false });
  const blobs = new BlobStore();
  const server = new HubServer({ hub, blobs, token, port, logger, version: VERSION });

  try {
    await server.listen();
    logger.info({ port }, "hub listening on 127.0.0.1");
    return {
      client: new LocalHubClient(hub, blobs),
      owner: true,
      port,
      close: () => server.close(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.requireOwnership === true)
      throw error;
  }

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  if (!(await isFigbridge(baseUrl))) {
    throw new Error(
      `Port ${String(port)} is used by another program. Set FIGBRIDGE_PORT to a free port.`,
    );
  }
  if (options.readOnly === true) {
    logger.warn(
      "attached to an existing hub; --read-only applies only to the process that owns the hub",
    );
  }
  logger.info({ port }, "attached to an existing figbridge hub");
  return {
    client: new RemoteHubClient(baseUrl, token),
    owner: false,
    port,
    close: () => Promise.resolve(),
  };
}

async function isFigbridge(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { service?: unknown };
    return body.service === SERVICE_NAME;
  } catch {
    return false;
  }
}
