/**
 * Messages between the plugin's two halves.
 *
 * Figma splits a plugin into the UI iframe (has network access, no document access) and the
 * main thread (document access, no network). The UI owns the hub connection and forwards
 * requests; the main thread asks the UI to move bytes over HTTP when it needs images.
 */
import type { Request, Response } from "@figbridge/protocol";

/** UI → main. */
export type UiToMain =
  | { kind: "request"; request: Request }
  | { kind: "cancel"; id: string }
  | { kind: "blob.got"; ticket: number; bytes: Uint8Array | null; error?: string }
  | { kind: "blob.put.done"; ticket: number; blob: string | null; error?: string }
  | { kind: "storage.set"; key: string; value: string }
  | { kind: "storage.get"; ticket: number; key: string };

/** Main → UI. */
export type MainToUi =
  | { kind: "hello-info"; file: string; editorType: string; pluginVersion: string }
  | { kind: "response"; response: Response }
  | { kind: "progress"; id: string; done: number; total?: number }
  | { kind: "blob.get"; ticket: number; blob: string }
  | { kind: "blob.put"; ticket: number; bytes: Uint8Array; mimeType: string }
  | { kind: "storage.value"; ticket: number; value: string | null };

/** Keys persisted in `figma.clientStorage` on behalf of the UI. */
export const STORAGE_KEYS = { token: "figbridge.token" } as const;
