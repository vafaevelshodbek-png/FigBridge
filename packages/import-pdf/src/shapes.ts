/**
 * Vector primitives → editable Scene nodes: rectangles (with per-corner radii) where the
 * geometry allows, vectors otherwise. Small same-style shapes painted back to back (letters
 * of a logo, parts of an icon) are merged into one vector so they move together.
 */
import type { Paint, RectNode, Stroke, VectorNode } from "@figbridge/scene";
import type { ClipPath, PathPrimitive } from "./interpret.js";
import { asRoundedRect, type Box, bounds, subpathCount, toSvgPath } from "./path.js";

/** Shapes smaller than this (px, both sides) are candidates for merging into one vector. */
const MERGE_MAX_SIZE = { w: 320, h: 150 } as const;
/** Merge when boxes are within this many px of each other. */
const MERGE_GAP = 10;
/** A primitive hidden by clips except for this fraction of its area is dropped. */
const MIN_VISIBLE_FRACTION = 0.05;

export function intersect(a: Box, b: Box): Box | undefined {
  const box = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return box.x0 < box.x1 && box.y0 < box.y1 ? box : undefined;
}

export function area(box: Box): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

/** Bounding box of the region all clips allow (rectangular approximation). */
export function clipBox(clips: readonly ClipPath[]): Box | undefined {
  let box: Box | undefined = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  for (const clip of clips) {
    const b = bounds(clip.segments);
    if (b === undefined) return undefined;
    box = box === undefined ? undefined : intersect(box, b);
  }
  return box;
}

/** Visible part of a primitive's box, or undefined when clips hide (almost) all of it. */
export function visibleBox(box: Box, clips: readonly ClipPath[]): Box | undefined {
  const allowed = clipBox(clips);
  if (allowed === undefined) return undefined;
  const thin = box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1;
  // Hairlines have ~zero area: test them against a slightly grown clip box.
  if (thin)
    return intersect(
      { x0: box.x0 - 1, y0: box.y0 - 1, x1: box.x1 + 1, y1: box.y1 + 1 },
      allowed,
    ) === undefined
      ? undefined
      : box;
  const visible = intersect(box, allowed);
  if (visible === undefined || area(visible) < MIN_VISIBLE_FRACTION * area(box)) return undefined;
  return visible;
}

function solid(color: string, alpha: number): Paint {
  return { type: "solid", color: color.toUpperCase(), opacity: alpha };
}

function strokeOf(p: PathPrimitive): Stroke[] {
  if (p.stroke === undefined || p.stroke.width <= 0) return [];
  const caps = ["none", "round", "square"] as const;
  const joins = ["miter", "round", "bevel"] as const;
  return [
    {
      paint: solid(p.stroke.color, p.stroke.alpha),
      weight: p.stroke.width,
      align: "center",
      ...(p.stroke.dash.some((d) => d > 0) ? { dash: p.stroke.dash } : {}),
      cap: caps[p.stroke.cap] ?? "none",
      join: joins[p.stroke.join] ?? "miter",
    },
  ];
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A single path primitive as a rectangle when possible. */
export function toRect(p: PathPrimitive, id: string, visible: Box): RectNode | undefined {
  const shape = asRoundedRect(p.segments);
  if (shape === undefined) return undefined;
  // A rectangle partly outside its clip is cropped to the visible part (e.g. a bar clipped
  // by its chart area); rounded shapes keep their geometry so the radii stay right.
  const clipped = shape.radii.every((r) => r === 0) ? visible : shape.box;
  return {
    id,
    name: shape.radii.some((r) => r > 0) ? "card" : "rectangle",
    type: "rect",
    x: round(clipped.x0),
    y: round(clipped.y0),
    w: round(clipped.x1 - clipped.x0),
    h: round(clipped.y1 - clipped.y0),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    fills: p.fill === undefined ? [] : [solid(p.fill.color, p.fill.alpha)],
    strokes: strokeOf(p),
    radii: shape.radii.map(round) as [number, number, number, number],
  };
}

/** One or more path primitives (same style) as a vector node. */
export function toVector(parts: readonly PathPrimitive[], id: string): VectorNode | undefined {
  const [first] = parts;
  if (first === undefined) return undefined;
  const all = parts.flatMap((p) => p.segments);
  const box = bounds(all);
  if (box === undefined) return undefined;
  const origin = [box.x0, box.y0] as const;
  const isLine = parts.length === 1 && first.fill === undefined && first.segments.length === 2;
  return {
    id,
    name: parts.length > 1 ? "logo / icon" : isLine ? "line" : "vector",
    type: "vector",
    x: round(box.x0),
    y: round(box.y0),
    w: round(box.x1 - box.x0),
    h: round(box.y1 - box.y0),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    paths: parts.map((p) => ({
      d: toSvgPath(p.segments, origin),
      fillRule: p.fill?.evenOdd === true || subpathCount(p.segments) > 1 ? "evenodd" : "nonzero",
    })),
    fills: first.fill === undefined ? [] : [solid(first.fill.color, first.fill.alpha)],
    strokes: strokeOf(first),
  };
}

function styleKey(p: PathPrimitive): string {
  return JSON.stringify([
    p.fill?.color,
    p.fill?.alpha,
    p.stroke?.color,
    p.stroke?.width,
    p.stroke?.dash,
  ]);
}

function near(a: Box, b: Box): boolean {
  return !(
    b.x0 > a.x1 + MERGE_GAP ||
    a.x0 > b.x1 + MERGE_GAP ||
    b.y0 > a.y1 + MERGE_GAP ||
    a.y0 > b.y1 + MERGE_GAP
  );
}

function small(box: Box): boolean {
  return box.x1 - box.x0 < MERGE_MAX_SIZE.w && box.y1 - box.y0 < MERGE_MAX_SIZE.h;
}

/**
 * Split consecutive path primitives into runs that should become one vector each:
 * small, same style, touching, painted back to back.
 */
export function mergeRuns(paths: readonly PathPrimitive[]): PathPrimitive[][] {
  const runs: PathPrimitive[][] = [];
  for (const p of paths) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    // A plain small rectangle joins a run only next to non-rect shapes of the same style:
    // the stem of an "l" in a logo, not a standalone swatch.
    const isRect = asRoundedRect(p.segments) !== undefined;
    const runHasShapes = run?.some((q) => asRoundedRect(q.segments) === undefined) === true;
    const mergeable =
      run !== undefined &&
      last !== undefined &&
      (!isRect || runHasShapes) &&
      small(p.box) &&
      small(last.box) &&
      styleKey(p) === styleKey(last) &&
      near(last.box, p.box);
    if (mergeable) run.push(p);
    else runs.push([p]);
  }
  return runs;
}
