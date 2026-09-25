import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type SceneNode, SceneSchema } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { niceMax } from "../src/chart.js";
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
    expect(niceMax(600)).toBe(700);
    expect(niceMax(945)).toBe(1000);
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

  it("reports unsupported objects instead of failing", async () => {
    const { warnings } = await importPptx(load("poi_SmartArt.pptx"), "smartart.pptx");
    expect(warnings.join(" ")).toMatch(/not supported/);
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
