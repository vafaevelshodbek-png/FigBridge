/**
 * The agent section of the plugin window: access mode, pause and stop, approval requests
 * and a feed of recent calls. Decisions happen in the main thread (see main/access.ts);
 * this only shows state and sends the user's choices back.
 */
import type { AccessMode } from "@figbridge/protocol";
import type { ActivityEntry, MainToUi, UiToMain } from "../shared/messages.js";

/** Entries kept in the feed. */
const FEED_SIZE = 8;

const STATUS_TEXT: Record<ActivityEntry["status"], string> = {
  running: "…",
  done: "✓",
  failed: "✗",
  refused: "⊘",
};

export interface AgentPanelElements {
  mode: HTMLSelectElement;
  danger: HTMLElement;
  pause: HTMLButtonElement;
  stop: HTMLButtonElement;
  busy: HTMLElement;
  approvals: HTMLElement;
  activity: HTMLElement;
}

export class AgentPanel {
  #paused = false;
  readonly #running = new Set<string>();

  constructor(
    private readonly el: AgentPanelElements,
    private readonly toMain: (message: UiToMain) => void,
  ) {
    el.mode.onchange = () => {
      toMain({ kind: "access.set", mode: el.mode.value as AccessMode });
    };
    el.pause.onclick = () => {
      toMain({ kind: "pause.set", paused: !this.#paused });
    };
    el.stop.onclick = () => {
      toMain({ kind: "stop" });
    };
  }

  /** Route a main-thread message; false when it is not for the panel. */
  handle(message: MainToUi): boolean {
    switch (message.kind) {
      case "access":
        this.#access(message.mode, message.paused);
        return true;
      case "approval.request":
        this.#ask(message);
        return true;
      case "approval.closed":
        this.#find(this.el.approvals, message.id)?.remove();
        return true;
      case "activity":
        this.#activity(message.entry);
        return true;
      case "hello-info":
      case "response":
      case "progress":
      case "blob.get":
      case "blob.put":
      case "storage.value":
        return false;
    }
  }

  #find(container: HTMLElement, id: string): HTMLElement | undefined {
    return Array.from(container.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.dataset["id"] === id,
    );
  }

  #access(mode: AccessMode, paused: boolean): void {
    this.#paused = paused;
    this.el.mode.value = mode;
    this.el.danger.hidden = mode !== "unrestricted";
    this.el.pause.textContent = paused ? "Resume agent" : "Pause agent";
  }

  #ask(request: Extract<MainToUi, { kind: "approval.request" }>): void {
    const destructive = request.risk === "destructive";
    const card = document.createElement("div");
    card.className = destructive ? "approval destructive" : "approval";
    card.dataset["id"] = request.id;
    const text = document.createElement("p");
    text.textContent = `${destructive ? "Destructive: " : ""}${request.summary}`;
    const row = document.createElement("div");
    row.className = "row";
    const button = (label: string, answer: "once" | "session" | "deny", style: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = style;
      b.onclick = () => {
        this.toMain({ kind: "approval.answer", id: request.id, answer });
      };
      return b;
    };
    row.append(
      button("Allow", "once", destructive ? "danger" : ""),
      button("Allow for this session", "session", "secondary"),
      button("Deny", "deny", "secondary"),
    );
    card.append(text, row);
    this.el.approvals.append(card);
  }

  #activity(entry: ActivityEntry): void {
    if (entry.status === "running") this.#running.add(entry.id);
    else this.#running.delete(entry.id);
    this.el.busy.hidden = this.#running.size === 0;

    let item = this.#find(this.el.activity, entry.id);
    if (item === undefined) {
      item = document.createElement("li");
      item.dataset["id"] = entry.id;
      this.el.activity.prepend(item);
      while (this.el.activity.children.length > FEED_SIZE)
        this.el.activity.lastElementChild?.remove();
    }
    item.dataset["status"] = entry.status;
    const detail = entry.detail === undefined ? "" : ` (${entry.detail})`;
    item.textContent = `${STATUS_TEXT[entry.status]} ${entry.method}${detail}`;
  }
}
