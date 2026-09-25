/**
 * Bar and column charts: clustered, stacked and 100 % stacked.
 */
import type { SceneNode } from "@figbridge/scene";
import type { SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import { attr, child, num, type XmlElement } from "../xml.js";
import type { ValueScale } from "./axis.js";
import { axisLine, categoryLabels } from "./layout.js";
import type { Series } from "./series.js";
import { formatValue, label, type Plot, rect } from "./style.js";

/** Bar and column charts: clustered, stacked and 100% stacked. */
export function barNodes(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  bar: XmlElement,
  series: Series[],
  categories: string[],
  frame: Box,
  plot: Plot,
  scale: ValueScale,
): SceneNode[] {
  if (series.length === 0 || categories.length === 0) return [];
  const horizontal = attr(child(bar, "barDir"), "val") === "bar";
  const grouping = attr(child(bar, "grouping"), "val") ?? "clustered";
  const percent = grouping === "percentStacked";
  const stacked = percent || grouping === "stacked";
  const totals = categories.map((_, ci) =>
    series.reduce((sum, s) => sum + Math.max(0, s.values.get(ci) ?? 0), 0),
  );
  const top = scale.max;
  const gap = num(child(bar, "gapWidth"), "val", 150) / 100;
  const overlap = stacked ? 1 : num(child(bar, "overlap"), "val", 0) / 100;
  const slots = stacked ? 1 : series.length;
  // Horizontal bars list categories bottom-up along the vertical axis.
  const along = horizontal ? plot.bottom - plot.top : plot.right - plot.left;
  const across = horizontal ? plot.right - plot.left : plot.bottom - plot.top;
  const categorySize = along / categories.length;
  const barSize = categorySize / (slots - (slots - 1) * overlap + gap);
  const nodes: SceneNode[] = [];
  categories.forEach((category, ci) => {
    const start = horizontal
      ? plot.bottom - (ci + 1) * categorySize + (gap * barSize) / 2
      : plot.left + ci * categorySize + (gap * barSize) / 2;
    let offset = 0;
    series.forEach((s, si) => {
      const raw = s.values.get(ci);
      if (raw === undefined) return;
      const value = percent ? raw / (totals[ci] || 1) : raw;
      const length = (across * Math.max(0, value)) / top;
      const pos = start + (stacked ? 0 : si * barSize * (1 - overlap));
      const fill = s.pointFills.get(ci) ?? s.fill;
      const barName = `${s.name} · ${category}`;
      if (horizontal)
        nodes.push(rect(ctx, barName, plot.left + offset, pos, length, barSize, [fill]));
      else
        nodes.push(rect(ctx, barName, pos, plot.bottom - offset - length, barSize, length, [fill]));
      if (s.label !== undefined) {
        const style = { ...s.label, fill: s.label.fill ?? fill };
        const text = formatValue(raw);
        nodes.push(
          horizontal
            ? label(
                ctx,
                text,
                plot.left + offset + length,
                pos + barSize / 2 - style.sizePx * 0.7,
                style.sizePx * 4,
                style,
              )
            : label(
                ctx,
                text,
                pos - barSize * 0.25,
                plot.bottom - offset - length - style.sizePx * 1.6,
                barSize * 1.5,
                style,
              ),
        );
      }
      if (stacked) offset += length;
    });
  });
  if (!horizontal) nodes.push(...categoryLabels(ctx, chartPart, categories, frame, plot));
  nodes.push(...axisLine(ctx, chartPart, frame, plot));
  return nodes;
}
