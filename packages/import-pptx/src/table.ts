/**
 * DrawingML tables → a group per cell: background rect, border lines, text.
 */
import type { Paint, SceneNode } from "@figbridge/scene";
import { resolveColor } from "./color.js";
import { round, type SlideContext } from "./context.js";
import { fillElement, paintsOf } from "./fill.js";
import { cellStyle, findTableStyle, tableFlags } from "./table-styles.js";
import { textNode } from "./text.js";
import type { Box } from "./transform.js";
import { AVERAGE_GLYPH_ADVANCE } from "./units.js";
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
  const tblPr = child(tbl, "tblPr");
  const style = findTableStyle(ctx, tblPr);
  const flags = tableFlags(tblPr);
  const rows = childrenOf(tbl, "tr");
  let y = frame.y;
  for (const [rowIndex, tr] of rows.entries()) {
    // A row's h is a minimum: PowerPoint grows it to fit the tallest cell text.
    const minHeight = num(tr, "h", 0) * ctx.scale;
    const pending: { tc: XmlElement; colIndex: number; x: number; width: number }[] = [];
    let x = frame.x;
    let rowHeight = minHeight;
    for (const [colIndex, tc] of childrenOf(tr, "tc").entries()) {
      const span = num(tc, "gridSpan", 1);
      const width = columns.slice(colIndex, colIndex + span).reduce((a, b) => a + b, 0);
      if (attr(tc, "hMerge") !== "1" && attr(tc, "vMerge") !== "1") {
        pending.push({ tc, colIndex, x, width });
        rowHeight = Math.max(rowHeight, estimateTextHeight(ctx, tc, width));
      }
      x += columns[colIndex] ?? 0;
    }
    for (const { tc, colIndex, x: cellX, width } of pending) {
      const cell = buildCell(
        ctx,
        part,
        tc,
        { x: cellX, y, w: width, h: rowHeight, rot: 0, flipH: false, flipV: false },
        cellStyle(style, flags, rowIndex, colIndex, rows.length, columns.length),
        `r${String(rowIndex + 1)}c${String(colIndex + 1)}`,
      );
      if (cell !== undefined) cells.push(cell);
    }
    y += rowHeight;
  }
  return cells.length === 0
    ? []
    : [{ id: ctx.nextId(), name, type: "group", opacity: 1, visible: true, children: cells }];
}

function buildCell(
  ctx: SlideContext,
  part: string,
  tc: XmlElement,
  cellBox: Box,
  styled: ReturnType<typeof cellStyle>,
  name: string,
): SceneNode | undefined {
  const tcPr = child(tc, "tcPr");
  const parts: SceneNode[] = [];
  const fill = fillElement(tcPr) ?? styled.fill;
  const paints = fill === undefined ? [] : paintsOf(ctx, part, fill);
  if (paints.length > 0) parts.push(rect(ctx, "cell", cellBox, paints));
  const { x, y, w: width, h: rowHeight } = cellBox;
  for (const [side, horizontal] of [
    ["lnT", true],
    ["lnB", true],
    ["lnL", false],
    ["lnR", false],
  ] as const) {
    const styledEdge = {
      lnT: styled.borders.top,
      lnB: styled.borders.bottom,
      lnL: styled.borders.left,
      lnR: styled.borders.right,
    }[side];
    const ln = child(tcPr, side) ?? styledEdge;
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
  const text = textNode(
    ctx,
    withBodyInsets(tc, margins(tcPr), attr(tcPr, "anchor"), styled.textColor, styled.bold),
    undefined,
    cellBox,
    name,
  );
  if (text !== undefined) parts.push(text);
  return parts.length === 0
    ? undefined
    : { id: ctx.nextId(), name, type: "group", opacity: 1, visible: true, children: parts };
}

function margins(tcPr: XmlElement | undefined) {
  return {
    l: num(tcPr, "marL", MARGIN.l),
    r: num(tcPr, "marR", MARGIN.r),
    t: num(tcPr, "marT", MARGIN.t),
    b: num(tcPr, "marB", MARGIN.b),
  };
}

/** Line height as a multiple of the font size (PowerPoint single spacing). */
const LINE = 1.2;

/** Height a cell's text needs at `width`, estimated from character counts and font sizes. */
function estimateTextHeight(ctx: SlideContext, tc: XmlElement, width: number): number {
  const m = margins(child(tc, "tcPr"));
  const inner = Math.max(1, width - (m.l + m.r) * ctx.scale);
  let height = (m.t + m.b) * ctx.scale;
  for (const p of childrenOf(child(tc, "txBody"), "p")) {
    const runs = childrenOf(p, "r");
    const text = runs.map((r) => child(r, "t")?.text ?? "").join("");
    const sz =
      Math.max(
        ...runs.map((r) => num(child(r, "rPr"), "sz", 0)),
        num(child(p, "endParaRPr"), "sz", 0),
        0,
      ) || 1800;
    const size = (sz / 100) * 12_700 * ctx.scale;
    const lines = Math.max(1, Math.ceil((text.length * size * AVERAGE_GLYPH_ADVANCE) / inner));
    height += lines * size * LINE;
  }
  return height;
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
  textColor: XmlElement | undefined,
  bold: boolean,
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
  // Table-style text formatting enters as the lowest-precedence list style level.
  const defRPr: XmlElement = {
    name: "defRPr",
    attrs: bold ? { b: "1" } : {},
    children:
      textColor === undefined
        ? []
        : [
            {
              name: "solidFill",
              attrs: {},
              children: textColor.children.filter((c) => c.name.endsWith("Clr")),
              text: "",
            },
          ],
    text: "",
  };
  const lstStyle: XmlElement = {
    name: "lstStyle",
    attrs: {},
    children: [{ name: "defPPr", attrs: {}, children: [defRPr], text: "" }],
    text: "",
  };
  const body: XmlElement = {
    ...txBody,
    children: [
      bodyPr,
      lstStyle,
      ...txBody.children.filter((c) => c.name !== "bodyPr" && c.name !== "lstStyle"),
    ],
  };
  return { ...tc, children: [body] };
}
