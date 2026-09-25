import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isFigmaPath, type SceneNode, SceneSchema } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { niceScale, numberFormat } from "../src/chart/axis.js";
import { slicePath } from "../src/chart/pie.js";
import { applyTransforms, hexToRgb } from "../src/color.js";
import { parseFontStyle } from "../src/fonts.js";
import { geometryOf } from "../src/geometry.js";
import { importPptx } from "../src/index.js";
import { type GroupFrame, mapThroughGroup } from "../src/transform.js";

const CORPUS = fileURLToPath(new URL("../../../corpus/", import.meta.url));
const load = (name: string) => new Uint8Array(readFileSync(`${CORPUS}${name}`));
const flatten = (nodes: readonly SceneNode[]): SceneNode[] =>
  nodes.flatMap((n) => (n.type === "group" ? [n, ...flatten(n.children)] : [n]));
const el = (name: string, attrs: Record<string, string> = {}) => ({
  name,
  attrs,
  children: [],
  text: "",
});

describe("units", () => {
  it("applies lumMod/lumOff like PowerPoint", () => {
    // accent at 75 % luminance: lumMod 75000
    const out = applyTransforms(hexToRgb("FFFFFF"), 1, [el("lumMod", { val: "75000" })]);
    expect(out.color).toBe("#BFBFBF");
  });

  it("applies tint in linear light like PowerPoint", () => {
    const out = applyTransforms(hexToRgb("000000"), 1, [el("tint", { val: "20000" })]);
    expect(out.color).toBe("#E7E7E7");
  });

  it("accepts hex with or without #", () => {
    expect(hexToRgb("#FFFFFF")).toEqual(hexToRgb("FFFFFF"));
    expect(hexToRgb("FFFFFF")).toEqual([1, 1, 1]);
  });

  it("maps preset geometry to radii", () => {
    const spPr = {
      name: "spPr",
      attrs: {},
      text: "",
      children: [
        {
          name: "prstGeom",
          attrs: { prst: "roundRect" },
          text: "",
          children: [
            {
              name: "avLst",
              attrs: {},
              text: "",
              children: [el("gd", { name: "adj", fmla: "val 50000" })],
            },
          ],
        },
      ],
    };
    expect(geometryOf(spPr, 200, 40)).toEqual({ kind: "rect", radii: [20, 20, 20, 20] });
  });

  it("maps a child box through a scaled, flipped group", () => {
    const group: GroupFrame = {
      x: 100,
      y: 0,
      w: 200,
      h: 100,
      rot: 0,
      flipH: true,
      flipV: false,
      chX: 0,
      chY: 0,
      chW: 100,
      chH: 50,
    };
    const box = mapThroughGroup(
      { x: 0, y: 0, w: 10, h: 10, rot: 0, flipH: false, flipV: false },
      group,
    );
    expect(box).toMatchObject({ x: 280, y: 0, w: 20, h: 20, flipH: true });
  });

  it("parses typeface names with styles", () => {
    expect(parseFontStyle("Inter SemiBold", false, false)).toEqual({
      family: "Inter",
      style: "Semi Bold",
    });
    expect(parseFontStyle("Montserrat", true, true)).toEqual({
      family: "Montserrat",
      style: "Bold Italic",
    });
  });

  it("chooses round axis maxima", () => {
    expect(niceScale(600).max).toBe(700);
    expect(niceScale(945).max).toBe(1000);
  });
});

describe("importPptx", () => {
  it("never crashes and always yields a valid scene on the corpus", async () => {
    const files = readdirSync(CORPUS).filter((f) => f.endsWith(".pptx"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { scene } = await importPptx(load(file), file);
      expect(() => SceneSchema.parse(scene), file).not.toThrow();
    }
  });

  it("imports shapes as editable primitives with text", async () => {
    const { scene } = await importPptx(load("poi_shapes.pptx"), "shapes.pptx");
    const nodes = scene.slides.flatMap((s) => flatten(s.children));
    expect(nodes.some((n) => n.type === "rect")).toBe(true);
    expect(nodes.some((n) => n.type === "text")).toBe(true);
  });

  it("imports tables cell by cell", async () => {
    const { scene } = await importPptx(load("pypptx_tbl-cell.pptx"), "tbl.pptx");
    const names = scene.slides.flatMap((s) => flatten(s.children)).map((n) => n.name);
    expect(names).toContain("r1c1");
  });

  it("imports SmartArt from its stored drawing", async () => {
    const { scene, warnings } = await importPptx(load("poi_SmartArt.pptx"), "smartart.pptx");
    expect(warnings).toEqual([]);
    const shapes = JSON.stringify(scene).match(/"type":"rect"/g) ?? [];
    expect(shapes.length).toBeGreaterThanOrEqual(5);
  });

  it("is deterministic and rejects missing slides", async () => {
    const a = await importPptx(load("poi_shapes.pptx"), "s.pptx");
    const b = await importPptx(load("poi_shapes.pptx"), "s.pptx");
    expect(JSON.stringify(a.scene)).toBe(JSON.stringify(b.scene));
    await expect(importPptx(load("poi_shapes.pptx"), "s.pptx", { pages: [999] })).rejects.toThrow(
      RangeError,
    );
  });

  it("rejects files that are not presentations", async () => {
    await expect(importPptx(new Uint8Array([1, 2, 3]), "x.pptx")).rejects.toThrow(TypeError);
  });
});

describe("pie slices", () => {
  it("draws a quarter slice from 12 o'clock clockwise, in Figma's path subset", () => {
    const d = slicePath(10, 0, -90, 90);
    expect(isFigmaPath(d)).toBe(true);
    expect(d.startsWith("M 10 10 L 10 0 C ")).toBe(true);
    expect(d.endsWith(" 20 10 Z")).toBe(true);
  });
  it("splits sweeps past a quarter turn into several curves", () => {
    expect(slicePath(10, 0, -90, 270).match(/C /g)).toHaveLength(3);
  });
  it("cuts the doughnut hole back along the inner radius", () => {
    const d = slicePath(10, 5, -90, 90);
    expect(isFigmaPath(d)).toBe(true);
    expect(d).toContain(" L 15 10 C ");
    expect(d.endsWith(" 10 5 Z")).toBe(true);
  });
  it("draws a full doughnut as two opposite rings", () => {
    const d = slicePath(10, 5, -90, 360);
    expect(isFigmaPath(d)).toBe(true);
    expect(d.match(/M /g)).toHaveLength(2);
  });
});

describe("value axis scale and format", () => {
  it("steps like PowerPoint: 1-2-5, at most 10 intervals, 5 % headroom", () => {
    expect(niceScale(8.2)).toEqual({ max: 9, step: 1 });
    expect(niceScale(600)).toEqual({ max: 700, step: 100 });
    expect(niceScale(0.37)).toEqual({ max: 0.4, step: 0.05 });
  });
  it.each([
    [undefined, false, 1234.5, "1234.5"],
    ["General", true, 0.25, "25%"],
    ["0%", false, 0.125, "13%"],
    ["0.0%", false, 0.125, "12.5%"],
    ["#,##0", false, 1234567, "1,234,567"],
    ["0.00", false, 3, "3.00"],
  ] as const)("format %s", (code, percent, value, text) => {
    expect(numberFormat(code, percent)(value)).toBe(text);
  });
});
