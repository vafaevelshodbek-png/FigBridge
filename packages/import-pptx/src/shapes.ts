/**
 * Shape tree (`p:spTree`) → Scene nodes, in paint order.
 */
import type { Paint, SceneNode, Stroke } from "@figbridge/scene";
import { chartNodes } from "./chart/index.js";
import { round, type SlideContext } from "./context.js";
import { fillElement, paintsOf, shapeFill, shapeOutline } from "./fill.js";
import { geometryOf } from "./geometry.js";
import { blipFillPaint } from "./images.js";
import { inheritanceChain, type PlaceholderRef, placeholderOf } from "./placeholders.js";
import { tableNodes } from "./table.js";
import { textNode } from "./text.js";
import {
  type Box,
  type GroupFrame,
  mapThroughGroups,
  readGroupFrame,
  readXfrm,
} from "./transform.js";
import { attr, child, find, path, type XmlElement } from "./xml.js";

export interface WalkOptions {
  /** Part the shapes come from (relationships are resolved against it). */
  part: string;
  /** Skip placeholders (used for master/layout decoration). */
  skipPlaceholders: boolean;
}

/** Placeholder kinds that never render on slides (date, footer are optional; keep slide number). */
const HIDDEN_PLACEHOLDERS: ReadonlySet<string> = new Set(["dt", "ftr"]);

export function walkTree(
  ctx: SlideContext,
  tree: XmlElement | undefined,
  options: WalkOptions,
  groups: GroupFrame[] = [],
): SceneNode[] {
  const out: SceneNode[] = [];
  for (const el of tree?.children ?? []) {
    try {
      out.push(...shapeNodes(ctx, el, options, groups));
    } catch (error) {
      ctx.warn(
        `slide ${String(ctx.slideNumber)}: skipped ${el.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return out;
}

function nameOf(el: XmlElement, fallback: string): string {
  return attr(find(el, "cNvPr"), "name") ?? fallback;
}

function isHidden(el: XmlElement): boolean {
  return attr(find(el, "cNvPr"), "hidden") === "1";
}

function shapeNodes(
  ctx: SlideContext,
  el: XmlElement,
  options: WalkOptions,
  groups: GroupFrame[],
): SceneNode[] {
  switch (el.name) {
    case "sp":
    case "cxnSp":
      return spNodes(ctx, el, options, groups);
    case "pic":
      return picNodes(ctx, el, options, groups);
    case "grpSp":
      return groupNodes(ctx, el, options, groups);
    case "graphicFrame":
      return frameNodes(ctx, el, options, groups);
    case "AlternateContent": {
      const fallback = child(el, "Fallback") ?? child(el, "Choice");
      return fallback === undefined ? [] : walkTree(ctx, fallback, options, groups);
    }
    default:
      return [];
  }
}

/** Box of a shape: own xfrm, else the inherited placeholder's, mapped through groups. */
function boxOf(
  ctx: SlideContext,
  spPr: XmlElement | undefined,
  ref: PlaceholderRef | undefined,
  groups: GroupFrame[],
): Box | undefined {
  let box = readXfrm(child(spPr, "xfrm"), ctx.scale);
  if (box === undefined) {
    for (const inherited of inheritanceChain(ctx, ref).reverse()) {
      box = readXfrm(path(inherited, "spPr/xfrm"), ctx.scale);
      if (box !== undefined) break;
    }
  }
  return box === undefined ? undefined : mapThroughGroups(box, groups);
}

function base(box: Box, id: string, name: string, hidden: boolean) {
  return {
    id,
    name,
    x: round(box.x),
    y: round(box.y),
    w: round(Math.max(box.w, 0.01)),
    h: round(Math.max(box.h, 0.01)),
    rotation: box.rot,
    flipX: box.flipH,
    flipY: box.flipV,
    opacity: 1,
    visible: !hidden,
  };
}

function spNodes(
  ctx: SlideContext,
  el: XmlElement,
  options: WalkOptions,
  groups: GroupFrame[],
): SceneNode[] {
  const ref = placeholderOf(el);
  if (ref !== undefined && (options.skipPlaceholders || HIDDEN_PLACEHOLDERS.has(ref.type)))
    return [];
  const spPr = child(el, "spPr");
  const style = child(el, "style");
  const box = boxOf(ctx, spPr, ref, groups);
  if (box === undefined) return [];
  const name = nameOf(el, el.name);
  const hidden = isHidden(el);

  let fills = shapeFill(ctx, options.part, spPr, style);
  if (fills === undefined && ref !== undefined) {
    for (const inherited of inheritanceChain(ctx, ref).reverse()) {
      fills = shapeFill(ctx, options.part, child(inherited, "spPr"), child(inherited, "style"));
      if (fills !== undefined) break;
    }
  }
  const outline = shapeOutline(ctx, options.part, spPr, style);
  const strokes: Stroke[] = outline === undefined ? [] : [outline.stroke];
  const paints: Paint[] = fills ?? [];

  const nodes: SceneNode[] = [];
  const geometry = geometryOf(spPr, box.w, box.h);
  if (paints.length > 0 || strokes.length > 0) {
    switch (geometry.kind) {
      case "rect":
        nodes.push({
          ...base(box, ctx.nextId(), name, hidden),
          type: "rect",
          fills: paints,
          strokes,
          radii: geometry.radii.map(round) as [number, number, number, number],
        });
        break;
      case "ellipse":
        nodes.push({
          ...base(box, ctx.nextId(), name, hidden),
          type: "ellipse",
          fills: paints,
          strokes,
        });
        break;
      case "path": {
        const filled = geometry.paths.filter((p) => p.filled);
        const stroked = geometry.paths.filter((p) => p.stroked);
        const vectorPaths = (filled.length > 0 ? filled : stroked).map((p) => ({
          d: p.d,
          fillRule: p.fillRule,
        }));
        if (vectorPaths.length > 0) {
          nodes.push({
            ...base(box, ctx.nextId(), name, hidden),
            type: "vector",
            paths: vectorPaths,
            fills: filled.length > 0 ? paints : [],
            strokes,
          });
        }
        break;
      }
      case "unsupported":
        ctx.warn(
          `slide ${String(ctx.slideNumber)}: shape preset "${geometry.preset}" drawn as its bounding rectangle`,
        );
        nodes.push({
          ...base(box, ctx.nextId(), name, hidden),
          type: "rect",
          fills: paints,
          strokes,
          radii: [0, 0, 0, 0],
        });
        break;
    }
  }
  const text = textNode(ctx, el, ref, box, name);
  if (text !== undefined) {
    if (hidden) text.visible = false;
    nodes.push(text);
  }
  if (nodes.length > 1) {
    return [
      { id: ctx.nextId(), name, type: "group", opacity: 1, visible: !hidden, children: nodes },
    ];
  }
  return nodes;
}

function picNodes(
  ctx: SlideContext,
  el: XmlElement,
  options: WalkOptions,
  groups: GroupFrame[],
): SceneNode[] {
  const ref = placeholderOf(el);
  if (ref !== undefined && options.skipPlaceholders) return [];
  const spPr = child(el, "spPr");
  const box = boxOf(ctx, spPr, ref, groups);
  const blipFill = child(el, "blipFill");
  if (box === undefined || blipFill === undefined) return [];
  const paint = blipFillPaint(ctx, options.part, blipFill);
  if (paint === undefined) return [];
  const name = nameOf(el, "picture");
  const outline = shapeOutline(ctx, options.part, spPr, child(el, "style"));
  const geometry = geometryOf(spPr, box.w, box.h);
  const common = base(box, ctx.nextId(), name, isHidden(el));
  const strokes = outline === undefined ? [] : [outline.stroke];
  if (geometry.kind === "ellipse") return [{ ...common, type: "ellipse", fills: [paint], strokes }];
  if (geometry.kind === "path") {
    return [
      {
        ...common,
        type: "vector",
        paths: geometry.paths.map((p) => ({ d: p.d, fillRule: p.fillRule })),
        fills: [paint],
        strokes,
      },
    ];
  }
  const radii =
    geometry.kind === "rect"
      ? (geometry.radii.map(round) as [number, number, number, number])
      : ([0, 0, 0, 0] as [number, number, number, number]);
  return [{ ...common, type: "image", image: paint, radii, strokes }];
}

function groupNodes(
  ctx: SlideContext,
  el: XmlElement,
  options: WalkOptions,
  groups: GroupFrame[],
): SceneNode[] {
  const grpSpPr = child(el, "grpSpPr");
  const frame = readGroupFrame(child(grpSpPr, "xfrm"), ctx.scale);
  const fill = fillElement(grpSpPr);
  ctx.groupFills.push(fill === undefined ? [] : paintsOf(ctx, options.part, fill));
  let children: SceneNode[];
  try {
    children = walkTree(ctx, el, options, [...groups, frame]);
  } finally {
    ctx.groupFills.pop();
  }
  if (children.length === 0) return [];
  return [
    {
      id: ctx.nextId(),
      name: nameOf(el, "group"),
      type: "group",
      opacity: 1,
      visible: !isHidden(el),
      children,
    },
  ];
}

function frameNodes(
  ctx: SlideContext,
  el: XmlElement,
  options: WalkOptions,
  groups: GroupFrame[],
): SceneNode[] {
  const box = readXfrm(child(el, "xfrm"), ctx.scale);
  if (box === undefined) return [];
  const mapped = mapThroughGroups(box, groups);
  const data = path(el, "graphic/graphicData");
  const table = child(data, "tbl");
  if (table !== undefined) return tableNodes(ctx, table, mapped, nameOf(el, "table"), options.part);
  const chart = child(data, "chart");
  if (chart !== undefined) return chartNodes(ctx, chart, mapped, nameOf(el, "chart"), options.part);
  ctx.warn(
    `slide ${String(ctx.slideNumber)}: ${attr(data, "uri")?.split("/").pop() ?? "graphic"} object skipped (SmartArt/OLE are not supported)`,
  );
  return [];
}
