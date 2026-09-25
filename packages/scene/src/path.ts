/**
 * Vector path data in the subset Figma accepts: absolute `M x y`, `L x y`, `Q x0 y0 x y`,
 * `C x0 y0 x1 y1 x y` and `Z`, separated by single spaces. Arcs, relative commands and
 * H/V shorthands are rejected by `vectorPaths`, so importers convert them before emitting.
 */

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const COMMAND = `(?:[ML] ${NUMBER} ${NUMBER}|Q(?: ${NUMBER}){4}|C(?: ${NUMBER}){6}|Z)`;
const FIGMA_PATH = new RegExp(`^${COMMAND}(?: ${COMMAND})*$`);

/** True when `d` uses only the commands and spacing Figma's `vectorPaths` accepts. */
export function isFigmaPath(d: string): boolean {
  return FIGMA_PATH.test(d);
}

function fmt(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * An SVG elliptical arc (endpoint parameterisation, as in the `A` command) from (x1, y1) to
 * (x2, y2), as cubic Bézier commands — one per quarter turn at most, which keeps the radial
 * error below 0.03 % of the radius. Returns "" for a zero-length arc and a line for a
 * degenerate radius, matching the SVG spec (F.6.2).
 */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): string {
  if (x1 === x2 && y1 === y2) return "";
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return `L ${fmt(x2)} ${fmt(y2)}`;

  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // F.6.5.1: move to the ellipse's frame, centred between the endpoints.
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  // F.6.6: grow radii that are too small to span the endpoints.
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  // F.6.5.2: centre in the rotated frame.
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (factor * rx * yp) / ry;
  const cyp = (-factor * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  // F.6.5.5–6: start angle and sweep.
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const tangent = (t: number): [number, number] => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  const out: string[] = [];
  for (let i = 0; i < segments; i++) {
    const a = theta1 + i * step;
    const b = a + step;
    const [ax, ay] = point(a);
    const [bx, by] = i === segments - 1 ? [x2, y2] : point(b);
    const [tax, tay] = tangent(a);
    const [tbx, tby] = tangent(b);
    out.push(
      `C ${fmt(ax + k * tax)} ${fmt(ay + k * tay)} ${fmt(bx - k * tbx)} ${fmt(by - k * tby)} ${fmt(bx)} ${fmt(by)}`,
    );
  }
  return out.join(" ");
}

/**
 * Cubic Bézier commands for the arc of the axis-aligned ellipse centred at (cx, cy), from
 * `startDeg` sweeping `sweepDeg` (clockwise on screen when positive). Handles full turns,
 * which the endpoint form cannot express. The arc starts at the current point.
 */
export function ellipseArcCubics(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg: number,
  sweepDeg: number,
): string {
  if (sweepDeg === 0) return "";
  const start = (startDeg * Math.PI) / 180;
  const delta = (sweepDeg * Math.PI) / 180;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: string[] = [];
  for (let i = 0; i < segments; i++) {
    const a = start + i * step;
    const b = a + step;
    out.push(
      `C ${fmt(cx + rx * (Math.cos(a) - k * Math.sin(a)))} ${fmt(cy + ry * (Math.sin(a) + k * Math.cos(a)))} ` +
        `${fmt(cx + rx * (Math.cos(b) + k * Math.sin(b)))} ${fmt(cy + ry * (Math.sin(b) - k * Math.cos(b)))} ` +
        `${fmt(cx + rx * Math.cos(b))} ${fmt(cy + ry * Math.sin(b))}`,
    );
  }
  return out.join(" ");
}

export interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Parameters in (0, 1) where a Bézier's derivative along one axis is zero. */
function extrema(p0: number, p1: number, p2: number, p3?: number): number[] {
  if (p3 === undefined) {
    // Quadratic: B'(t) = 2[(p1 - p0) + t(p0 - 2p1 + p2)].
    const den = p0 - 2 * p1 + p2;
    return den === 0 ? [] : [(p0 - p1) / den];
  }
  // Cubic: B'(t) = 3[a t² + b t + c].
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) < 1e-12) return b === 0 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function bezier(t: number, p: readonly number[]): number {
  const u = 1 - t;
  return p.length === 3
    ? u * u * (p[0] ?? 0) + 2 * u * t * (p[1] ?? 0) + t * t * (p[2] ?? 0)
    : u ** 3 * (p[0] ?? 0) +
        3 * u * u * t * (p[1] ?? 0) +
        3 * u * t * t * (p[2] ?? 0) +
        t ** 3 * (p[3] ?? 0);
}

/**
 * Exact bounds of path data in Figma's subset — the box Figma normalises a vector to when
 * `vectorPaths` is set (curves count by their extent, not their control points).
 * Returns undefined for data without points.
 */
export function pathBounds(d: string): PathBounds | undefined {
  const tokens = d.split(" ");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  let cx = 0;
  let cy = 0;
  let start: [number, number] = [0, 0];
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    const read = (n: number) => {
      const values = tokens.slice(i, i + n).map(Number);
      i += n;
      return values;
    };
    if (command === "M" || command === "L") {
      const [x = 0, y = 0] = read(2);
      add(x, y);
      [cx, cy] = [x, y];
      if (command === "M") start = [x, y];
    } else if (command === "Q" || command === "C") {
      const values = read(command === "Q" ? 4 : 6);
      const xs = [cx, ...values.filter((_, k) => k % 2 === 0)];
      const ys = [cy, ...values.filter((_, k) => k % 2 === 1)];
      const ex = xs[xs.length - 1] ?? cx;
      const ey = ys[ys.length - 1] ?? cy;
      add(ex, ey);
      for (const [axis, other] of [
        [xs, ys],
        [ys, xs],
      ] as const) {
        for (const t of extrema(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0, axis[3])) {
          if (t > 0 && t < 1) {
            const a = bezier(t, axis);
            const b = bezier(t, other);
            if (axis === xs) add(a, b);
            else add(b, a);
          }
        }
      }
      [cx, cy] = [ex, ey];
    } else if (command === "Z") {
      [cx, cy] = start;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}
