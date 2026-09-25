/**
 * One connected plugin instance (= one open Figma file) and its in-flight requests.
 */
import {
  BridgeError,
  type EditorType,
  type Message,
  type MethodName,
  type ProgressData,
  ProgressDataSchema,
} from "@figbridge/protocol";
import { ulid } from "ulid";

/** Minimal socket surface the session needs; lets tests use a fake. */
export interface SessionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SessionInfo {
  readonly id: string;
  readonly instance: string;
  readonly file: string;
  readonly editorType: EditorType;
  readonly pluginVersion: string;
  readonly connectedAt: Date;
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | undefined;
  onProgress?: ((progress: ProgressData) => void) | undefined;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: BridgeError): void;
  onProgress: ((progress: ProgressData) => void) | undefined;
  cleanup(): void;
}

export class Session {
  #socket: SessionSocket;
  readonly #pending = new Map<string, Pending>();
  lastSeen = new Date();

  #info: SessionInfo;

  constructor(info: SessionInfo, socket: SessionSocket) {
    this.#info = info;
    this.#socket = socket;
  }

  /** Number of requests awaiting a response. */
  get inFlight(): number {
    return this.#pending.size;
  }

  get info(): SessionInfo {
    return this.#info;
  }

  /**
   * Swap the socket after the plugin reconnected with the same instance id. The file name
   * is taken from the new handshake: the file may have been renamed, or given a name for
   * agents, in between.
   */
  rebind(socket: SessionSocket, file: string = this.#info.file): void {
    this.#info = { ...this.#info, file };
    this.#socket.close(4000, "replaced by a newer connection");
    this.#socket = socket;
    this.failAll(
      new BridgeError("SESSION_NOT_FOUND", "The plugin reconnected; retry the call.", {
        retryable: true,
      }),
    );
  }

  /** Send a request and wait for its response. */
  call(method: MethodName, params: unknown, options: CallOptions): Promise<unknown> {
    if (options.signal?.aborted === true) {
      return Promise.reject(new BridgeError("CANCELLED", `${method} was cancelled.`));
    }
    const id = ulid();
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.#send({ v: 1, type: "cancel", id });
        settle(() => {
          reject(new BridgeError("CANCELLED", `${method} was cancelled.`));
        });
      };
      const timer = setTimeout(() => {
        this.#send({ v: 1, type: "cancel", id });
        settle(() => {
          reject(
            new BridgeError(
              "TIMEOUT",
              `${method} did not finish in ${options.timeoutMs} ms. The plugin may be busy or its window closed.`,
            ),
          );
        });
      }, options.timeoutMs);

      const settle = (finish: () => void) => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        entry.cleanup();
        this.#pending.delete(id);
        finish();
      };

      this.#pending.set(id, {
        resolve: (result) => {
          settle(() => {
            resolve(result);
          });
        },
        reject: (error) => {
          settle(() => {
            reject(error);
          });
        },
        onProgress: options.onProgress,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.#send({
        v: 1,
        type: "req",
        id,
        method,
        params,
        session: this.info.id,
        timeoutMs: options.timeoutMs,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      });
    });
  }

  /** Route a message received from the plugin. */
  receive(message: Message): void {
    this.lastSeen = new Date();
    switch (message.type) {
      case "res": {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return; // late reply after timeout/cancel: ignore
        if (message.ok) pending.resolve(message.result);
        else pending.reject(BridgeError.fromWire(message.error));
        return;
      }
      case "evt": {
        if (message.event !== "progress") return;
        const progress = ProgressDataSchema.safeParse(message.data);
        if (progress.success) this.#pending.get(progress.data.id)?.onProgress?.(progress.data);
        return;
      }
      case "req":
      case "cancel":
        // The plugin never initiates requests in protocol v1.
        return;
    }
  }

  /** Reject every in-flight request (disconnect, shutdown). */
  failAll(error: BridgeError): void {
    for (const pending of [...this.#pending.values()]) pending.reject(error);
  }

  close(reason: string): void {
    this.failAll(new BridgeError("SESSION_NOT_FOUND", reason, { retryable: true }));
    this.#socket.close(1000, reason);
  }

  #send(message: Message): void {
    this.#socket.send(JSON.stringify(message));
  }
}
