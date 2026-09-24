/**
 * A scripted stand-in for the Figma plugin: connects over a real WebSocket, performs the
 * handshake and answers requests with handlers supplied by the test.
 */
import type { Message } from "@figbridge/protocol";
import WebSocket from "ws";

export type Handler = (params: unknown, request: { id: string }) => unknown;

export interface FakePluginOptions {
  port: number;
  token: string;
  file?: string;
  instance?: string;
  protocols?: number[];
  handlers?: Record<string, Handler>;
}

export class FakePlugin {
  readonly received: Message[] = [];
  session: string | undefined;
  #ws: WebSocket | undefined;

  constructor(readonly options: FakePluginOptions) {}

  /** Connect and wait for `welcome`; rejects with the close reason on refusal. */
  connect(origin = "null"): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.options.port}/plugin`, { origin });
    this.#ws = ws;
    return new Promise((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      ws.on("close", (code, reason) => {
        reject(new Error(`closed ${code} ${reason.toString()}`));
      });
      ws.on("error", reject);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "hello",
            token: this.options.token,
            protocols: this.options.protocols ?? [1],
            plugin: { version: "0.0.0-test" },
            file: { name: this.options.file ?? "Test file", editorType: "figma" },
            instance: this.options.instance ?? "instance-test-1",
          }),
        );
      });
      ws.on("message", (data) => {
        const message = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
          type: string;
          session?: string;
        };
        if (message.type === "welcome") {
          this.session = message.session;
          resolve();
          return;
        }
        this.#onMessage(message as Message);
      });
    });
  }

  send(message: unknown): void {
    this.#ws?.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    const ws = this.#ws;
    if (ws === undefined || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once("close", () => {
        resolve();
      });
      ws.close();
    });
  }

  #onMessage(message: Message): void {
    this.received.push(message);
    if (message.type !== "req") return;
    const handler = this.options.handlers?.[message.method];
    if (handler === undefined) return; // silence → lets tests exercise timeouts
    try {
      const result = handler(message.params, { id: message.id });
      this.send({ v: 1, type: "res", id: message.id, ok: true, result });
    } catch (error) {
      this.send({
        v: 1,
        type: "res",
        id: message.id,
        ok: false,
        error: { code: "NODE_NOT_FOUND", message: String(error), retryable: false },
      });
    }
  }
}
