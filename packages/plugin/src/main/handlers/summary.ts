/**
 * Compact and detailed serializations of Figma nodes for agents.
 * Keep them small: agents pay for every token.
 */
import type { NodeSummary } from "@figbridge/protocol";

const MAX_TEXT_PREVIEW = 120;

export function summarize(node: BaseNode): NodeSummary {
  const summary: NodeSummary = { id: node.id, name: node.name, type: node.type };
  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox !== null) {
    const { x, y, width, height } = node.absoluteBoundingBox;
    summary.box = { x: round(x), y: round(y), w: round(width), h: round(height) };
  }
  if ("children" in node) summary.childCount = node.children.length;
  if (node.type === "TEXT") summary.text = node.characters.slice(0, MAX_TEXT_PREVIEW);
  return summary;
}

/** Detailed properties for `node.get`. Mixed values are reported as "mixed". */
export function describe(node: BaseNode, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...summarize(node) };
  if ("visible" in node && !node.visible) out["visible"] = false;
  if ("opacity" in node && node.opacity !== 1) out["opacity"] = node.opacity;
  if ("rotation" in node && node.rotation !== 0) out["rotation"] = round(node.rotation);
  if ("fills" in node) out["fills"] = plain(node.fills);
  if ("strokes" in node && node.strokes.length > 0) {
    out["strokes"] = plain(node.strokes);
    out["strokeWeight"] = plain(node.strokeWeight);
  }
  if ("cornerRadius" in node) out["cornerRadius"] = plain(node.cornerRadius);
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    out["layout"] = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
    };
  }
  if (node.type === "TEXT") {
    out["text"] = node.characters;
    out["font"] = {
      name: plain(node.fontName),
      size: plain(node.fontSize),
      lineHeight: plain(node.lineHeight),
    };
  }
  if (depth > 0 && "children" in node)
    out["children"] = node.children.map((child) => describe(child, depth - 1));
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Figma returns `figma.mixed` (a symbol) for mixed properties; JSON cannot carry symbols. */
function plain(value: unknown): unknown {
  return typeof value === "symbol" ? "mixed" : value;
}
