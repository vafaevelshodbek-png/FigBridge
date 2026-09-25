/**
 * The hub's network surface on 127.0.0.1:
 *
 *   WS   /plugin        Figma plugin connections (hello → welcome → messages)
 *   GET  /health        liveness, used by other figbridge processes to find a running hub
 *   GET  /sessions      connected plugins                      (token)
 *   POST /rpc           call a plugin method                   (token)
 *   PUT  /blob          upload bytes, returns a blob reference (token)
 *   GET  /blob/:id      download bytes                         (token)
 *
 * Every request passes the Host and Origin checks from ./security.ts; everything except
 * /health also requires the pairing token (`Authorization: Bearer <token>`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BridgeError,
  HelloSchema,
  isMethodName,
  MessageSchema,
  negotiateProtocol,
  type Welcome,
} from "@figbridge/protocol";
import type { Logger } from "pino";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { BlobStore } from "./blob-store.js";
import type { Hub } from "./hub.js";
import { isAllowedOrigin, isLoopbackHost, tokensEqual } from "./security.js";
import type { Session } from "./session.js";

/** Identifies figbridge on /health so a relay never mistakes another service for the hub. */
export const SERVICE_NAME = "figbridge";

export interface HubServerOptions {
  hub: Hub;
  blobs: BlobStore;
  token: string;
  port: number;
  logger: Logger;
  version: string;
  /** Interval of WebSocket pings; the plugin is dropped after 3 missed pongs. */
  heartbeatMs?: number;
  /** Time a new socket gets to send a valid `hello`. */
  helloTimeoutMs?: number;
}

const MAX_JSON_BODY = 32 * 1024 * 1024;
const MAX_WS_MESSAGE = 32 * 1024 * 1024;
const MISSED_PONGS_ALLOWED = 3;

const RpcBodySchema = z.object({
  method: z.string(),
  params: z.unknown().default({}),
  session: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000)
    .optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export class HubServer {
  readonly #options: Required<HubServerOptions>;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  #heartbeat: NodeJS.Timeout | undefined;
  /** Missed-pong counters per plugin socket. */
  readonly #missedPongs = new WeakMap<WebSocket, number>();

  constructor(options: HubServerOptions) {
    this.#options = { heartbeatMs: 20_000, helloTimeoutMs: 5_000, ...options };
    this.#http = createServer((req, res) => {
      this.#handleHttp(req, res).catch((error: unknown) => {
        this.#options.logger.error({ err: error }, "unhandled HTTP error");
        sendError(res, BridgeError.from(error));
      });
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_MESSAGE,
      perMessageDeflate: false,
    });
    this.#http.on("upgrade", (req, socket, head) => {
      if (!this.#admit(req) || req.url !== "/plugin") {
        if (req.url !== "/plugin")
          this.#options.logger.warn({ url: req.url }, "websocket refused: unknown path");
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#acceptPlugin(ws);
      });
    });
  }

  /** Start listening on 127.0.0.1. Rejects with EADDRINUSE when another process owns the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.#options.port, "127.0.0.1", () => {
        this.#http.off("error", reject);
        this.#startHeartbeat();
        resolve((this.#http.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
    this.#options.hub.closeAll("hub shutting down");
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      this.#http.close(() => {
        resolve();
      });
      // Sockets accepted but not yet upgraded (a plugin mid-handshake) and idle HTTP
      // keep-alive connections would otherwise stay open, and the client would hang.
      this.#http.closeAllConnections();
    });
  }

  // ── admission ──────────────────────────────────────────────────────────────

  #admit(req: IncomingMessage): boolean {
    const port = (this.#http.address() as AddressInfo | null)?.port ?? this.#options.port;
    const admitted = isLoopbackHost(req.headers.host, port) && isAllowedOrigin(req.headers.origin);
    if (!admitted) {
      this.#options.logger.warn(
        { host: req.headers.host, origin: req.headers.origin, url: req.url },
        "request refused: host or origin not allowed",
      );
    }
    return admitted;
  }

  #authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
    return tokensEqual(this.#options.token, token);
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The plugin iframe issues CORS preflights for PUT /blob with custom headers.
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT");
    res.setHeader("Vary", "Origin");

    if (!this.#admit(req)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { service: SERVICE_NAME, version: this.#options.version });
      return;
    }
    if (!this.#authorized(req)) {
      sendError(res, new BridgeError("UNAUTHORIZED", "Missing or wrong pairing token."));
      return;
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      sendJson(res, 200, {
        sessions: this.#options.hub.sessions(),
        readOnly: this.#options.hub.readOnly,
      });
    } else if (req.method === "POST" && url.pathname === "/rpc") {
      await this.#handleRpc(req, res);
    } else if (req.method === "PUT" && url.pathname === "/blob") {
      const bytes = await readBody(req, MAX_JSON_BODY * 2);
      const blob = this.#options.blobs.put(
        bytes,
        req.headers["content-type"] ?? "application/octet-stream",
      );
      sendJson(res, 200, { blob });
    } else if (req.method === "GET" && url.pathname.startsWith("/blob/")) {
      const entry = this.#options.blobs.get(
        decodeURIComponent(url.pathname.slice("/blob/".length)),
      );
      if (entry === undefined) {
        sendJson(res, 404, { error: "unknown blob" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": entry.mimeType,
        "Content-Length": entry.bytes.byteLength,
      });
      res.end(entry.bytes);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  }

  async #handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = RpcBodySchema.safeParse(
      JSON.parse(new TextDecoder().decode(await readBody(req, MAX_JSON_BODY))),
    );
    if (!body.success) {
      sendError(res, new BridgeError("VALIDATION", body.error.message));
      return;
    }
    const { method, params, session, timeoutMs, idempotencyKey } = body.data;
    if (!isMethodName(method)) {
      sendError(res, new BridgeError("METHOD_NOT_FOUND", `Unknown method "${method}".`));
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const result = await this.#options.hub.invoke(method, params, {
        session,
        timeoutMs,
        idempotencyKey,
        signal: abort.signal,
      });
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendError(res, BridgeError.from(error));
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  #acceptPlugin(ws: WebSocket): void {
    const log = this.#options.logger;
    let session: Session | undefined;
    this.#missedPongs.set(ws, 0);
    const helloTimer = setTimeout(() => {
      ws.close(4001, "hello timeout");
    }, this.#options.helloTimeoutMs);

    ws.on("pong", () => {
      this.#missedPongs.set(ws, 0);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(4002, "binary frames are not used; upload blobs over HTTP");
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(rawDataToText(data));
      } catch {
        ws.close(4003, "invalid JSON");
        return;
      }

      if (session === undefined) {
        clearTimeout(helloTimer);
        const hello = HelloSchema.safeParse(json);
        if (!hello.success) {
          log.warn({ issues: hello.error.issues }, "plugin refused: malformed hello");
          ws.close(4003, "expected hello");
          return;
        }
        if (!tokensEqual(this.#options.token, hello.data.token)) {
          log.warn("plugin refused: wrong pairing token (run `figbridge pair`)");
          ws.close(4401, "UNAUTHORIZED");
          return;
        }
        const protocol = negotiateProtocol(hello.data.protocols);
        if (protocol === undefined) {
          log.warn({ offered: hello.data.protocols }, "plugin refused: no common protocol");
          ws.close(4426, "PROTOCOL_UNSUPPORTED");
          return;
        }
        session = this.#options.hub.attach(hello.data, {
          send: (text) => {
            ws.send(text);
          },
          close: (code, reason) => {
            ws.close(code, reason);
          },
        });
        const welcome: Welcome = {
          v: 1,
          type: "welcome",
          protocol,
          session: session.info.id,
          heartbeatMs: this.#options.heartbeatMs,
          maxChunkBytes: MAX_WS_MESSAGE,
        };
        ws.send(JSON.stringify(welcome));
        log.info({ session: session.info.id, file: session.info.file }, "plugin connected");
        return;
      }

      const message = MessageSchema.safeParse(json);
      if (!message.success) {
        log.warn({ session: session.info.id }, "dropped malformed message");
        return;
      }
      session.receive(message.data);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      if (session === undefined) return;
      this.#options.hub.detach(session, `socket closed (${code} ${reason.toString()})`);
      log.info({ session: session.info.id, code }, "plugin disconnected");
    });
    ws.on("error", (error) => {
      log.warn({ err: error }, "plugin socket error");
    });
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      for (const ws of this.#wss.clients) {
        const missed = (this.#missedPongs.get(ws) ?? 0) + 1;
        this.#missedPongs.set(ws, missed);
        if (missed > MISSED_PONGS_ALLOWED) ws.terminate();
        else ws.ping();
      }
    }, this.#options.heartbeatMs);
    this.#heartbeat.unref();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Decode a text WebSocket frame (ws hands over Buffer, ArrayBuffer or fragments). */
function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return data.toString("utf8");
}

function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new BridgeError("PAYLOAD_TOO_LARGE", `Request body exceeds ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

const STATUS_BY_CODE: Partial<Record<BridgeError["code"], number>> = {
  UNAUTHORIZED: 401,
  VALIDATION: 400,
  METHOD_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  READ_ONLY: 403,
};

function sendError(res: ServerResponse, error: BridgeError): void {
  sendJson(res, STATUS_BY_CODE[error.code] ?? 200, { ok: false, error: error.toWire() });
}
