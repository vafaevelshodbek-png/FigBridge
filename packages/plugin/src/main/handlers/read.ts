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

/**
 * How long a PNG/JPG export may take before falling back to SVG. Figma's raster export
 * sometimes never settles (seen 27.09.2026 on every node of two files, a 20 × 20 rectangle
 * included, while SVG export of the same nodes took seconds).
 */
export const RASTER_EXPORT_TIMEOUT_MS = 15_000;

export const nodeExport: Handler<"node.export"> = async ({ nodeId, format, scale }, ctx) => {
  const node = await requireNode(nodeId);
  if (!("exportAsync" in node))
    throw new PluginError("VALIDATION", `Node ${nodeId} cannot be exported.`);
  const size = "width" in node ? { w: node.width, h: node.height } : { w: 0, h: 0 };
  let bytes: Uint8Array | undefined;
  let mimeType: string = MIME[format];
  if (format !== "svg") {
    bytes = await settleWithin(
      node.exportAsync({
        format: format === "png" ? "PNG" : "JPG",
        constraint: { type: "SCALE", value: scale },
      }),
      RASTER_EXPORT_TIMEOUT_MS,
    );
  }
  if (bytes === undefined) {
    // SVG either was asked for or stands in for a stuck raster export; the caller rasterizes
    // it at the returned width and height.
    bytes = await node.exportAsync({ format: "SVG" });
    mimeType = MIME.svg;
  }
  const blob = await ctx.ui.putBlob(bytes, mimeType);
  const factor = format === "svg" ? 1 : scale;
  return {
    blob,
    mimeType,
    width: Math.round(size.w * factor),
    height: Math.round(size.h * factor),
  };
};

/** The promise's value, or undefined when it has not settled within `ms`. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
