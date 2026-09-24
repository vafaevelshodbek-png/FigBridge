/**
 * One interface to the hub for MCP tools and the CLI, whether the hub runs in this process
 * or in another figbridge process on the same machine.
 */
import {
  BridgeError,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ProgressData,
  WireErrorSchema,
} from "@figbridge/protocol";
import { z } from "zod";
import type { BlobStore } from "./hub/blob-store.js";
import type { Hub, SessionSummary } from "./hub/hub.js";

export interface InvokeOptions {
  session?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  idempotencyKey?: string | undefined;
  onProgress?: ((progress: ProgressData) => void) | undefined;
}

export interface HubClient {
  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: InvokeOptions,
  ): Promise<MethodResult<M>>;
  /** Call with parameters of unknown shape (CLI input); the hub validates them. */
  invoke(method: MethodName, params: unknown, options?: InvokeOptions): Promise<unknown>;
  sessions(): Promise<SessionSummary[]>;
  putBlob(bytes: Uint8Array, mimeType: string): Promise<string>;
  getBlob(blob: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** Client for a hub living in this process. */
export class LocalHubClient implements HubClient {
  constructor(
    private readonly hub: Hub,
    private readonly blobs: BlobStore,
  ) {}

  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: InvokeOptions = {},
  ): Promise<MethodResult<M>> {
    return this.hub.call(method, params, options);
  }

  invoke(method: MethodName, params: unknown, options: InvokeOptions = {}): Promise<unknown> {
    return this.hub.invoke(method, params, options);
  }

  sessions(): Promise<SessionSummary[]> {
    return Promise.resolve(this.hub.sessions());
  }

  putBlob(bytes: Uint8Array, mimeType: string): Promise<string> {
    return Promise.resolve(this.blobs.put(bytes, mimeType));
  }

  getBlob(blob: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const entry = this.blobs.get(blob);
    if (entry === undefined)
      return Promise.reject(new BridgeError("INTERNAL", `Blob ${blob} expired or unknown.`));
    return Promise.resolve({ bytes: entry.bytes, mimeType: entry.mimeType });
  }
}

const RpcReplySchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: WireErrorSchema }),
]);

/**
 * Client for a hub owned by another process, over its loopback HTTP API.
 * Progress events are not relayed over HTTP in v1; long calls just wait.
 */
export class RemoteHubClient implements HubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: InvokeOptions = {},
  ): Promise<MethodResult<M>> {
    return (await this.invoke(method, params, options)) as MethodResult<M>;
  }

  async invoke(method: MethodName, params: unknown, options: InvokeOptions = {}): Promise<unknown> {
    const response = await this.#fetch("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method,
        params,
        session: options.session,
        timeoutMs: options.timeoutMs,
        idempotencyKey: options.idempotencyKey,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const reply = RpcReplySchema.parse(await response.json());
    if (!reply.ok) throw BridgeError.fromWire(reply.error);
    return reply.result;
  }

  async sessions(): Promise<SessionSummary[]> {
    const response = await this.#fetch("/sessions");
    return ((await response.json()) as { sessions: SessionSummary[] }).sessions;
  }

  async putBlob(bytes: Uint8Array, mimeType: string): Promise<string> {
    const response = await this.#fetch("/blob", {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: bytes.slice(),
    });
    return ((await response.json()) as { blob: string }).blob;
  }

  async getBlob(blob: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const response = await this.#fetch(`/blob/${encodeURIComponent(blob)}`);
    if (!response.ok) throw new BridgeError("INTERNAL", `Blob ${blob} expired or unknown.`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${this.token}`,
        },
      });
      if (response.status === 401)
        throw new BridgeError("UNAUTHORIZED", "The hub rejected the pairing token.");
      return response;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new BridgeError("CANCELLED", "Call cancelled.");
      throw new BridgeError(
        "NO_SESSION",
        "The figbridge hub is not reachable. Start it with `npx figbridge start`.",
        {
          cause: error,
        },
      );
    }
  }
}
