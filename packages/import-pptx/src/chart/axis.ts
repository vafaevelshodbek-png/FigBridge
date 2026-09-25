/**
 * The value axis: its scale (from the file when it says, else chosen like PowerPoint does),
 * tick labels in the axis number format, and major gridlines.
 */
import type { Paint, SceneNode } from "@figbridge/scene";
import { resolveColor } from "../color.js";
import { ptToPx, type SlideContext } from "../context.js";
import { attr, child, find, num, type XmlElement } from "../xml.js";
import { LABEL_ADVANCE } from "./layout.js";
import type { Series } from "./series.js";
import { label, type Plot, rect, type TextStyle, textStyle } from "./style.js";

export interface ValueScale {
  /** Top of the axis (the bottom is 0). */
  max: number;
  /** Distance between gridlines. */
  step: number;
  format: (value: number) => string;
}

/** PowerPoint picks a 1-2-5 step giving at most this many intervals. */
const MAX_INTERVALS = 10;
/** Headroom PowerPoint leaves above the largest value before rounding up. */
const HEADROOM = 1.05;
/** Office default gridline colour (tx1 at 15 % over white) and width. */
const GRIDLINE: Paint = { type: "solid", color: "#D9D9D9", opacity: 1 };
const GRIDLINE_PT = 0.75;

/** Axis top and step for data up to `max`, the way PowerPoint auto-scales. */
export function niceScale(max: number): { max: number; step: number } {
  let step = 10 ** Math.floor(Math.log10(max / MAX_INTERVALS));
  for (const m of [1, 2, 5, 10]) {
    if (max / (step * m) <= MAX_INTERVALS) {
      step *= m;
      break;
    }
  }
  return { max: Math.ceil((max * HEADROOM) / step) * step, step };
}

/** Largest value the axis must reach: per point, or per category when stacked. */
export function dataMax(series: readonly Series[], categories: number, stacked: boolean): number {
  if (!stacked) return Math.max(0, ...series.flatMap((s) => [...s.values.values()]));
  const totals = Array.from({ length: categories }, (_, ci) =>
    series.reduce((sum, s) => sum + Math.max(0, s.values.get(ci) ?? 0), 0),
  );
  return Math.max(0, ...totals);
}

/** A formatter for an Excel number format code (the common cases charts use). */
export function numberFormat(code: string | undefined, percent: boolean): (v: number) => string {
  const effective = code === undefined || code === "General" ? (percent ? "0%" : "General") : code;
  const decimals = /0\.(0+)/.exec(effective)?.[1]?.length ?? 0;
  const grouping = effective.includes(",");
  if (effective.includes("%")) {
    return (v) => `${(v * 100).toFixed(decimals)}%`;
  }
  if (effective === "General") {
    return (v) => String(Math.round(v * 1e6) / 1e6);
  }
  return (v) =>
    v.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    });
}

/** The chart's value scale: explicit `c:max`/`c:majorUnit` win over auto-scaling. */
export function valueScale(
  valAx: XmlElement | undefined,
  max: number,
  percent: boolean,
): ValueScale {
  const scaling = child(valAx, "scaling");
  const auto = percent ? { max: 1, step: 0.1 } : niceScale(max);
  const top = num(child(scaling, "max"), "val", auto.max);
  const step = num(child(valAx, "majorUnit"), "val", auto.step);
  return {
    max: top > 0 ? top : auto.max,
    step: step > 0 ? step : auto.step,
    format: numberFormat(attr(child(valAx, "numFmt"), "formatCode"), percent),
  };
}

/**
 * Reserve room for the value axis labels (left of a vertical axis, below a horizontal one)
 * and return the function that draws labels and gridlines once the plot is final.
 */
export function valueAxis(
  ctx: SlideContext,
  axis: XmlElement | undefined,
  scale: ValueScale,
  plot: Plot,
  horizontal: boolean,
  base: TextStyle,
): { gridlines: () => SceneNode[]; labels: () => SceneNode[] } {
  const deleted = attr(child(axis, "delete"), "val") === "1";
  const shown = !deleted && attr(child(axis, "tickLblPos"), "val") !== "none";
  const style = textStyle(ctx, axis) ?? base;
  const ticks: number[] = [];
  for (let v = 0; v <= scale.max + scale.step / 1000; v += scale.step) ticks.push(v);
  const texts = ticks.map(scale.format);
  const width = Math.max(...texts.map((t) => t.length)) * style.sizePx * LABEL_ADVANCE;
  const height = style.sizePx * 1.4;
  if (shown) {
    if (horizontal) plot.bottom -= height + style.sizePx * 0.4;
    else plot.left += width + style.sizePx * 0.6;
  }

  const at = (v: number) =>
    horizontal
      ? plot.left + ((plot.right - plot.left) * v) / scale.max
      : plot.bottom - ((plot.bottom - plot.top) * v) / scale.max;

  const gridlines = (): SceneNode[] => {
    const grid = child(axis, "majorGridlines");
    if (grid === undefined) return [];
    const ln = find(child(grid, "spPr"), "ln");
    const color = resolveColor(child(ln, "solidFill"), ctx.colors);
    const paint: Paint =
      color === undefined ? GRIDLINE : { type: "solid", color: color.color, opacity: color.alpha };
    const weight = Math.max(
      0.5,
      ln === undefined ? ptToPx(ctx, GRIDLINE_PT) : num(ln, "w", 9525) * ctx.scale,
    );
    return ticks.map((v) =>
      horizontal
        ? rect(ctx, "gridline", at(v) - weight / 2, plot.top, weight, plot.bottom - plot.top, [
            paint,
          ])
        : rect(ctx, "gridline", plot.left, at(v) - weight / 2, plot.right - plot.left, weight, [
            paint,
          ]),
    );
  };

  const labels = (): SceneNode[] => {
    if (!shown) return [];
    return ticks.map((v, i) => {
      const text = texts[i] ?? "";
      return horizontal
        ? label(ctx, text, at(v) - width / 2, plot.bottom + style.sizePx * 0.4, width, style)
        : label(
            ctx,
            text,
            plot.left - width - style.sizePx * 0.6,
            at(v) - height / 2,
            width,
            style,
            "right",
          );
    });
  };

  return { gridlines, labels };
}
