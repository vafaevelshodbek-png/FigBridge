/**
 * Chart furniture around the plot: title, legend, category labels, axis line and the value axis maximum.
 */
import type { Paint, SceneNode, TextNode } from "@figbridge/scene";
import { resolveColor, solidPaint } from "../color.js";
import { ptToPx, type SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import { AVERAGE_GLYPH_ADVANCE } from "../units.js";
import { attr, child, find, findAll, num, type XmlElement } from "../xml.js";
import type { Series } from "./series.js";
import { label, PLOT, type Plot, rect, type TextStyle, textStyle } from "./style.js";

/** Glyph advance for sizing label columns: 10 % headroom so the longest label never clips. */
export const LABEL_ADVANCE = AVERAGE_GLYPH_ADVANCE * 1.1;

/** Chart title: explicit rich text, or the series name for an auto title. */
export function titleNode(
  ctx: SlideContext,
  chart: XmlElement | undefined,
  series: Series[],
  frame: Box,
  base: TextStyle,
): TextNode | undefined {
  const title = child(chart, "title");
  if (title === undefined || attr(child(chart, "autoTitleDeleted"), "val") === "1")
    return undefined;
  const text =
    findAll(child(title, "tx"), "t")
      .map((t) => t.text)
      .join("") || (series.length === 1 ? (series[0]?.name ?? "") : "");
  if (text === "") return undefined;
  const run = find(child(title, "tx"), "rPr") ?? find(child(title, "tx"), "defRPr");
  // Office sizes an unformatted title at 1.2× the chart's default text, bold.
  const style = textStyle(ctx, title) ?? {
    ...base,
    sizePx:
      attr(run, "sz") === undefined ? base.sizePx * 1.2 : ptToPx(ctx, num(run, "sz", 0) / 100),
    bold: attr(run, "b") !== "0",
  };
  return label(ctx, text, frame.x, frame.y + frame.h * 0.02, frame.w, style);
}

/** Legend on the right (default) or at the bottom: a swatch and a name per entry. */
export function legendNodes(
  ctx: SlideContext,
  legend: XmlElement | undefined,
  entries: { name: string; fill: Paint }[],
  frame: Box,
  plot: Plot,
  base: TextStyle,
): { nodes: SceneNode[]; left: number } {
  const right = frame.x + frame.w;
  if (legend === undefined || entries.length === 0) return { nodes: [], left: right };
  const style = textStyle(ctx, legend) ?? base;
  const size = style.sizePx;
  const row = size * 1.4;
  const swatch = size * 0.7;
  const textWidth = Math.max(...entries.map((e) => e.name.length)) * size * LABEL_ADVANCE + size;
  const width = swatch + size * 0.4 + textWidth;
  const left = right - width - frame.w * 0.02;
  const top = (plot.top + plot.bottom) / 2 - (entries.length * row) / 2;
  const nodes = entries.flatMap((entry, i): SceneNode[] => {
    const y = top + i * row;
    return [
      rect(
        ctx,
        `legend · ${entry.name}`,
        left,
        y + (row - swatch) / 2 - size * 0.1,
        swatch,
        swatch,
        [entry.fill],
      ),
      label(ctx, entry.name, left + swatch + size * 0.4, y, textWidth, style, "left"),
    ];
  });
  return { nodes, left: left - frame.w * 0.03 };
}

/** Horizontal bar charts put category names left of the plot, bottom-up. */
export function barCategoryLabels(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  categories: readonly string[],
  plot: Plot,
  base: TextStyle,
): SceneNode[] {
  const catAxis = find(chartPart, "catAx");
  if (attr(child(catAxis, "delete"), "val") === "1" || categories.length === 0) return [];
  const style = textStyle(ctx, catAxis) ?? base;
  const width =
    Math.max(...categories.map((c) => c.length)) * style.sizePx * LABEL_ADVANCE + style.sizePx;
  const x = plot.left;
  plot.left += width + style.sizePx * 0.5;
  const step = (plot.bottom - plot.top) / categories.length;
  return categories.map((category, i) =>
    label(
      ctx,
      category,
      x,
      plot.bottom - (i + 0.5) * step - style.sizePx * 0.7,
      width,
      style,
      "right",
    ),
  );
}

export function categoryLabels(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  categories: readonly string[],
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const catAxis = find(chartPart, "catAx");
  const style = attr(child(catAxis, "delete"), "val") === "1" ? undefined : textStyle(ctx, catAxis);
  if (style === undefined) return [];
  const width = (plot.right - plot.left) / Math.max(categories.length, 1);
  return categories.map((category, i) =>
    label(
      ctx,
      category,
      plot.left + i * width,
      plot.bottom + frame.h * PLOT.labelGap,
      width,
      style,
    ),
  );
}

export function axisLine(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const ln = find(child(find(chartPart, "catAx"), "spPr"), "ln");
  const color = resolveColor(child(ln, "solidFill"), ctx.colors);
  if (color === undefined) return [];
  const weight = Math.max(0.5, num(ln, "w", 9525) * ctx.scale);
  return [
    rect(ctx, "axis", frame.x, plot.bottom - weight / 2, frame.w, weight, [solidPaint(color)]),
  ];
}
