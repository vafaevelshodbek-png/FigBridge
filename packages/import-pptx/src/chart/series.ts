/**
 * Series and categories read from a chart part's cached values.
 */
import type { Paint } from "@figbridge/scene";
import type { SlideContext } from "../context.js";
import { attr, child, childrenOf, find, findAll, num, type XmlElement } from "../xml.js";
import { accent, firstPaint, type TextStyle, textStyle } from "./style.js";

export interface Series {
  name: string;
  values: Map<number, number>;
  /** Scatter charts: x per point index (`c:xVal`). */
  xValues?: Map<number, number>;
  fill: Paint;
  /** Per-point fills (`c:dPt`), e.g. pie slices. */
  pointFills: Map<number, Paint>;
  label: TextStyle | undefined;
}

export function readSeries(ctx: SlideContext, plot: XmlElement, target: string): Series[] {
  return childrenOf(plot, "ser").map((ser, index) => {
    const values = numbers(child(ser, "val") ?? child(ser, "yVal"));
    const xVal = child(ser, "xVal");
    const pointFills = new Map<number, Paint>();
    for (const dPt of childrenOf(ser, "dPt")) {
      const paint = firstPaint(ctx, target, child(dPt, "spPr"));
      if (paint !== undefined) pointFills.set(num(child(dPt, "idx"), "val", 0), paint);
    }
    const spPr = child(ser, "spPr");
    const labels = child(ser, "dLbls");
    const showValue = attr(child(labels, "showVal"), "val") === "1";
    return {
      name: find(child(ser, "tx"), "v")?.text ?? "",
      values,
      // Line series carry their colour on the outline.
      fill:
        firstPaint(ctx, target, spPr) ??
        firstPaint(ctx, target, child(spPr, "ln")) ??
        accent(ctx, num(child(ser, "idx"), "val", index)),
      pointFills,
      label: showValue ? textStyle(ctx, labels) : undefined,
      ...(xVal === undefined ? {} : { xValues: numbers(xVal) }),
    };
  });
}

/** Cached numbers of a `c:val`/`c:xVal`/`c:yVal` by point index; non-numbers are skipped. */
function numbers(el: XmlElement | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const pt of findAll(el, "pt")) {
    const value = Number(child(pt, "v")?.text);
    if (Number.isFinite(value)) out.set(num(pt, "idx", 0), value);
  }
  return out;
}
