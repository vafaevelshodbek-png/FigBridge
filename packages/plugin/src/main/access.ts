/**
 * Agent access control, decided in the plugin — the only place neither the hub nor the agent
 * can bypass. The user picks a mode in the plugin window (see AccessMode in the protocol);
 * every request is classified by risk and either runs, waits for the user, or is refused.
 */
import type { AccessMode } from "@figbridge/protocol";
import { MUTATING_METHODS } from "@figbridge/protocol/access";

export { APPROVAL_TIMEOUT_MS } from "@figbridge/protocol/access";

import { PluginError } from "./handlers/context.js";

/** Deleting more layers than this at once is destructive. */
export const LARGE_DELETE = 20;
/** Creating or rendering more layers than this in one call is a large change. */
export const LARGE_CHANGE = 200;

export type Risk = "read" | "write" | "destructive";

export interface Assessment {
  risk: Risk;
  /** One line for the user: what the agent wants to do. */
  summary: string;
}

/** Counts a node and its descendants; undefined when the node does not exist. */
export type NodeSizer = (id: string) => Promise<{ type: string; size: number } | undefined>;

function countScene(nodes: readonly { type: string; children?: readonly unknown[] }[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum +
      1 +
      (node.type === "group"
        ? countScene((node.children ?? []) as { type: string; children?: readonly unknown[] }[])
        : 0),
    0,
  );
}

/** Classify one request. Pure apart from `sizer`, which reads the document. */
export async function assess(
  method: string,
  params: unknown,
  sizer: NodeSizer,
): Promise<Assessment> {
  if (!MUTATING_METHODS.has(method)) return { risk: "read", summary: method };
  const p = params as Record<string, unknown>;
  switch (method) {
    case "node.delete": {
      const ids = (p["nodeIds"] as string[] | undefined) ?? [];
      let layers = 0;
      let pages = 0;
      for (const id of ids) {
        const node = await sizer(id);
        if (node === undefined) continue;
        layers += node.size;
        if (node.type === "PAGE") pages++;
      }
      const summary = `Delete ${String(ids.length)} layer${ids.length === 1 ? "" : "s"} (${String(layers)} with children)`;
      return { risk: layers > LARGE_DELETE || pages > 0 ? "destructive" : "write", summary };
    }
    case "scene.render": {
      const slide = p["slide"] as { name?: string; children?: { type: string }[] } | undefined;
      const count = countScene(slide?.children ?? []);
      const replacing = p["replaceId"] !== undefined;
      const summary = `${replacing ? "Replace a frame with" : "Add"} slide "${slide?.name ?? ""}" (${String(count)} layers)`;
      return { risk: replacing || count > LARGE_CHANGE ? "destructive" : "write", summary };
    }
    case "nodes.create": {
      const count = countScene((p["nodes"] as { type: string }[] | undefined) ?? []);
      return {
        risk: count > LARGE_CHANGE ? "destructive" : "write",
        summary: `Create ${String(count)} layers`,
      };
    }
    case "node.update":
      return { risk: "write", summary: `Change layer ${String(p["nodeId"])}` };
    case "node.clone":
      return { risk: "write", summary: `Duplicate layer ${String(p["nodeId"])}` };
    default:
      return { risk: "write", summary: method };
  }
}

export type Decision = "allow" | "ask" | "deny";

/** What the mode says about a request of this risk. */
export function decide(mode: AccessMode, risk: Risk, approvedForSession: boolean): Decision {
  if (risk === "read") return "allow";
  switch (mode) {
    case "read-only":
      return "deny";
    case "ask":
      return approvedForSession ? "allow" : "ask";
    case "auto":
      return risk === "destructive" && !approvedForSession ? "ask" : "allow";
    case "unrestricted":
      return "allow";
  }
}

export type Answer = "once" | "session" | "deny";

export interface AccessHost {
  /** Persisted mode for this file, if the user chose one. */
  loadMode(): AccessMode | undefined;
  saveMode(mode: AccessMode): void;
  /** Ask the user; resolves with their answer. */
  askUser(request: { id: string; method: string; summary: string; risk: Risk }): Promise<Answer>;
  /** The state changed: show it. */
  onChange(state: { mode: AccessMode; paused: boolean }): void;
}

/** The per-file access state and the approval flow. */
export class AccessControl {
  #mode: AccessMode;
  #paused = false;
  #approvedForSession = false;

  constructor(private readonly host: AccessHost) {
    // `unrestricted` is never persisted, so reopening the plugin always starts safe.
    this.#mode = host.loadMode() ?? "ask";
  }

  get mode(): AccessMode {
    return this.#mode;
  }

  get paused(): boolean {
    return this.#paused;
  }

  setMode(mode: AccessMode): void {
    this.#mode = mode;
    this.#approvedForSession = false;
    if (mode !== "unrestricted") this.host.saveMode(mode);
    this.#changed();
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#changed();
  }

  /** Resolve when the request may run; throw a PluginError when it may not. */
  async authorize(id: string, method: string, params: unknown, sizer: NodeSizer): Promise<void> {
    if (this.#paused) {
      throw new PluginError(
        "PAUSED",
        "The user paused the agent in the figbridge plugin. Wait, or ask them to resume.",
      );
    }
    const { risk, summary } = await assess(method, params, sizer);
    const decision = decide(this.#mode, risk, this.#approvedForSession);
    if (decision === "allow") return;
    if (decision === "deny") {
      throw new PluginError(
        "READ_ONLY",
        "This file is read-only for agents. Ask the user to switch the figbridge plugin to Ask or Auto.",
      );
    }
    const answer = await this.host.askUser({ id, method, summary, risk });
    if (answer === "deny") {
      throw new PluginError(
        "DENIED",
        `The user declined: ${summary}. Do not retry unchanged; ask them what they want instead.`,
      );
    }
    if (answer === "session") this.#approvedForSession = true;
  }

  #changed(): void {
    this.host.onChange({ mode: this.#mode, paused: this.#paused });
  }
}
