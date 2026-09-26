/**
 * Undo of the agent's own changes. Figma's undo cannot tell the agent's change from the
 * user's latest one, so the plugin records what each agent call did and reverts exactly
 * that: layers the agent created are removed, properties it changed get their old values.
 * The user's own edits are never touched. Deletions cannot be reverted by a plugin (a
 * removed node is gone); they are recorded so the UI can say so.
 */
import type { FontLoader } from "./render/fonts.js";

/** Changes remembered, newest first. */
const DEPTH = 20;

/** Old values of the properties node.update may change. */
export interface Before {
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  fills?: readonly Paint[];
  cornerRadius?: number;
  characters?: string;
}

export type UndoEntry =
  | { kind: "created"; label: string; nodeIds: string[] }
  | { kind: "updated"; label: string; nodeId: string; before: Before }
  | { kind: "deleted"; label: string };

export class UndoLog {
  readonly #entries: UndoEntry[] = [];

  constructor(
    private readonly onChange: (latest: UndoEntry | undefined) => void = () => undefined,
  ) {}

  get latest(): UndoEntry | undefined {
    return this.#entries[0];
  }

  record(entry: UndoEntry): void {
    this.#entries.unshift(entry);
    this.#entries.length = Math.min(this.#entries.length, DEPTH);
    this.onChange(this.latest);
  }

  /**
   * Revert the latest change. Returns what was done, for the activity feed; a deletion is
   * only dropped from the log with an explanation.
   */
  async undo(fonts: FontLoader): Promise<string> {
    const entry = this.#entries.shift();
    try {
      if (entry === undefined) return "Nothing to undo.";
      switch (entry.kind) {
        case "deleted":
          return `${entry.label} cannot be undone by the plugin — use Ctrl+Z in Figma if it was the last change.`;
        case "created": {
          let removed = 0;
          for (const id of entry.nodeIds) {
            const node = await figma.getNodeByIdAsync(id);
            if (node !== null && node.type !== "PAGE" && node.type !== "DOCUMENT") {
              node.remove();
              removed++;
            }
          }
          figma.commitUndo();
          return `Undid: ${entry.label} (${String(removed)} removed)`;
        }
        case "updated": {
          const node = await figma.getNodeByIdAsync(entry.nodeId);
          if (node === null || !("x" in node))
            return `Undid nothing: ${entry.label} — the layer is gone.`;
          await restore(node, entry.before, fonts);
          figma.commitUndo();
          return `Undid: ${entry.label}`;
        }
      }
    } finally {
      this.onChange(this.latest);
    }
  }
}

/** The old values of the properties `props` is about to change on `node`. */
export function capture(node: SceneNode, props: Record<string, unknown>): Before {
  const before: Before = {};
  if (props["name"] !== undefined) before.name = node.name;
  if (props["x"] !== undefined) before.x = node.x;
  if (props["y"] !== undefined) before.y = node.y;
  if ((props["w"] !== undefined || props["h"] !== undefined) && "resize" in node) {
    before.w = node.width;
    before.h = node.height;
  }
  if (props["rotation"] !== undefined && "rotation" in node) before.rotation = node.rotation;
  if (props["opacity"] !== undefined && "opacity" in node) before.opacity = node.opacity;
  if (props["visible"] !== undefined) before.visible = node.visible;
  if (props["fill"] !== undefined && "fills" in node && Array.isArray(node.fills))
    before.fills = node.fills as readonly Paint[];
  if (
    props["cornerRadius"] !== undefined &&
    "cornerRadius" in node &&
    typeof node.cornerRadius === "number"
  )
    before.cornerRadius = node.cornerRadius;
  if (props["text"] !== undefined && node.type === "TEXT") before.characters = node.characters;
  return before;
}

async function restore(node: SceneNode, before: Before, fonts: FontLoader): Promise<void> {
  if (before.name !== undefined) node.name = before.name;
  if (before.w !== undefined && before.h !== undefined && "resize" in node)
    node.resize(before.w, before.h);
  if (before.x !== undefined) node.x = before.x;
  if (before.y !== undefined) node.y = before.y;
  if (before.rotation !== undefined && "rotation" in node) node.rotation = before.rotation;
  if (before.opacity !== undefined && "opacity" in node) node.opacity = before.opacity;
  if (before.visible !== undefined) node.visible = before.visible;
  if (before.fills !== undefined && "fills" in node) node.fills = before.fills;
  if (before.cornerRadius !== undefined && "cornerRadius" in node)
    (node as SceneNode & CornerMixin).cornerRadius = before.cornerRadius;
  if (before.characters !== undefined && node.type === "TEXT") {
    for (const font of node.getRangeAllFontNames(0, Math.max(node.characters.length, 1)))
      await fonts.resolve({ family: font.family, style: font.style });
    node.characters = before.characters;
  }
}
