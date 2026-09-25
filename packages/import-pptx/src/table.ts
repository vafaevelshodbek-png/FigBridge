/**
 * DrawingML tables → a group per cell: background rect, border lines, text.
 */
import type { Paint, SceneNode } from "@figbridge/scene";
import { resolveColor } from "./color.js";
import { round, type SlideContext } from "./context.js";
import { fillElement, paintsOf } from "./fill.js";
import { textNode } from "./text.js";
import type { Box } from "./transform.js";
import { attr, child, childrenOf, num, type XmlElement } from "./xml.js";

/** Default cell margins (EMU). */
const MARGIN = { l: 91_440, r: 91_440, t: 45_720, b: 45_720 } as const;

export function tableNodes(
  ctx: SlideContext,
  tbl: XmlElement,
  frame: Box,
  name: string,
  part: string,
): SceneNode[] {
  const columns = childrenOf(child(tbl, "tblGrid"), "gridCol").map(
    (c) => num(c, "w", 0) * ctx.scale,
  );
  const cells: SceneNode[] = [];
  let y = frame.y;
  for (const [rowIndex, tr] of childrenOf(tbl, "tr").entries()) {
    const rowHeight = num(tr, "h", 0) * ctx.scale;
    let x = frame.x;
    for (const [colIndex, tc] of childrenOf(tr, "tc").entries()) {
      const span = num(tc, "gridSpan", 1);
      const width = columns.slice(colIndex, colIndex + span).reduce((a, b) => a + b, 0);
      const colWidth = columns[colIndex] ?? 0;
      if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1") {
        x += colWidth;
        continue;
      }
      const tcPr = child(tc, "tcPr");
      const cellBox: Box = { x, y, w: width, h: rowHeight, rot: 0, flipH: false, flipV: false };
      const parts: SceneNode[] = [];
      const fill = fillElement(tcPr);
      const paints = fill === undefined ? [] : paintsOf(ctx, part, fill);
      if (paints.length > 0) parts.push(rect(ctx, "cell", cellBox, paints));
      for (const [side, horizontal] of [
        ["lnT", true],
        ["lnB", true],
        ["lnL", false],
        ["lnR", false],
      ] as const) {
        const ln = child(tcPr, side);
        if (ln === undefined || child(ln, "noFill") !== undefined) continue;
        const color = resolveColor(child(ln, "solidFill"), ctx.colors);
        if (color === undefined) continue;
        const weight = Math.max(0.5, num(ln, "w", 12_700) * ctx.scale);
        const edge: Box = horizontal
          ? {
              x,
              y: (side === "lnB" ? y + rowHeight : y) - weight / 2,
              w: width,
              h: weight,
              rot: 0,
              flipH: false,
              flipV: false,
            }
          : {
              x: (side === "lnR" ? x + width : x) - weight / 2,
              y,
              w: weight,
              h: rowHeight,
              rot: 0,
              flipH: false,
              flipV: false,
            };
        parts.push(
          rect(ctx, "border", edge, [{ type: "solid", color: color.color, opacity: color.alpha }]),
        );
      }
      const margins = {
        l: num(tcPr, "marL", MARGIN.l),
        r: num(tcPr, "marR", MARGIN.r),
        t: num(tcPr, "marT", MARGIN.t),
        b: num(tcPr, "marB", MARGIN.b),
      };
      const text = textNode(
        ctx,
        withBodyInsets(tc, margins, attr(tcPr, "anchor")),
        undefined,
        cellBox,
        `r${String(rowIndex + 1)}c${String(colIndex + 1)}`,
      );
      if (text !== undefined) parts.push(text);
      if (parts.length > 0) {
        cells.push({
          id: ctx.nextId(),
          name: `r${String(rowIndex + 1)}c${String(colIndex + 1)}`,
          type: "group",
          opacity: 1,
          visible: true,
          children: parts,
        });
      }
      x += width;
    }
    y += rowHeight;
  }
  return cells.length === 0
    ? []
    : [{ id: ctx.nextId(), name, type: "group", opacity: 1, visible: true, children: cells }];
}

function rect(ctx: SlideContext, name: string, box: Box, fills: Paint[]): SceneNode {
  return {
    id: ctx.nextId(),
    name,
    type: "rect",
    x: round(box.x),
    y: round(box.y),
    w: round(Math.max(box.w, 0.01)),
    h: round(Math.max(box.h, 0.01)),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    fills,
    strokes: [],
    radii: [0, 0, 0, 0],
  };
}

/** Table cell text uses cell margins as body insets: wrap the cell's txBody accordingly. */
function withBodyInsets(
  tc: XmlElement,
  m: { l: number; r: number; t: number; b: number },
  anchor: string | undefined,
): XmlElement {
  const txBody = child(tc, "txBody");
  if (txBody === undefined) return tc;
  const bodyPr: XmlElement = {
    name: "bodyPr",
    attrs: {
      lIns: String(m.l),
      rIns: String(m.r),
      tIns: String(m.t),
      bIns: String(m.b),
      ...(anchor === undefined ? {} : { anchor }),
    },
    children: [],
    text: "",
  };
  const body: XmlElement = {
    ...txBody,
    children: [bodyPr, ...txBody.children.filter((c) => c.name !== "bodyPr")],
  };
  return { ...tc, children: [body] };
}
