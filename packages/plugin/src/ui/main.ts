/**
 * Plugin UI: owns the hub connection, relays requests to the main thread and moves blobs
 * over HTTP. The UI is also where the user pastes the pairing token once.
 */
import type { Hello, Message } from "@figbridge/protocol";
import { type MainToUi, STORAGE_KEYS, type UiToMain } from "../shared/messages.js";
import { Connection, type ConnectionState } from "./connection.js";

declare const __HUB_PORT__: number;

const HUB = `localhost:${__HUB_PORT__}`;
const HTTP = `http://${HUB}`;

/**
 * Identifies this plugin window for the lifetime of the window only. It must NOT be
 * persisted: clientStorage is shared by every file, and two files with the same instance
 * would be mistaken for one plugin reconnecting.
 */
const INSTANCE = `i_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const statusEl = element("status", HTMLElement);
const detailEl = element("detail", HTMLElement);
const pairForm = element("pair", HTMLFormElement);
const tokenInput = element("token", HTMLInputElement);

let token: string | null = null;
let info: { file: string; editorType: string; pluginVersion: string } | undefined;
let connection: Connection | undefined;
let storageTicket = 0;
const storageWaiters = new Map<number, (value: string | null) => void>();

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} missing from ui.html`);
  return found;
}

function toMain(message: UiToMain): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function storageGet(key: string): Promise<string | null> {
  const ticket = ++storageTicket;
  return new Promise((resolve) => {
    storageWaiters.set(ticket, resolve);
    toMain({ kind: "storage.get", ticket, key });
  });
}

const LABELS: Record<ConnectionState["status"] | "pairing", string> = {
  connecting: "Connecting…",
  connected: "Connected",
  unauthorized: "Pairing required",
  incompatible: "Incompatible versions",
  waiting: "Hub not running",
  pairing: "Pairing required",
};

function render(state: ConnectionState | { status: "pairing" }): void {
  statusEl.textContent = LABELS[state.status];
  statusEl.dataset["state"] = state.status;
  pairForm.hidden = state.status !== "pairing" && state.status !== "unauthorized";
  switch (state.status) {
    case "connected":
      detailEl.textContent = `${info?.file ?? ""} · session ${state.session}`;
      break;
    case "waiting":
      detailEl.textContent = `Start the hub: npx figbridge start (retry in ${String(Math.ceil(state.retryInMs / 1000))} s)`;
      break;
    case "incompatible":
      detailEl.textContent = state.reason;
      break;
    case "unauthorized":
    case "pairing":
      detailEl.textContent = "Run `npx figbridge pair` and paste the token.";
      break;
    case "connecting":
      detailEl.textContent = HUB;
      break;
  }
}

function hello(): Hello {
  return {
    v: 1,
    type: "hello",
    token: token ?? "",
    protocols: [1],
    plugin: { version: info?.pluginVersion ?? "0.0.0" },
    file: {
      name: info?.file ?? "",
      editorType: (info?.editorType ?? "figma") as Hello["file"]["editorType"],
    },
    instance: INSTANCE,
  };
}

function onHubMessage(message: Message): void {
  if (message.type === "req") toMain({ kind: "request", request: message });
  else if (message.type === "cancel") toMain({ kind: "cancel", id: message.id });
}

function connect(): void {
  if (token === null || info === undefined) return;
  connection?.stop();
  connection = new Connection({
    url: `ws://${HUB}/plugin`,
    hello,
    onMessage: onHubMessage,
    onState: render,
  });
  connection.start();
}

async function fetchBlob(blob: string): Promise<Uint8Array> {
  const response = await fetch(`${HTTP}/blob/${encodeURIComponent(blob)}`, {
    headers: { authorization: `Bearer ${token ?? ""}` },
  });
  if (!response.ok) throw new Error(`blob ${blob}: HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadBlob(bytes: Uint8Array, mimeType: string): Promise<string> {
  const response = await fetch(`${HTTP}/blob`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token ?? ""}`, "content-type": mimeType },
    // slice(): a copy backed by a plain ArrayBuffer, which fetch() accepts as a body.
    body: bytes.slice(),
  });
  if (!response.ok) throw new Error(`upload: HTTP ${String(response.status)}`);
  return ((await response.json()) as { blob: string }).blob;
}

function relayBlobs(message: Extract<MainToUi, { kind: "blob.get" | "blob.put" }>): void {
  if (message.kind === "blob.get") {
    fetchBlob(message.blob).then(
      (bytes) => {
        toMain({ kind: "blob.got", ticket: message.ticket, bytes });
      },
      (error: unknown) => {
        toMain({ kind: "blob.got", ticket: message.ticket, bytes: null, error: String(error) });
      },
    );
    return;
  }
  uploadBlob(message.bytes, message.mimeType).then(
    (blob) => {
      toMain({ kind: "blob.put.done", ticket: message.ticket, blob });
    },
    (error: unknown) => {
      toMain({ kind: "blob.put.done", ticket: message.ticket, blob: null, error: String(error) });
    },
  );
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainToUi }>) => {
  const message = event.data.pluginMessage;
  if (message === undefined) return;
  switch (message.kind) {
    case "hello-info":
      info = {
        file: message.file,
        editorType: message.editorType,
        pluginVersion: message.pluginVersion,
      };
      connect();
      return;
    case "response":
      connection?.send(message.response);
      return;
    case "progress":
      connection?.send({
        v: 1,
        type: "evt",
        event: "progress",
        data: {
          id: message.id,
          done: message.done,
          ...(message.total === undefined ? {} : { total: message.total }),
        },
      });
      return;
    case "blob.get":
    case "blob.put":
      relayBlobs(message);
      return;
    case "storage.value":
      storageWaiters.get(message.ticket)?.(message.value);
      storageWaiters.delete(message.ticket);
      return;
  }
};

pairForm.onsubmit = (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(value)) {
    detailEl.textContent = "The token is 32 hexadecimal characters.";
    return;
  }
  token = value;
  tokenInput.value = "";
  toMain({ kind: "storage.set", key: STORAGE_KEYS.token, value });
  connect();
};

async function boot(): Promise<void> {
  token = await storageGet(STORAGE_KEYS.token);
  if (token === null) render({ status: "pairing" });
  else connect();
}

void boot();
