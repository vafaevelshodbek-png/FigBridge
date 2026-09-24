import { describe, expect, it } from "vitest";
import { FontLoader, fontCandidates } from "../src/main/render/fonts.js";
import {
  type Affine,
  hexToRgb,
  linearGradientTransform,
  needsMatrix,
  placementTransform,
} from "../src/main/render/geometry.js";
import { backoffDelay } from "../src/ui/connection.js";

function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

const box = { x: 100, y: 50, w: 200, h: 100, rotation: 0, flipX: false, flipY: false };

describe("placementTransform", () => {
  it("is a pure translation without rotation or flips", () => {
    expect(apply(placementTransform(box), 0, 0)).toEqual([100, 50]);
    expect(needsMatrix(box)).toBe(false);
  });

  it("rotates around the box centre, clockwise on screen", () => {
    const m = placementTransform({ ...box, rotation: 90 });
    const [cx, cy] = apply(m, 100, 50); // local centre
    expect(cx).toBeCloseTo(200);
    expect(cy).toBeCloseTo(100);
    const [x, y] = apply(m, 200, 0); // local top-right → below the centre after 90° cw
    expect(x).toBeCloseTo(250);
    expect(y).toBeCloseTo(200);
  });

  it("mirrors horizontally around the centre", () => {
    const m = placementTransform({ ...box, flipX: true });
    const [x, y] = apply(m, 0, 0); // local top-left lands on the top-right
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(50);
    expect(needsMatrix({ ...box, flipX: true })).toBe(true);
  });
});

describe("linearGradientTransform", () => {
  it("maps `from` to gradient position 0 and `to` to 1 on the centre line", () => {
    const m = linearGradientTransform([0.2, 0.1], [0.6, 0.9]);
    expect(apply(m, 0.2, 0.1)[0]).toBeCloseTo(0);
    expect(apply(m, 0.6, 0.9)[0]).toBeCloseTo(1);
    expect(apply(m, 0.2, 0.1)[1]).toBeCloseTo(0.5);
  });
});

describe("hexToRgb", () => {
  it("converts to 0..1 channels", () => {
    expect(hexToRgb("#FF8000")).toEqual({ r: 1, g: 128 / 255, b: 0 });
  });
});

describe("fontCandidates", () => {
  it("tries spelling variants, then the upright style, then Inter", () => {
    expect(fontCandidates({ family: "Alliance", style: "Semi Bold Italic" })).toEqual([
      { family: "Alliance", style: "Semi Bold Italic" },
      { family: "Alliance", style: "Semi Bold" },
      { family: "Inter", style: "Semi Bold Italic" },
      { family: "Inter", style: "Semi Bold" },
      { family: "Inter", style: "Regular" },
    ]);
    expect(fontCandidates({ family: "X", style: "Semi Bold" }).map((f) => f.style)).toContain(
      "SemiBold",
    );
  });
});

describe("FontLoader", () => {
  it("loads each font once and records substitutions", async () => {
    const attempts: string[] = [];
    const loader = new FontLoader((font) => {
      attempts.push(`${font.family}/${font.style}`);
      return font.family === "Inter" ? Promise.resolve() : Promise.reject(new Error("missing"));
    });
    const request = { family: "Brand", style: "Bold" };
    await expect(loader.resolve(request)).resolves.toEqual({ family: "Inter", style: "Bold" });
    await loader.resolve(request);
    expect(attempts.filter((a) => a === "Inter/Bold")).toHaveLength(1);
    expect(loader.substitutions.get("Brand Bold")).toBe("Inter Bold");
  });
});

describe("backoffDelay", () => {
  it("grows exponentially up to the cap with full jitter", () => {
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(10_000);
    expect(backoffDelay(5, () => 0)).toBe(0);
  });
});
