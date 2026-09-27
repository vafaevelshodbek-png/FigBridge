/**
 * Messages between the plugin's two halves.
 *
 * Figma splits a plugin into the UI iframe (has network access, no document access) and the
 * main thread (document access, no network). The UI owns the hub connection and forwards
 * requests; the main thread asks the UI to move bytes over HTTP when it needs images.
 */
import type { AccessMode, Request, Response } from "@figbridge/protocol";

/** UI → main. */
export type UiToMain =
  | { kind: "request"; request: Request }
  | { kind: "cancel"; id: string }
  | { kind: "blob.got"; ticket: number; bytes: Uint8Array | null; error?: string }
  | { kind: "blob.put.done"; ticket: number; blob: string | null; error?: string }
  | { kind: "storage.set"; key: string; value: string }
  | { kind: "storage.get"; ticket: number; key: string }
  | { kind: "access.set"; mode: AccessMode }
  | { kind: "pause.set"; paused: boolean }
  | { kind: "approval.answer"; id: string; answer: "once" | "session" | "deny" }
  | { kind: "label.set"; label: string }
  | { kind: "undo.run" };

/** Main → UI. */
export type MainToUi =
  | {
      kind: "hello-info";
      file: string;
      /** Name the user gave this file for agents; "" when none. */
      label: string;
      editorType: string;
      pluginVersion: string;
    }
  | { kind: "response"; response: Response }
  | { kind: "progress"; id: string; done: number; total?: number }
  | { kind: "blob.get"; ticket: number; blob: string }
  | { kind: "blob.put"; ticket: number; bytes: Uint8Array; mimeType: string }
  | { kind: "storage.value"; ticket: number; value: string | null }
  | { kind: "access"; mode: AccessMode; paused: boolean }
  | {
      kind: "approval.request";
      id: string;
      method: string;
      summary: string;
      risk: "write" | "destructive";
    }
  | { kind: "approval.closed"; id: string }
  | { kind: "activity"; entry: ActivityEntry }
  /** The agent change "Undo agent" would revert; label undefined when there is none. */
  | { kind: "undo"; label?: string; possible: boolean }
  /** Fonts replaced so far in this plugin run, for the user to install. */
  | { kind: "fonts"; replaced: { wanted: string; used: string }[] };

/** One line of the plugin's activity feed. */
export interface ActivityEntry {
  id: string;
  method: string;
  status: "running" | "done" | "failed" | "refused";
  detail?: string;
}

/** Keys persisted in `figma.clientStorage` on behalf of the UI. */
export const STORAGE_KEYS = { token: "figbridge.token" } as const;
