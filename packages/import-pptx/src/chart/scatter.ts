/**
 * Scatter charts: markers at (x, y) on two value axes, joined by a line when the chart's
 * style has lines (`lineMarker`, `line`, `smooth…`), in data order as PowerPoint joins them.
 */
import type { SceneNode } from "@figbridge/scene";
import { ptToPx, round, type SlideContext } from "../context.js";
import { attr, child, type XmlElement } from "../xml.js";
import type { ValueScale } from "./axis.js";
import type { Series } from "./series.js";
import { DEFAULT_BAR, type Plot, polyline } from "./style.js";

/** Marker diameter in points (PowerPoint's automatic size is 5–7 pt). */
const MARKER_PT = 5;

export function scatterNodes(
  ctx: SlideContext,
  scatter: XmlElement,
  series: Series[],
  plot: Plot,
  xScale: ValueScale,
  yScale: ValueScale,
): SceneNode[] {
  const style = attr(child(scatter, "scatterStyle"), "val") ?? "marker";
  const lines = style !== "marker" && style !== "none";
  const size = ptToPx(ctx, MARKER_PT);
  const nodes: SceneNode[] = [];
  for (const s of series) {
    const points: [number, number][] = [];
    for (const [idx, yv] of s.values) {
      const xv = s.xValues?.get(idx) ?? idx + 1;
      points.push([
        plot.left + ((plot.right - plot.left) * xv) / xScale.max,
        plot.bottom - ((plot.bottom - plot.top) * yv) / yScale.max,
      ]);
    }
    const paint = s.fill.type === "image" ? DEFAULT_BAR : s.fill;
    if (lines) {
      const line = polyline(ctx, s.name || "series", points, {
        strokes: [
          {
            paint,
            weight: Math.max(1, ptToPx(ctx, 2.25)),
            align: "center",
            cap: "round",
            join: "round",
          },
        ],
      });
      if (line !== undefined) nodes.push(line);
    }
    for (const [x, y] of points) {
      nodes.push({
        id: ctx.nextId(),
        name: `${s.name || "point"} marker`,
        type: "ellipse",
        x: round(x - size / 2),
        y: round(y - size / 2),
        w: round(size),
        h: round(size),
        rotation: 0,
        flipX: false,
        flipY: false,
        opacity: 1,
        visible: true,
        fills: [paint],
        strokes: [],
      });
    }
  }
  return nodes;
}
