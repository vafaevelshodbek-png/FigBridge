/**
 * Table styles (`tableStyleId`): the per-region fills, borders and text formatting that
 * PowerPoint applies when cells carry no explicit formatting.
 *
 * Regions apply in increasing precedence: whole table, banded rows/columns, last/first column,
 * last/first row (ECMA-376 §20.1.4.2).
 */
import type { SlideContext } from "./context.js";
import { BUILT_IN_TABLE_STYLES } from "./table-styles-builtin.js";
import { attr, child, childrenOf, parseXml, type XmlElement } from "./xml.js";

export interface TableFlags {
  firstRow: boolean;
  lastRow: boolean;
  firstCol: boolean;
  lastCol: boolean;
  bandRow: boolean;
  bandCol: boolean;
}

export interface CellStyle {
  /** Fill element (`solidFill`, `noFill`, …) or undefined. */
  fill: XmlElement | undefined;
  /** Border `ln` elements for each edge. */
  borders: { top?: XmlElement; bottom?: XmlElement; left?: XmlElement; right?: XmlElement };
  /** Colour container for the text (element with a colour child). */
  textColor: XmlElement | undefined;
  bold: boolean;
}

export function tableFlags(tblPr: XmlElement | undefined): TableFlags {
  const on = (name: string) => attr(tblPr, name) === "1" || attr(tblPr, name) === "true";
  return {
    firstRow: on("firstRow"),
    lastRow: on("lastRow"),
    firstCol: on("firstCol"),
    lastCol: on("lastCol"),
    bandRow: on("bandRow"),
    bandCol: on("bandCol"),
  };
}

/** The table style referenced by `tblPr`, from the package or the built-in set. */
export function findTableStyle(
  ctx: SlideContext,
  tblPr: XmlElement | undefined,
): XmlElement | undefined {
  const id = child(tblPr, "tableStyleId")?.text.trim();
  if (id === undefined || id === "") return undefined;
  const list = ctx.pkg.xml("ppt/tableStyles.xml");
  const own = childrenOf(list, "tblStyle").find((s) => attr(s, "styleId") === id);
  if (own !== undefined) return own;
  const builtIn = BUILT_IN_TABLE_STYLES[id];
  return builtIn === undefined ? undefined : parseXml(builtIn);
}

/** Resolve the style of cell (row, col) in a rows × cols table. */
export function cellStyle(
  style: XmlElement | undefined,
  flags: TableFlags,
  row: number,
  col: number,
  rows: number,
  cols: number,
): CellStyle {
  const out: CellStyle = { fill: undefined, borders: {}, textColor: undefined, bold: false };
  if (style === undefined) return out;
  const regions: string[] = ["wholeTbl"];
  const dataRow = flags.firstRow ? row - 1 : row;
  const dataCol = flags.firstCol ? col - 1 : col;
  if (flags.bandRow && dataRow >= 0) regions.push(dataRow % 2 === 0 ? "band1H" : "band2H");
  if (flags.bandCol && dataCol >= 0) regions.push(dataCol % 2 === 0 ? "band1V" : "band2V");
  if (flags.lastCol && col === cols - 1) regions.push("lastCol");
  if (flags.firstCol && col === 0) regions.push("firstCol");
  if (flags.lastRow && row === rows - 1) regions.push("lastRow");
  if (flags.firstRow && row === 0) regions.push("firstRow");

  for (const name of regions) {
    const region = child(style, name);
    if (region === undefined) continue;
    const tcStyle = child(region, "tcStyle");
    const fill =
      child(child(tcStyle, "fill"), "solidFill") ?? child(child(tcStyle, "fill"), "noFill");
    if (fill !== undefined) out.fill = fill;
    const bdr = child(tcStyle, "tcBdr");
    const edge = (name: string) => child(child(bdr, name), "ln");
    // Outer edges use the region's outer borders; inner edges use insideH/insideV.
    const top = row === 0 ? edge("top") : edge("insideH");
    const bottom = row === rows - 1 ? edge("bottom") : edge("insideH");
    const left = col === 0 ? edge("left") : edge("insideV");
    const right = col === cols - 1 ? edge("right") : edge("insideV");
    // Header/footer rows may redefine their own top/bottom rules; the whole table sets all.
    const set = (key: keyof CellStyle["borders"], ln: XmlElement | undefined) => {
      if (ln !== undefined) out.borders[key] = ln;
    };
    if (name === "firstRow" || name === "lastRow") {
      set("top", edge("top"));
      set("bottom", edge("bottom"));
    }
    if (name === "wholeTbl") {
      set("top", top);
      set("bottom", bottom);
      set("left", left);
      set("right", right);
    }
    const tx = child(region, "tcTxStyle");
    if (tx !== undefined) {
      if (tx.children.some((c) => c.name.endsWith("Clr"))) out.textColor = tx;
      if (attr(tx, "b") === "on") out.bold = true;
    }
  }
  return out;
}
