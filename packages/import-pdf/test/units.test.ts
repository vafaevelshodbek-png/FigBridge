import type { SceneNode } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { groupCards } from "../src/cards.js";
import { parseFontName } from "../src/fonts.js";
import { glyphText } from "../src/interpret.js";
import { multiply } from "../src/matrix.js";
import { type MeshIR, rasterizeMesh } from "../src/mesh.js";
import { asRoundedRect, decodePath, toSvgPath } from "../src/path.js";
import type { Glyph } from "../src/primitives.js";
import {
  buildLines,
  buildParagraphs,
  dedupeGlyphs,
  dropCovered,
  repairLigatures,
} from "../src/text.js";

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

describe("glyph text", () => {
  it("falls back to an ASCII character code when the font maps a glyph to U+FFFD", () => {
    expect(glyphText("\uFFFD", 46)).toBe(".");
    expect(glyphText("\uFFFD", 0x0416)).toBe("\uFFFD");
    expect(glyphText("a", 46)).toBe("a");
    expect(glyphText(undefined, undefined)).toBe("");
  });
});

describe("card grouping", () => {
  const rect = (id: string, x: number, y: number, w: number, h: number, color: string) => ({
    id,
    name: id,
    type: "rect" as const,
    x,
    y,
    w,
    h,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    fills: [{ type: "solid" as const, color, opacity: 1 }],
    strokes: [],
    radii: [0, 0, 0, 0] as [number, number, number, number],
  });
  const ids = (nodes: readonly SceneNode[]): string[] =>
    nodes.flatMap((n) => (n.type === "group" ? ids(n.children) : [n.id]));

  it("never lets a same-size panel painted over the card cover the card's content", () => {
    // Visa Investor Day p.17: light card, blue panel of the same size, white inset, icon.
    const nodes = [
      rect("card", 100, 100, 300, 500, "#C2EDFE"),
      rect("panel", 100, 100, 300, 500, "#1434CB"),
      rect("inset", 130, 130, 240, 300, "#FFFFFF"),
      rect("icon", 200, 200, 60, 60, "#1434CB"),
    ];
    let n = 0;
    const out = groupCards(nodes, 1920 * 1080, () => `g${String(++n)}`);
    expect(ids(out)).toEqual(["card", "panel", "inset", "icon"]);
  });

  it("still groups content inside a card", () => {
    const nodes = [
      rect("card", 100, 100, 300, 500, "#C2EDFE"),
      rect("dot", 150, 150, 10, 10, "#000000"),
    ];
    const out = groupCards(nodes, 1920 * 1080, () => "g");
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("group");
  });
});

describe("duplicate and hidden glyphs", () => {
  it("keeps the copy painted last and never merges a double letter", () => {
    const dark = { ...glyph("A", 100, 200), color: "#000000", op: 1 };
    const light = { ...glyph("A", 100.4, 200), color: "#FFFFFF", op: 9 };
    const l1 = { ...glyph("l", 200, 200, 20, 4.4), op: 3 };
    const l2 = { ...glyph("l", 204.4, 200, 20, 4.4), op: 3 };
    expect(dedupeGlyphs([dark, light, l1, l2])).toEqual([light, l1, l2]);
  });

  it("drops text a later opaque rectangle covers", () => {
    const hidden = { ...glyph("x", 110, 150), op: 1 };
    const onTop = { ...glyph("y", 110, 150), op: 5 };
    const panel = { op: 3, x0: 100, y0: 100, x1: 200, y1: 200 };
    expect(dropCovered([hidden, onTop], [panel])).toEqual([onTop]);
  });
});

describe("mesh shading", () => {
  it("fills triangles with colours interpolated between their vertices", () => {
    // Two triangles covering a 10 × 10 square: red on the left edge, blue on the right.
    const coords = [0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 10];
    const red = [255, 0, 0, 255];
    const blue = [0, 0, 255, 255];
    const colors = [...red, ...blue, ...red, ...blue, ...blue, ...red];
    const ir: MeshIR = ["Mesh", 4, coords, colors, 6, [0, 0, 10, 10], null, null];
    const bitmap = rasterizeMesh(ir, 1);
    expect(bitmap).toBeDefined();
    const pixels = bitmap?.canvas.getContext("2d").getImageData(0, 0, 10, 10).data;
    const at = (x: number, y: number) => [
      ...(pixels?.slice((y * 10 + x) * 4, (y * 10 + x) * 4 + 4) ?? []),
    ];
    expect(at(0, 5)[0]).toBeGreaterThan(200); // left edge red
    expect(at(9, 5)[2]).toBeGreaterThan(200); // right edge blue
    expect(at(5, 5)[3]).toBe(255); // no gaps between the triangles
  });

  it("returns nothing for an empty mesh", () => {
    expect(rasterizeMesh(["Mesh", 4, [], [], 0, null, null, null], 1)).toBeUndefined();
  });
});

describe("filled path data", () => {
  it("closes every subpath of a filled path, so Figma keeps all of them", () => {
    const segments = [
      { op: "M" as const, to: [0, 0] as [number, number] },
      { op: "L" as const, to: [10, 0] as [number, number] },
      { op: "L" as const, to: [10, 10] as [number, number] },
      { op: "M" as const, to: [20, 0] as [number, number] },
      { op: "L" as const, to: [30, 0] as [number, number] },
      { op: "L" as const, to: [30, 10] as [number, number] },
    ];
    expect(toSvgPath(segments, [0, 0], true)).toBe(
      "M 0 0 L 10 0 L 10 10 Z M 20 0 L 30 0 L 30 10 Z",
    );
    expect(toSvgPath(segments, [0, 0])).toBe("M 0 0 L 10 0 L 10 10 M 20 0 L 30 0 L 30 10");
  });
});
