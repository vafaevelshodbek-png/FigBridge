/**
 * Line charts: one stroked vector per series through the category centres.
 */
import type { SceneNode } from "@figbridge/scene";
import { ptToPx, round, type SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import type { XmlElement } from "../xml.js";
import { axisLine, categoryLabels, niceMax } from "./layout.js";
import type { Series } from "./series.js";
import { DEFAULT_BAR, type Plot } from "./style.js";

/** Line charts: one stroked vector per series through the category centres. */
export function lineNodes(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  series: Series[],
  categories: string[],
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const max = Math.max(0, ...series.flatMap((s) => [...s.values.values()]));
  if (series.length === 0 || categories.length === 0 || max <= 0) return [];
  const top = niceMax(max);
  const step = (plot.right - plot.left) / categories.length;
  const nodes: SceneNode[] = [];
  for (const s of series) {
    const points: [number, number][] = [];
    categories.forEach((_, ci) => {
      const value = s.values.get(ci);
      if (value !== undefined)
        points.push([
          plot.left + step * (ci + 0.5),
          plot.bottom - ((plot.bottom - plot.top) * value) / top,
        ]);
    });
    if (points.length < 2) continue;
    const x0 = Math.min(...points.map((p) => p[0]));
    const y0 = Math.min(...points.map((p) => p[1]));
    const x1 = Math.max(...points.map((p) => p[0]));
    const y1 = Math.max(...points.map((p) => p[1]));
    const d = points
      .map(
        ([x, y], i) => `${i === 0 ? "M" : "L"} ${String(round(x - x0))} ${String(round(y - y0))}`,
      )
      .join(" ");
    nodes.push({
      id: ctx.nextId(),
      name: s.name || "series",
      type: "vector",
      x: round(x0),
      y: round(y0),
      w: round(Math.max(0.01, x1 - x0)),
      h: round(Math.max(0.01, y1 - y0)),
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      paths: [{ d, fillRule: "nonzero" }],
      fills: [],
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
  }
  nodes.push(...categoryLabels(ctx, chartPart, categories, frame, plot));
  nodes.push(...axisLine(ctx, chartPart, frame, plot));
  return nodes;
}
