/**
 * Read-only methods.
 */
import type { NodeSummary } from "@figbridge/protocol";
import { type Handler, PluginError, requireNode } from "./context.js";
import { describe, summarize } from "./summary.js";

function currentPage() {
  return { id: figma.currentPage.id, name: figma.currentPage.name, current: true };
}

export const sessionInfo: Handler<"session.info"> = (_params, ctx) =>
  Promise.resolve({
    file: figma.root.name,
    editorType: figma.editorType,
    page: currentPage(),
    selectionCount: figma.currentPage.selection.length,
    access: ctx.access.mode,
    paused: ctx.access.paused,
  });

export const pageList: Handler<"page.list"> = () =>
  Promise.resolve({
    pages: figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      current: page.id === figma.currentPage.id,
    })),
  });

export const pageSet: Handler<"page.set"> = async ({ pageId }) => {
  const page = figma.root.children.find((p) => p.id === pageId);
  if (page === undefined) throw new PluginError("NODE_NOT_FOUND", `Page ${pageId} does not exist.`);
  await figma.setCurrentPageAsync(page);
  return currentPage();
};

export const selectionGet: Handler<"selection.get"> = () =>
  Promise.resolve({ nodes: figma.currentPage.selection.map(summarize) });

/**
 * Breadth-first outline. The cursor is the index of the next node in BFS order, so paging is
 * stable as long as the tree does not change between calls.
 */
export const documentOutline: Handler<"document.outline"> = async ({
  rootId,
  depth,
  limit,
  cursor,
}) => {
  const root = rootId === undefined ? figma.currentPage : await requireNode(rootId);
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(start) || start < 0) throw new PluginError("VALIDATION", "Invalid cursor.");

  const nodes: (NodeSummary & { depth: number })[] = [];
  let index = 0;
  const queue: { node: BaseNode; level: number }[] =
    "children" in root ? root.children.map((node) => ({ node, level: 0 })) : [];
  // Index-based queue: Array#shift is O(n) and outlines can be large.
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head];
    if (item === undefined) break;
    if (index >= start) {
      if (nodes.length === limit) return { nodes, nextCursor: String(index) };
      nodes.push({ ...summarize(item.node), depth: item.level });
    }
    index++;
    if (item.level + 1 < depth && "children" in item.node) {
      for (const child of item.node.children) queue.push({ node: child, level: item.level + 1 });
    }
  }
  return { nodes };
};

export const nodeGet: Handler<"node.get"> = async ({ nodeId, depth }) => ({
  node: describe(await requireNode(nodeId), depth),
});

export const nodeFind: Handler<"node.find"> = async ({ name, types, withinId, limit }) => {
  const root = withinId === undefined ? figma.currentPage : await requireNode(withinId);
  if (!("findAll" in root))
    throw new PluginError("VALIDATION", `Node ${withinId ?? ""} has no children to search.`);
  const needle = name?.toLowerCase();
  const typeSet = types === undefined ? undefined : new Set(types);
  const matches: SceneNode[] = [];
  let truncated = false;
  (root as ChildrenMixin).findAll((node) => {
    if (matches.length > limit) return false;
    if (needle !== undefined && !node.name.toLowerCase().includes(needle)) return false;
    if (typeSet !== undefined && !typeSet.has(node.type)) return false;
    if (matches.length === limit) {
      truncated = true;
      return false;
    }
    matches.push(node);
    return false;
  });
  return { nodes: matches.map(summarize), truncated };
};

const MIME = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" } as const;

export const nodeExport: Handler<"node.export"> = async ({ nodeId, format, scale }, ctx) => {
  const node = await requireNode(nodeId);
  if (!("exportAsync" in node))
    throw new PluginError("VALIDATION", `Node ${nodeId} cannot be exported.`);
  const bytes =
    format === "svg"
      ? await node.exportAsync({ format: "SVG" })
      : await node.exportAsync({
          format: format === "png" ? "PNG" : "JPG",
          constraint: { type: "SCALE", value: scale },
        });
  const blob = await ctx.ui.putBlob(bytes, MIME[format]);
  const factor = format === "svg" ? 1 : scale;
  const size = "width" in node ? { w: node.width, h: node.height } : { w: 0, h: 0 };
  return {
    blob,
    mimeType: MIME[format],
    width: Math.round(size.w * factor),
    height: Math.round(size.h * factor),
  };
};
