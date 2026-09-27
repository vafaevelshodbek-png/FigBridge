/**
 * Device-space paths and the shape analysis that turns them into editable primitives.
 * Device space = slide pixels, y down.
 */
import { apply, type Matrix } from "./matrix.js";

export type Point = readonly [number, number];

export type Segment =
  | { op: "M"; to: Point }
  | { op: "L"; to: Point }
  | { op: "C"; c1: Point; c2: Point; to: Point }
  | { op: "Z" };

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** pdf.js DrawOPS codes inside `constructPath` data. */
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

/** Decode pdf.js path data (user space) into device-space segments. */
export function decodePath(data: ArrayLike<number>, ctm: Matrix): Segment[] {
  const segments: Segment[] = [];
  let current: Point = [0, 0];
  let i = 0;
  const point = (): Point => {
    const p = apply(ctm, data[i] ?? 0, data[i + 1] ?? 0);
    i += 2;
    return p;
  };
  while (i < data.length) {
    const code = data[i++] ?? -1;
    switch (code) {
      case DRAW.moveTo:
        current = point();
        segments.push({ op: "M", to: current });
        break;
      case DRAW.lineTo:
        current = point();
        segments.push({ op: "L", to: current });
        break;
      case DRAW.curveTo: {
        const c1 = point();
        const c2 = point();
        current = point();
        segments.push({ op: "C", c1, c2, to: current });
        break;
      }
      case DRAW.quadraticCurveTo: {
        // Elevate to cubic: c1 = p0 + 2/3(q - p0), c2 = p + 2/3(q - p).
        const q = point();
        const to = point();
        const c1: Point = [
          current[0] + (2 / 3) * (q[0] - current[0]),
          current[1] + (2 / 3) * (q[1] - current[1]),
        ];
        const c2: Point = [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])];
        current = to;
        segments.push({ op: "C", c1, c2, to });
        break;
      }
      case DRAW.closePath:
        segments.push({ op: "Z" });
        break;
      default:
        return segments; // unknown code: stop rather than misread coordinates
    }
  }
  return segments;
}

export function bounds(segments: readonly Segment[]): Box | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = ([x, y]: Point) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const s of segments) {
    if (s.op === "Z") continue;
    add(s.to);
    // Control points bound the curve (convex hull property): a safe, slightly loose box.
    if (s.op === "C") {
      add(s.c1);
      add(s.c2);
    }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : undefined;
}

export function subpathCount(segments: readonly Segment[]): number {
  return segments.filter((s) => s.op === "M").length;
}

/** Tolerance for "on the box edge" / "axis-aligned" checks, in pixels. */
const EDGE_EPSILON = 0.75;

/**
 * If the path is a rectangle, possibly with rounded corners, return its box and per-corner
 * radii [tl, tr, br, bl]; otherwise undefined.
 *
 * Accepts one subpath made of axis-aligned lines lying on the bounding box edges and cubic
 * arcs at the corners. Rings, arrows and irregular shapes are rejected (they stay vectors).
 */
export function asRoundedRect(
  segments: readonly Segment[],
): { box: Box; radii: [number, number, number, number] } | undefined {
  if (subpathCount(segments) !== 1) return undefined;
  const box = bounds(segments);
  if (box === undefined) return undefined;
  const onEdge = ([x, y]: Point) =>
    Math.min(
      Math.abs(x - box.x0),
      Math.abs(x - box.x1),
      Math.abs(y - box.y0),
      Math.abs(y - box.y1),
    ) < EDGE_EPSILON;

  const radii: [number, number, number, number] = [0, 0, 0, 0];
  const corners: Point[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  const near = (a: number, b: number) => Math.abs(a - b) < EDGE_EPSILON;
  const axisAligned = (a: Point, b: Point) => near(a[0], b[0]) || near(a[1], b[1]);
  let previous: Point | undefined;
  let start: Point | undefined;
  // A corner may be drawn with several curves; collect them until one lands on an edge.
  let arc: { from: Point; points: Point[] } | undefined;
  for (const s of segments) {
    if (arc !== undefined && s.op !== "C") return undefined;
    if (s.op === "M") {
      if (!onEdge(s.to)) return undefined;
      previous = s.to;
      start = s.to;
    } else if (s.op === "L") {
      if (previous === undefined || !onEdge(s.to) || !axisAligned(previous, s.to)) return undefined;
      previous = s.to;
    } else if (s.op === "C") {
      if (previous === undefined) return undefined;
      arc ??= { from: previous, points: [] };
      arc.points.push(s.c1, s.c2, s.to);
      previous = s.to;
      if (!onEdge(s.to)) continue;
      const corner = cornerOf(arc.from, s.to, arc.points, corners, near);
      if (corner === undefined) return undefined;
      const radius = Math.max(Math.abs(s.to[0] - arc.from[0]), Math.abs(s.to[1] - arc.from[1]));
      radii[corner] = Math.max(radii[corner] ?? 0, radius);
      arc = undefined;
    } else if (previous !== undefined && start !== undefined) {
      // Z draws a straight line back to the start: it must be an edge too.
      if (!axisAligned(previous, start)) return undefined;
      previous = start;
    }
  }
  if (arc !== undefined) return undefined;
  const limit = Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2;
  return { box, radii: radii.map((r) => Math.min(r, limit)) as [number, number, number, number] };
}

/**
 * Index of the rectangle corner that curves from `from` to `to` round: they must lie on the
 * corner's two edges, and every point in between (control points included) inside the
 * corner square they span. Undefined when the curves are not a corner.
 */
function cornerOf(
  from: Point,
  to: Point,
  points: readonly Point[],
  corners: readonly Point[],
  near: (a: number, b: number) => boolean,
): number | undefined {
  const x0 = Math.min(from[0], to[0]) - 0.5;
  const x1 = Math.max(from[0], to[0]) + 0.5;
  const y0 = Math.min(from[1], to[1]) - 0.5;
  const y1 = Math.max(from[1], to[1]) + 0.5;
  if (!points.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return undefined;
  const index = corners.findIndex(([cx, cy]) => {
    const vertical = (p: Point) => near(p[0], cx);
    const horizontal = (p: Point) => near(p[1], cy);
    return (vertical(from) && horizontal(to)) || (horizontal(from) && vertical(to));
  });
  return index < 0 ? undefined : index;
}

/** SVG path data relative to `origin`, in the format Figma's vectorPaths accept. */
export function toSvgPath(segments: readonly Segment[], origin: Point, close = false): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const p = ([x, y]: Point) => `${f(x - origin[0])} ${f(y - origin[1])}`;
  const out: string[] = [];
  // A PDF fill closes every subpath implicitly; Figma keeps only the last open subpath of a
  // vector (a filled logo came out as its last letter), so filled paths close them explicitly.
  const closeOpen = () => {
    const last = out[out.length - 1];
    if (close && last !== undefined && last !== "Z" && !last.startsWith("M ")) out.push("Z");
  };
  for (const s of segments) {
    if (s.op === "M") {
      closeOpen();
      out.push(`M ${p(s.to)}`);
    } else if (s.op === "L") out.push(`L ${p(s.to)}`);
    else if (s.op === "C") out.push(`C ${p(s.c1)} ${p(s.c2)} ${p(s.to)}`);
    else out.push("Z");
  }
  closeOpen();
  return out.join(" ");
}
