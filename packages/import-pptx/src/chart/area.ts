/**
 * Area charts: one filled shape per series between its line and the one below it
 * (the axis, or the previous series when stacked). Points span the plot edge to edge,
 * as PowerPoint draws areas.
 */
import type { SceneNode } from "@figbridge/scene";
import type { SlideContext } from "../context.js";
import { attr, child, type XmlElement } from "../xml.js";
import type { ValueScale } from "./axis.js";
import type { Series } from "./series.js";
import { type Plot, polyline } from "./style.js";

export function areaNodes(
  ctx: SlideContext,
  area: XmlElement,
  series: Series[],
  categories: number,
  plot: Plot,
  scale: ValueScale,
): SceneNode[] {
  if (series.length === 0 || categories < 2) return [];
  const grouping = attr(child(area, "grouping"), "val") ?? "standard";
  const percent = grouping === "percentStacked";
  const stacked = percent || grouping === "stacked";
  const x = (ci: number) => plot.left + ((plot.right - plot.left) * ci) / (categories - 1);
  const y = (v: number) => plot.bottom - ((plot.bottom - plot.top) * v) / scale.max;
  const totals = Array.from({ length: categories }, (_, ci) =>
    series.reduce((sum, s) => sum + Math.max(0, s.values.get(ci) ?? 0), 0),
  );
  const below = Array.from({ length: categories }, () => 0);
  const nodes: SceneNode[] = [];
  for (const s of series) {
    const top: [number, number][] = [];
    const bottom: [number, number][] = [];
    for (let ci = 0; ci < categories; ci++) {
      const raw = Math.max(0, s.values.get(ci) ?? 0);
      const value = percent ? raw / (totals[ci] || 1) : raw;
      const base = stacked ? (below[ci] ?? 0) : 0;
      top.push([x(ci), y(base + value)]);
      bottom.push([x(ci), y(base)]);
      if (stacked) below[ci] = base + value;
    }
    const node = polyline(ctx, s.name || "series", [...top, ...bottom.reverse()], {
      closed: true,
      fills: [s.fill],
    });
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}
