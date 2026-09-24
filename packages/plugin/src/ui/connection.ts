/**
 * WebSocket connection from the plugin UI to the hub, with handshake and reconnection.
 */
import type { Hello, Message, Welcome } from "@figbridge/protocol";

export type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; session: string }
  | { status: "unauthorized" }
  | { status: "incompatible"; reason: string }
  | { status: "waiting"; retryInMs: number };

export interface ConnectionOptions {
  url: string;
  hello: () => Hello;
  onMessage: (message: Message) => void;
  onState: (state: ConnectionState) => void;
}

/** Full-jitter exponential backoff: random in [0, min(cap, base·2^attempt)]. */
export function backoffDelay(
  attempt: number,
  random = Math.random,
  baseMs = 500,
  capMs = 10_000,
): number {
  return Math.round(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/** Close codes the hub uses for refusals that retrying will not fix. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_PROTOCOL = 4426;

export class Connection {
  #socket: WebSocket | undefined;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close(1000, "stopped");
  }

  send(message: Message): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  #open(): void {
    this.options.onState({ status: "connecting" });
    const socket = new WebSocket(this.options.url);
    this.#socket = socket;
    let welcomed = false;

    socket.onopen = () => {
      socket.send(JSON.stringify(this.options.hello()));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as Message | Welcome;
      if (!welcomed) {
        if (data.type === "welcome") {
          welcomed = true;
          this.#attempt = 0;
          this.options.onState({ status: "connected", session: data.session });
        }
        return;
      }
      this.options.onMessage(data as Message);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.options.onState({ status: "unauthorized" });
        return;
      }
      if (event.code === CLOSE_PROTOCOL) {
        this.options.onState({
          status: "incompatible",
          reason: "Update figbridge or the plugin — protocol versions differ.",
        });
        return;
      }
      if (this.#stopped) return;
      const retryInMs = backoffDelay(this.#attempt++);
      this.options.onState({ status: "waiting", retryInMs });
      this.#timer = setTimeout(() => {
        this.#open();
      }, retryInMs);
    };
  }
}
