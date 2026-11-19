/**
 * Mutating methods. Each commits one undo step, so Ctrl+Z reverts a whole call.
 */
import type { SceneNode as SceneNodeIR } from "@figbridge/scene";
import { hexToRgb } from "../render/geometry.js";
import { SceneRenderer } from "../render/scene-renderer.js";
import { attachNotes, fitIntoSlide } from "../render/slides.js";
import { capture } from "../undo.js";
import { type Handler, PluginError, requireContainer, requireNode } from "./context.js";
import { summarize } from "./summary.js";

export const pageEnsure: Handler<"page.ensure"> = async ({ name, renameId, maxPages }) => {
  let page = figma.root.children.find((p) => p.name === name);
  if (page === undefined && renameId !== undefined) {
    const candidate = await requireNode(renameId);
    if (candidate.type !== "PAGE")
      throw new PluginError("VALIDATION", "renameId must identify a page.");
    page = candidate;
    page.name = name;
  }
  if (page === undefined) {
    if (figma.root.children.length >= maxPages)
      throw new PluginError(
        "VALIDATION",
        `Page limit ${String(maxPages)} reached; specify renameId to reuse a page.`,
      );
    page = figma.createPage();
    page.name = name;
  }
  await figma.setCurrentPageAsync(page);
  figma.commitUndo();
  return { id: page.id, name: page.name, current: true };
};

export const sceneRender: Handler<"scene.render"> = async (
  { slide, x, y, parentId, replaceId, sourceKey, strict },
  ctx,
) => {
  let position = { x, y };
  let parent = await requireContainer(parentId);
  let old: BaseNode | undefined;
  if (sourceKey !== undefined) {
    const matches = parent.children.filter(
      (node) => node.getPluginData("figbridge.sourceKey") === sourceKey,
    );
    if (matches.length > 1)
      throw new PluginError(
        "VALIDATION",
        "Multiple frames have this source key; inspect before re-import.",
      );
    const owned = matches[0];
    if (owned !== undefined) {
      if (replaceId !== undefined && replaceId !== owned.id)
        throw new PluginError("VALIDATION", "replaceId disagrees with sourceKey.");
      replaceId = owned.id;
    }
  }
  if (replaceId !== undefined) {
    old = await requireNode(replaceId);
    if ("x" in old && "y" in old) position = { x: old.x, y: old.y };
    if (old.parent !== null && "appendChild" in old.parent) parent = old.parent;
  }
  const warnings: string[] = [];
  const total = countNodes(slide.children);
  const renderer = new SceneRenderer({
    fonts: ctx.fonts,
    yieldControl: () => ctx.ui.yieldControl(),
    images: ctx.images,
    checkCancelled: ctx.checkCancelled,
    warnings,
    onNode: () => {
      ctx.progress(renderer.created, total);
    },
  });
  // In Figma Slides every imported page becomes a real slide; elsewhere a frame on the canvas.
  const slideNode =
    figma.editorType === "slides" && replaceId === undefined ? figma.createSlide() : undefined;
  if (slideNode !== undefined) {
    parent = slideNode;
    position = { x: 0, y: 0 };
  }
  const frame = await renderer.renderSlide(slide, parent, position.x, position.y);
  if (strict && warnings.length > 0) {
    frame.remove();
    throw new PluginError(
      "VALIDATION",
      `Render rejected; previous frame preserved: ${warnings.join("; ")}`,
    );
  }
  if (sourceKey !== undefined) frame.setPluginData("figbridge.sourceKey", sourceKey);
  old?.remove();
  const placed = slideNode === undefined ? frame : fitIntoSlide(slideNode, frame);
  if (slide.notes !== undefined) await attachNotes(placed, slide.notes, ctx.fonts);
  figma.commitUndo();
  ctx.undo.record({
    kind: "created",
    label: `${replaceId === undefined ? "add" : "replace with"} slide "${slide.name}"`,
    nodeIds: [placed.id],
  });
  for (const [wanted, used] of ctx.fonts.substitutions)
    warnings.push(`font ${wanted} replaced by ${used}`);
  ctx.ui.post({
    kind: "fonts",
    replaced: [...ctx.fonts.substitutions].map(([wanted, used]) => ({ wanted, used })),
  });
  return { frameId: placed.id, created: renderer.created, warnings };
};

export const nodesCreate: Handler<"nodes.create"> = async ({ nodes, parentId }, ctx) => {
  const parent = await requireContainer(parentId);
  const warnings: string[] = [];
  const renderer = new SceneRenderer({
    fonts: ctx.fonts,
    yieldControl: () => ctx.ui.yieldControl(),
    images: ctx.images,
    checkCancelled: ctx.checkCancelled,
    warnings,
  });
  const created = await renderer.renderChildren(nodes, parent);
  figma.commitUndo();
  ctx.undo.record({
    kind: "created",
    label: `create ${String(created.length)} layer${created.length === 1 ? "" : "s"}`,
    nodeIds: created.map((node) => node.id),
  });
  return { ids: created.map((node) => node.id), warnings };
};

export const nodeUpdate: Handler<"node.update"> = async ({ nodeId, props }, ctx) => {
  const node = await requireNode(nodeId);
  if (!("x" in node)) throw new PluginError("VALIDATION", `Node ${nodeId} is not a layer.`);
  const layer = node;
  if (props.effects !== undefined) {
    if (!("effects" in layer) || !Array.isArray(layer.effects))
      throw new PluginError("VALIDATION", `Node ${nodeId} has no effects.`);
  }
  const before = capture(layer, props);
  if (props.effects !== undefined && "effects" in layer) layer.effects = props.effects;
  if (props.name !== undefined) layer.name = props.name;
  if (props.text !== undefined) {
    if (layer.type !== "TEXT")
      throw new PluginError("VALIDATION", "`text` can only be set on TEXT nodes.");
    const fonts = layer.getRangeAllFontNames(0, Math.max(layer.characters.length, 1));
    for (const font of fonts) await ctx.fonts.resolve({ family: font.family, style: font.style });
    layer.characters = props.text;
  }
  if (props.w !== undefined || props.h !== undefined) {
    if (!("resize" in layer))
      throw new PluginError("VALIDATION", `Node ${nodeId} cannot be resized.`);
    layer.resize(props.w ?? layer.width, props.h ?? layer.height);
  }
  if (props.x !== undefined) layer.x = props.x;
  if (props.y !== undefined) layer.y = props.y;
  if (props.rotation !== undefined && "rotation" in layer) layer.rotation = props.rotation;
  if (props.opacity !== undefined && "opacity" in layer) layer.opacity = props.opacity;
  if (props.visible !== undefined) layer.visible = props.visible;
  if (props.fill !== undefined) {
    if (!("fills" in layer)) throw new PluginError("VALIDATION", `Node ${nodeId} has no fills.`);
    layer.fills = [{ type: "SOLID", color: hexToRgb(props.fill) }];
  }
  if (props.cornerRadius !== undefined) {
    if (!("cornerRadius" in layer))
      throw new PluginError("VALIDATION", `Node ${nodeId} has no corner radius.`);
    (layer as SceneNode & CornerMixin).cornerRadius = props.cornerRadius;
  }
  figma.commitUndo();
  ctx.undo.record({ kind: "updated", label: `change "${layer.name}"`, nodeId: layer.id, before });
  return summarize(layer);
};

export const nodeDelete: Handler<"node.delete"> = async ({ nodeIds }, ctx) => {
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node === null || node.type === "DOCUMENT" || node.type === "PAGE") missing.push(id);
    else {
      node.remove();
      deleted.push(id);
    }
  }
  figma.commitUndo();
  if (deleted.length > 0) {
    ctx.undo.record({
      kind: "deleted",
      label: `delete ${String(deleted.length)} layer${deleted.length === 1 ? "" : "s"}`,
    });
  }
  return { deleted, missing };
};

export const nodeClone: Handler<"node.clone"> = async ({ nodeId, parentId, x, y }, ctx) => {
  const node = await requireNode(nodeId);
  if (!("clone" in node)) throw new PluginError("VALIDATION", `Node ${nodeId} cannot be cloned.`);
  const copy = (node as SceneNode).clone();
  if (parentId !== undefined) (await requireContainer(parentId)).appendChild(copy);
  if (x !== undefined) copy.x = x;
  if (y !== undefined) copy.y = y;
  figma.commitUndo();
  ctx.undo.record({ kind: "created", label: `duplicate "${copy.name}"`, nodeIds: [copy.id] });
  return summarize(copy);
};

function countNodes(nodes: readonly SceneNodeIR[]): number {
  return nodes.reduce(
    (total, node) =>
      total + 1 + (node.type === "group" || node.type === "frame" ? countNodes(node.children) : 0),
    0,
  );
}
