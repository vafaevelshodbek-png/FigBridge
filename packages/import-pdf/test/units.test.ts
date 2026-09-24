import { describe, expect, it } from "vitest";
import { parseFontName } from "../src/fonts.js";
import type { Glyph } from "../src/interpret.js";
import { multiply } from "../src/matrix.js";
import { asRoundedRect, decodePath } from "../src/path.js";
import { buildLines, buildParagraphs, repairLigatures } from "../src/text.js";

const I = [1, 0, 0, 1, 0, 0] as const;

/** Rounded-rect path as drawing tools emit it: lines on edges, one cubic per corner. */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number): number[] {
  const k = 0.5523 * r;
  return [
    0,
    x + r,
    y,
    1,
    x + w - r,
    y,
    2,
    x + w - r + k,
    y,
    x + w,
    y + r - k,
    x + w,
    y + r,
    1,
    x + w,
    y + h - r,
    2,
    x + w,
    y + h - r + k,
    x + w - r + k,
    y + h,
    x + w - r,
    y + h,
    1,
    x + r,
    y + h,
    2,
    x + r - k,
    y + h,
    x,
    y + h - r + k,
    x,
    y + h - r,
    1,
    x,
    y + r,
    2,
    x,
    y + r - k,
    x + r - k,
    y,
    x + r,
    y,
    4,
  ];
}

describe("shape recognition", () => {
  it("detects rounded rectangles with their radius", () => {
    const shape = asRoundedRect(decodePath(roundedRectPath(10, 20, 300, 100, 12), I));
    expect(shape?.box).toEqual({ x0: 10, y0: 20, x1: 310, y1: 120 });
    for (const r of shape?.radii ?? []) expect(r).toBeCloseTo(12, 5);
  });

  it("detects plain rectangles and applies transforms", () => {
    const flipY = multiply([1, 0, 0, -1, 0, 100], I);
    const shape = asRoundedRect(decodePath([0, 0, 0, 1, 50, 0, 1, 50, 20, 1, 0, 20, 4], flipY));
    expect(shape).toEqual({ box: { x0: 0, y0: 80, x1: 50, y1: 100 }, radii: [0, 0, 0, 0] });
  });

  it("rejects rings (two subpaths) and diagonal shapes", () => {
    const ring = [...roundedRectPath(0, 0, 40, 40, 20), ...roundedRectPath(10, 10, 20, 20, 10)];
    expect(asRoundedRect(decodePath(ring, I))).toBeUndefined();
    expect(asRoundedRect(decodePath([0, 0, 0, 1, 10, 10, 1, 0, 10, 4], I))).toBeUndefined();
  });
});

describe("font names", () => {
  it.each([
    ["ABCDEF+AllianceNo.2-SemiBold", "AllianceNo.2", "Semi Bold"],
    ["Helvetica-BoldOblique", "Helvetica", "Bold Italic"],
    ["Roboto-Light", "Roboto", "Light"],
    ["Inter", "Inter", "Regular"],
    ["ArialMT", "Arial", "Regular"],
  ])("%s → %s %s", (pdf, family, style) => {
    expect(parseFontName(pdf)).toEqual({ family, style });
  });
});

function glyph(text: string, x: number, y: number, size = 20, advance = size * 0.5): Glyph {
  return {
    text,
    x,
    y,
    advance,
    nominal: advance,
    size,
    font: "F",
    color: "#000000",
    alpha: 1,
    upright: true,
  };
}

function word(text: string, x: number, y: number, size = 20): Glyph[] {
  return Array.from(text).map((ch, i) => glyph(ch, x + i * size * 0.5, y, size));
}

describe("text reconstruction", () => {
  it("synthesizes spaces between words positioned without space glyphs", () => {
    const lines = buildLines([...word("A", 0, 100), ...word("modern", 20, 100)]);
    expect(lines.map((l) => l.glyphs.map((g) => g.text).join(""))).toEqual(["A modern"]);
  });

  it("groups left-aligned lines with a regular step into one paragraph", () => {
    const lines = buildLines([
      ...word("one", 0, 100),
      ...word("two", 0, 124),
      ...word("three", 0, 148),
      ...word("far", 0, 400),
    ]);
    expect(buildParagraphs(lines).map((p) => p.length)).toEqual([3, 1]);
  });

  it("repairs unmapped ligature glyphs by width", () => {
    const glyphs = [...word("ti", 0, 100)];
    const control = glyph("\u001e", 40, 100, 20, 20); // width of "t" + "i"
    expect(
      repairLigatures([...glyphs, control])
        .map((g) => g.text)
        .join(""),
    ).toBe("titi");
  });
});
