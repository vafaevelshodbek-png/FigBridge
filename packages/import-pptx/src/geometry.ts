/**
 * Shape geometry → Scene primitives: preset shapes that map to Figma primitives (rectangles
 * with per-corner radii, ellipses), custom geometry and lines as vector paths in the shape's
 * local box (0..w, 0..h). Rotation and flips stay on the node, as in Figma.
 */
import { type CornerRadii, ellipseArcCubics } from "@figbridge/scene";
import { attr, child, childrenOf, num, type XmlElement } from "./xml.js";

const PERCENT = 100_000;
const DEGREE = 60_000;

export type Geometry =
  | { kind: "rect"; radii: CornerRadii }
  | { kind: "ellipse" }
  | {
      kind: "path";
      paths: { d: string; fillRule: "nonzero" | "evenodd"; filled: boolean; stroked: boolean }[];
    }
  | { kind: "unsupported"; preset: string };

/** `avLst` adjust values by name (`adj`, `adj1`, …). */
function adjustments(prstGeom: XmlElement | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const gd of childrenOf(child(prstGeom, "avLst"), "gd")) {
    const match = /^val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
    const name = attr(gd, "name");
    if (match?.[1] !== undefined && name !== undefined) out.set(name, Number(match[1]));
  }
  return out;
}

/** Presets that are straight lines across the box (connectors). */
export const LINE_PRESETS: ReadonlySet<string> = new Set([
  "line",
  "straightConnector1",
  "bentConnector2",
  "bentConnector3",
  "curvedConnector3",
]);

/** Geometry of a shape's `spPr`. Rect is the default when no geometry is given. */
export function geometryOf(spPr: XmlElement | undefined, w: number, h: number): Geometry {
  const cust = child(spPr, "custGeom");
  if (cust !== undefined) return customGeometry(cust, w, h);
  const prst = child(spPr, "prstGeom");
  const preset = attr(prst, "prst") ?? "rect";
  const adj = adjustments(prst);
  const short = Math.min(w, h);
  const r = (name: string, fallback: number) =>
    (short * Math.min(adj.get(name) ?? fallback, 50_000)) / PERCENT;
  switch (preset) {
    case "rect":
      return { kind: "rect", radii: [0, 0, 0, 0] };
    case "roundRect": {
      const radius = r("adj", 16_667);
      return { kind: "rect", radii: [radius, radius, radius, radius] };
    }
    case "round1Rect": {
      const radius = r("adj", 16_667);
      return { kind: "rect", radii: [0, radius, 0, 0] };
    }
    case "round2SameRect": {
      const top = r("adj1", 16_667);
      const bottom = r("adj2", 0);
      return { kind: "rect", radii: [top, top, bottom, bottom] };
    }
    case "round2DiagRect": {
      const a = r("adj1", 16_667);
      const b = r("adj2", 0);
      return { kind: "rect", radii: [a, b, a, b] };
    }
    case "ellipse":
      return { kind: "ellipse" };
    default:
      if (LINE_PRESETS.has(preset)) {
        return {
          kind: "path",
          paths: [
            { d: `M 0 0 L ${f(w)} ${f(h)}`, fillRule: "nonzero", filled: false, stroked: true },
          ],
        };
      }
      return presetPath(preset, w, h) ?? { kind: "unsupported", preset };
  }
}

/** A few common non-rectangular presets drawn as paths. */
function presetPath(preset: string, w: number, h: number): Geometry | undefined {
  const polygon = (points: [number, number][]): Geometry => ({
    kind: "path",
    paths: [
      {
        d: `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${f(x)} ${f(y)}`).join(" ")} Z`,
        fillRule: "nonzero",
        filled: true,
        stroked: true,
      },
    ],
  });
  switch (preset) {
    case "triangle":
      return polygon([
        [w / 2, 0],
        [w, h],
        [0, h],
      ]);
    case "rtTriangle":
      return polygon([
        [0, 0],
        [w, h],
        [0, h],
      ]);
    case "diamond":
      return polygon([
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ]);
    case "parallelogram":
      return polygon([
        [w * 0.25, 0],
        [w, 0],
        [w * 0.75, h],
        [0, h],
      ]);
    case "chevron":
      return polygon([
        [0, 0],
        [w * 0.75, 0],
        [w, h / 2],
        [w * 0.75, h],
        [0, h],
        [w * 0.25, h / 2],
      ]);
    case "homePlate":
      return polygon([
        [0, 0],
        [w * 0.8, 0],
        [w, h / 2],
        [w * 0.8, h],
        [0, h],
      ]);
    case "rightArrow":
      return polygon([
        [0, h * 0.25],
        [w * 0.6, h * 0.25],
        [w * 0.6, 0],
        [w, h / 2],
        [w * 0.6, h],
        [w * 0.6, h * 0.75],
        [0, h * 0.75],
      ]);
    case "leftArrow":
      return polygon([
        [w, h * 0.25],
        [w * 0.4, h * 0.25],
        [w * 0.4, 0],
        [0, h / 2],
        [w * 0.4, h],
        [w * 0.4, h * 0.75],
        [w, h * 0.75],
      ]);
    case "hexagon":
      return polygon([
        [w * 0.25, 0],
        [w * 0.75, 0],
        [w, h / 2],
        [w * 0.75, h],
        [w * 0.25, h],
        [0, h / 2],
      ]);
    case "pentagon":
      return polygon([
        [w / 2, 0],
        [w, h * 0.38],
        [w * 0.81, h],
        [w * 0.19, h],
        [0, h * 0.38],
      ]);
    default:
      return undefined;
  }
}

/** `custGeom` path list → SVG paths scaled from each path's coordinate space to the box. */
function customGeometry(cust: XmlElement, w: number, h: number): Geometry {
  const paths: Extract<Geometry, { kind: "path" }>["paths"] = [];
  for (const path of childrenOf(child(cust, "pathLst"), "path")) {
    const pw = num(path, "w", 0);
    const ph = num(path, "h", 0);
    const sx = pw > 0 ? w / pw : 1;
    const sy = ph > 0 ? h / ph : 1;
    const pt = (el: XmlElement | undefined): [number, number] => [
      num(el, "x", 0) * sx,
      num(el, "y", 0) * sy,
    ];
    const d: string[] = [];
    let current: [number, number] = [0, 0];
    for (const cmd of path.children) {
      const points = childrenOf(cmd, "pt");
      switch (cmd.name) {
        case "moveTo":
          current = pt(points[0]);
          d.push(`M ${f(current[0])} ${f(current[1])}`);
          break;
        case "lnTo":
          current = pt(points[0]);
          d.push(`L ${f(current[0])} ${f(current[1])}`);
          break;
        case "cubicBezTo": {
          const [c1, c2, to] = points.map(pt);
          if (c1 === undefined || c2 === undefined || to === undefined) break;
          d.push(`C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(to[0])} ${f(to[1])}`);
          current = to;
          break;
        }
        case "quadBezTo": {
          const [q, to] = points.map(pt);
          if (q === undefined || to === undefined) break;
          d.push(`Q ${f(q[0])} ${f(q[1])} ${f(to[0])} ${f(to[1])}`);
          current = to;
          break;
        }
        case "arcTo": {
          const [command, end] = arc(
            current,
            num(cmd, "wR", 0) * sx,
            num(cmd, "hR", 0) * sy,
            num(cmd, "stAng", 0) / DEGREE,
            num(cmd, "swAng", 0) / DEGREE,
          );
          d.push(command);
          current = end;
          break;
        }
        case "close":
          d.push("Z");
          break;
        default:
          break;
      }
    }
    if (d.length === 0) continue;
    paths.push({
      d: d.join(" "),
      fillRule: d.filter((c) => c.startsWith("M")).length > 1 ? "evenodd" : "nonzero",
      filled: attr(path, "fill") !== "none",
      stroked: attr(path, "stroke") !== "0" && attr(path, "stroke") !== "false",
    });
  }
  return { kind: "path", paths };
}

/**
 * DrawingML arcTo: an elliptical arc starting at the current point, which lies on the
 * ellipse at angle `start` (degrees, clockwise, parametric); sweeps `sweep` degrees.
 * Emitted as cubic Béziers — Figma's vector paths have no arc command.
 */
function arc(
  current: [number, number],
  wr: number,
  hr: number,
  start: number,
  sweep: number,
): [string, [number, number]] {
  const at = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [wr * Math.cos(a), hr * Math.sin(a)];
  };
  const [sx, sy] = at(start);
  const [ex, ey] = at(start + sweep);
  const cx = current[0] - sx;
  const cy = current[1] - sy;
  const end: [number, number] = [cx + ex, cy + ey];
  const command = ellipseArcCubics(cx, cy, wr, hr, start, sweep);
  return [command === "" ? `L ${f(end[0])} ${f(end[1])}` : command, end];
}

function f(n: number): string {
  return String(Math.round(n * 100) / 100);
}
