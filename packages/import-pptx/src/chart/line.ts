/**
 * Line charts: one stroked vector per series through the category centres.
 */
import type { SceneNode } from "@figbridge/scene";
import { ptToPx, type SlideContext } from "../context.js";
import type { ValueScale } from "./axis.js";
import type { Series } from "./series.js";
import { DEFAULT_BAR, type Plot, polyline } from "./style.js";

export function lineNodes(
  ctx: SlideContext,
  series: Series[],
  categories: number,
  plot: Plot,
  scale: ValueScale,
): SceneNode[] {
  if (series.length === 0 || categories === 0) return [];
  const step = (plot.right - plot.left) / categories;
  const nodes: SceneNode[] = [];
  for (const s of series) {
    const points: [number, number][] = [];
    for (let ci = 0; ci < categories; ci++) {
      const value = s.values.get(ci);
      if (value !== undefined)
        points.push([
          plot.left + step * (ci + 0.5),
          plot.bottom - ((plot.bottom - plot.top) * value) / scale.max,
        ]);
    }
    const line = polyline(ctx, s.name || "series", points, {
      strokes: [
        {
          paint: s.fill.type === "image" ? DEFAULT_BAR : s.fill,
          weight: Math.max(1, ptToPx(ctx, 2.25)),
          align: "center",
          cap: "round",
          join: "round",
        },
      ],
    });
    if (line !== undefined) nodes.push(line);
  }
  return nodes;
}
