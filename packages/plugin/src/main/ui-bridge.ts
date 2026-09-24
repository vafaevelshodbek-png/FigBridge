/**
 * Main-thread side of the UI channel: ask the UI iframe to fetch/upload blobs over HTTP.
 */
import type { MainToUi, UiToMain } from "../shared/messages.js";

type Waiter = { resolve: (value: never) => void; reject: (error: Error) => void };

export class UiBridge {
  #ticket = 0;
  readonly #waiting = new Map<number, Waiter>();

  post(message: MainToUi): void {
    figma.ui.postMessage(message);
  }

  /** Download blob bytes from the hub. */
  getBlob(blob: string): Promise<Uint8Array> {
    return this.#ask<Uint8Array>((ticket) => ({ kind: "blob.get", ticket, blob }));
  }

  /** Upload bytes to the hub; resolves with the blob reference. */
  putBlob(bytes: Uint8Array, mimeType: string): Promise<string> {
    return this.#ask<string>((ticket) => ({ kind: "blob.put", ticket, bytes, mimeType }));
  }

  /** Handle a reply from the UI; returns false for messages that are not replies. */
  handleReply(message: UiToMain): boolean {
    switch (message.kind) {
      case "blob.got":
        this.#settle(message.ticket, message.bytes, message.error);
        return true;
      case "blob.put.done":
        this.#settle(message.ticket, message.blob, message.error);
        return true;
      case "request":
      case "cancel":
      case "storage.set":
      case "storage.get":
        return false;
    }
  }

  #ask<T>(build: (ticket: number) => MainToUi): Promise<T> {
    const ticket = ++this.#ticket;
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(ticket, { resolve, reject });
      this.post(build(ticket));
    });
  }

  #settle(ticket: number, value: unknown, error: string | undefined): void {
    const waiter = this.#waiting.get(ticket);
    if (waiter === undefined) return;
    this.#waiting.delete(ticket);
    if (value === null || value === undefined)
      waiter.reject(new Error(error ?? "blob transfer failed"));
    else waiter.resolve(value as never);
  }
}
