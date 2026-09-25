/**
 * Pie and doughnut charts: one vector per slice, clockwise from 12 o'clock.
 */
import { ellipseArcCubics, type SceneNode } from "@figbridge/scene";
import { round, type SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import { attr, child, num, type XmlElement } from "../xml.js";
import type { Series } from "./series.js";
import { accent } from "./style.js";

export const PIE_CHARTS: ReadonlySet<string> = new Set(["pieChart", "pie3DChart", "doughnutChart"]);

/** Pie and doughnut charts: one vector per slice, clockwise from 12 o'clock. */
export function pieNodes(
  ctx: SlideContext,
  pie: XmlElement,
  series: Series[],
  frame: Box,
): SceneNode[] {
  const s = series[0];
  if (s === undefined) return [];
  const entries = [...s.values.entries()].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total <= 0) return [];
  const hole = pie.name === "doughnutChart" ? num(child(pie, "holeSize"), "val", 50) / 100 : 0;
  const size = Math.min(frame.w, frame.h) * 0.8;
  const r = size / 2;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const varyColors = attr(child(pie, "varyColors"), "val") !== "0";
  let angle = num(child(pie, "firstSliceAng"), "val", 0) - 90;
  return entries.map(([idx, value], i) => {
    const sweep = (value / total) * 360;
    const d = slicePath(r, r * hole, angle, sweep);
    angle += sweep;
    return {
      id: ctx.nextId(),
      name: `${s.name || "slice"} · ${String(idx + 1)}`,
      type: "vector",
      x: round(cx - r),
      y: round(cy - r),
      w: round(size),
      h: round(size),
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      paths: [{ d, fillRule: "evenodd" }],
      fills: [s.pointFills.get(idx) ?? (varyColors ? accent(ctx, i) : s.fill)],
      strokes: [],
    };
  });
}

/** Pie/doughnut slice in its local box (0..2r); angles in degrees, clockwise from +x. */
export function slicePath(r: number, inner: number, start: number, sweep: number): string {
  const p = (radius: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${String(round(r + radius * Math.cos(a)))} ${String(round(r + radius * Math.sin(a)))}`;
  };
  const arc = (radius: number, from: number, by: number) =>
    ellipseArcCubics(r, r, radius, radius, from, by);
  if (sweep >= 359.999) {
    const ring = `M ${p(r, 0)} ${arc(r, 0, 360)} Z`;
    return inner > 0 ? `${ring} M ${p(inner, 0)} ${arc(inner, 0, -360)} Z` : ring;
  }
  const end = start + sweep;
  if (inner <= 0)
    return `M ${String(round(r))} ${String(round(r))} L ${p(r, start)} ${arc(r, start, sweep)} Z`;
  return `M ${p(r, start)} ${arc(r, start, sweep)} L ${p(inner, end)} ${arc(inner, end, -sweep)} Z`;
}
