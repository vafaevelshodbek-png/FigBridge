import { describe, expect, it } from "vitest";
import { arcToCubics, ellipseArcCubics, isFigmaPath, pathBounds } from "../src/path.js";

/** Points on each cubic at t = 0.5 must lie on the circle within 0.1 % of the radius. */
function maxRadialError(d: string, cx: number, cy: number, r: number, from: [number, number]) {
  let [x0, y0] = from;
  let worst = 0;
  for (const match of d.matchAll(/C ((?:-?[\d.]+ ?){6})/g)) {
    const [x1, y1, x2, y2, x3, y3] = (match[1] ?? "").trim().split(" ").map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (const t of [0.25, 0.5, 0.75]) {
      const u = 1 - t;
      const x = u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3;
      const y = u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3;
      worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - r) / r);
    }
    [x0, y0] = [x3, y3];
  }
  return worst;
}

describe("isFigmaPath", () => {
  it("accepts Figma's subset", () => {
    expect(isFigmaPath("M 0 0 L 10 0 Q 5 5 0 10 C 1 2 3 4 5 6 Z")).toBe(true);
    expect(isFigmaPath("M -1.5 2e-3 L .5 0 Z M 1 1 L 2 2")).toBe(true);
  });
  it.each([
    ["arcs", "M 0 0 A 5 5 0 0 1 10 0"],
    ["relative commands", "M 0 0 l 10 0"],
    ["H/V shorthands", "M 0 0 H 10"],
    ["commas", "M 0,0 L 10,0"],
    ["double spaces", "M 0 0  L 1 1"],
    ["implicit repeats", "M 0 0 L 1 1 2 2"],
    ["empty data", ""],
  ])("rejects %s", (_, d) => {
    expect(isFigmaPath(d)).toBe(false);
  });
});

describe("arc conversion", () => {
  it("approximates a quarter circle closely", () => {
    const d = arcToCubics(10, 0, 10, 10, 0, false, true, 0, 10);
    expect(isFigmaPath(`M 10 0 ${d}`)).toBe(true);
    expect(maxRadialError(d, 0, 0, 10, [10, 0])).toBeLessThan(0.001);
  });
  it("takes the large arc when asked", () => {
    const small = arcToCubics(10, 0, 10, 10, 0, false, true, 0, 10);
    const large = arcToCubics(10, 0, 10, 10, 0, true, false, 0, 10);
    expect(small.match(/C /g)).toHaveLength(1);
    expect(large.match(/C /g)).toHaveLength(3);
    expect(maxRadialError(large, 0, 0, 10, [10, 0])).toBeLessThan(0.001);
  });
  it("scales radii that cannot span the endpoints", () => {
    const d = arcToCubics(0, 0, 1, 1, 0, false, true, 20, 0);
    expect(d.endsWith(" 20 0")).toBe(true);
    expect(maxRadialError(d, 10, 0, 10, [0, 0])).toBeLessThan(0.001);
  });
  it("draws a full ellipse around its centre", () => {
    const d = ellipseArcCubics(0, 0, 10, 10, 0, 360);
    expect(d.match(/C /g)).toHaveLength(4);
    expect(d.endsWith(" 10 0")).toBe(true);
    expect(maxRadialError(d, 0, 0, 10, [10, 0])).toBeLessThan(0.001);
  });
});

describe("pathBounds", () => {
  it("bounds straight segments by their points", () => {
    expect(pathBounds("M 60 40 L 100 40 L 100 90 Z")).toEqual({
      minX: 60,
      minY: 40,
      maxX: 100,
      maxY: 90,
    });
  });
  it("bounds curves by their extent, not their control points", () => {
    // A quarter circle of radius 10 from (10, 0) to (0, 10): control points reach 10, the curve too.
    const d = `M 10 0 ${ellipseArcCubics(0, 0, 10, 10, 0, 90)}`;
    const b = pathBounds(d);
    expect(b?.maxX).toBeCloseTo(10, 1);
    expect(b?.maxY).toBeCloseTo(10, 1);
    // A bulging cubic: control points at y = 40, the curve peaks at y = 30.
    expect(pathBounds("M 0 0 C 0 40 10 40 10 0")?.maxY).toBeCloseTo(30, 5);
  });
  it("is undefined without points", () => {
    expect(pathBounds("Z")).toBeUndefined();
  });
});
