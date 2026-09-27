/**
 * Renders every corpus deck through the real SceneRenderer into a strict fake of the Figma
 * API (see fake-figma.ts). A deck that renders here with no warnings will not hit the API
 * errors we have seen in real Figma: oversized images, SVG arcs in vector paths, unloaded
 * fonts, out-of-range colours.
 *
 * Set FIGBRIDGE_CORPUS to a folder with pdf/ and pptx/ subfolders to run the larger local
 * corpus as well.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPdf } from "@figbridge/import-pdf";
import { importPptx } from "@figbridge/import-pptx";
import type { SceneNode, Slide } from "@figbridge/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { FontLoader } from "../src/main/render/fonts.js";
import { SceneRenderer } from "../src/main/render/scene-renderer.js";
import { type FakeFigma, type FakeNode, installFakeFigma } from "./fake-figma.js";

const REPO_CORPUS = fileURLToPath(new URL("../../../corpus/", import.meta.url));
const LOCAL_CORPUS = process.env["FIGBRIDGE_CORPUS"];

function corpusFiles(): string[] {
  const files = readdirSync(REPO_CORPUS)
    .filter((f) => /\.(pdf|pptx)$/i.test(f))
    .map((f) => join(REPO_CORPUS, f));
  if (LOCAL_CORPUS !== undefined && existsSync(LOCAL_CORPUS)) {
    for (const kind of ["pdf", "pptx"]) {
      const dir = join(LOCAL_CORPUS, kind);
      if (existsSync(dir)) files.push(...readdirSync(dir).map((f) => join(dir, f)));
    }
  }
  return files;
}

/** Leaves the renderer turns into Figma nodes (groups are structure, not output). */
function leafCount(nodes: readonly SceneNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.type === "group" ? leafCount(n.children) : 1), 0);
}

function leaves(node: FakeNode): FakeNode[] {
  return node.children.flatMap((c) => (c.type === "GROUP" ? leaves(c) : [c]));
}

async function render(
  fake: FakeFigma,
  slides: readonly Slide[],
  blobs: ReadonlyMap<string, { bytes: Uint8Array }>,
) {
  const warnings: string[] = [];
  const renderer = new SceneRenderer({
    fonts: new FontLoader((font) => fake.loadFontAsync(font)),
    images: (blob) => {
      const bytes = blobs.get(blob)?.bytes;
      if (bytes === undefined) return Promise.reject(new Error(`missing blob ${blob}`));
      return Promise.resolve(fake.createImage(bytes).hash);
    },
    checkCancelled: () => undefined,
    warnings,
  });
  const frames: FakeNode[] = [];
  for (const [i, slide] of slides.entries()) {
    frames.push(
      (await renderer.renderSlide(
        slide,
        fake.currentPage as never,
        0,
        i * 2000,
      )) as unknown as FakeNode,
    );
  }
  return { warnings, frames };
}

let fake: FakeFigma;
beforeEach(() => {
  fake = installFakeFigma();
});

describe.each(corpusFiles())("%s renders in Figma", (file) => {
  it("without API errors, one Figma node per scene leaf", async () => {
    const data = new Uint8Array(readFileSync(file));
    const name = file.split(/[\\/]/).pop() ?? file;
    const result = file.toLowerCase().endsWith(".pdf")
      ? await importPdf(data, name, { pages: [1, 2, 3] })
      : await importPptx(data, name);
    const { warnings, frames } = await render(fake, result.scene.slides, result.blobs);
    // Overflow depends on real font metrics; the fake's text layout is only an estimate.
    expect(warnings.filter((w) => !/ overflows: /.test(w))).toEqual([]);
    for (const [i, slide] of result.scene.slides.entries()) {
      const frame = frames[i];
      expect(frame).toBeDefined();
      if (frame !== undefined) expect(leaves(frame)).toHaveLength(leafCount(slide.children));
    }
  });
});

describe("the fake enforces Figma's limits", () => {
  const slide = (children: SceneNode[]): Slide => ({
    name: "s",
    width: 100,
    height: 100,
    background: [],
    children,
  });
  const base = {
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
  };

  function png(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  }

  it("turns an oversized image into a warning and keeps rendering", async () => {
    const blobs = new Map([
      ["big", { bytes: png(5000, 100) }],
      ["ok", { bytes: png(100, 100) }],
    ]);
    const image = (id: string, blob: string): SceneNode => ({
      ...base,
      id,
      name: id,
      type: "image",
      image: { type: "image", blob, scaleMode: "fill", opacity: 1 },
      radii: [0, 0, 0, 0],
      strokes: [],
    });
    const { warnings, frames } = await render(
      fake,
      [slide([image("a", "big"), image("b", "ok")])],
      blobs,
    );
    expect(warnings).toEqual([expect.stringContaining("Image is too large")]);
    expect(frames[0]?.children).toHaveLength(1);
  });

  it("rejects SVG arcs in vector paths", async () => {
    const vector: SceneNode = {
      ...base,
      id: "v",
      name: "v",
      type: "vector",
      paths: [{ d: "M 0 0 A 5 5 0 0 1 10 0 Z", fillRule: "nonzero" }],
      fills: [],
      strokes: [],
    };
    const { warnings } = await render(fake, [slide([vector])], new Map());
    expect(warnings).toEqual([expect.stringContaining("invalid path data")]);
  });

  it.each([
    ["unrotated", 0, false],
    ["rotated", 30, false],
    ["flipped", 0, true],
  ])("puts every vector vertex where the Scene says (%s)", async (_, rotation, flipX) => {
    // A slice-like path whose bounds do not start at the box origin (as pie sectors do).
    const d = "M 60 40 L 100 40 L 100 90 Z";
    const node: SceneNode = {
      ...base,
      x: 200,
      y: 100,
      w: 120,
      h: 100,
      rotation,
      flipX,
      id: "v",
      name: "v",
      type: "vector",
      paths: [{ d, fillRule: "nonzero" }],
      fills: [{ type: "solid", color: "#000000", opacity: 1 }],
      strokes: [],
    };
    const { frames } = await render(fake, [slide([node])], new Map());
    const vector = frames[0]?.children[0];
    expect(vector).toBeDefined();
    if (vector === undefined) return;
    // Scene: local (px, py) → parent via rotation/flip about the box centre.
    const scene = (px: number, py: number): [number, number] => {
      const r = (rotation * Math.PI) / 180;
      const lx = (flipX ? node.w - px : px) - node.w / 2;
      const ly = py - node.h / 2;
      return [
        node.x + node.w / 2 + lx * Math.cos(r) - ly * Math.sin(r),
        node.y + node.h / 2 + lx * Math.sin(r) + ly * Math.cos(r),
      ];
    };
    const expected = [scene(60, 40), scene(100, 40), scene(100, 90)];
    const figmaData = (vector.vectorPaths[0]?.data ?? "")
      .split(" ")
      .filter((t) => !/[A-Z]/.test(t))
      .map(Number);
    const actual = [0, 2, 4].map((i) =>
      vector.toParent(figmaData[i] ?? NaN, figmaData[i + 1] ?? NaN),
    );
    for (const [i, [x, y]] of actual.entries()) {
      expect(x).toBeCloseTo(expected[i]?.[0] ?? NaN, 2);
      expect(y).toBeCloseTo(expected[i]?.[1] ?? NaN, 2);
    }
  });

  it("a vector without an outline has no stroke (Figma adds one by default)", async () => {
    const vector: SceneNode = {
      ...base,
      id: "v",
      name: "v",
      type: "vector",
      paths: [{ d: "M 0 0 L 10 0 L 10 10 Z", fillRule: "nonzero" }],
      fills: [{ type: "solid", color: "#FAFAFA", opacity: 1 }],
      strokes: [],
    };
    const { frames } = await render(fake, [slide([vector])], new Map());
    expect(frames[0]?.children[0]?.strokes).toEqual([]);
  });

  it("requires fonts to be loaded before text is written", () => {
    const text = fake.createText();
    expect(() => {
      text.characters = "hi";
    }).toThrow(/unloaded font/);
  });
});

describe("text overflow after font substitution", () => {
  const textNode = (sizing: "fixed" | "height" | "width"): SceneNode => ({
    id: "t",
    name: "Headline",
    type: "text",
    x: 0,
    y: 0,
    w: 200,
    h: 30,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    characters: "Twenty letters here!",
    runs: [
      {
        start: 0,
        end: 20,
        fontFamily: "Inter",
        fontStyle: "Regular",
        fontSize: 20,
        fill: { type: "solid", color: "#000000", opacity: 1 },
        letterSpacing: 0,
        textCase: "original",
        decoration: "none",
      },
    ],
    paragraphs: [],
    align: "left",
    verticalAlign: "top",
    sizing,
  });
  const page = (node: SceneNode): Slide => ({
    name: "s",
    width: 400,
    height: 300,
    background: [],
    children: [node],
  });

  it("text that fits is not reported", async () => {
    // 20 characters × 0.5 × 20 px = 200 px: exactly one line in a 200 px box.
    const { warnings } = await render(fake, [page(textNode("fixed"))], new Map());
    expect(warnings).toEqual([]);
  });

  it.each(["fixed", "height", "width"] as const)(
    "a wider font overflowing a %s box is reported",
    async (sizing) => {
      fake.textAdvance = 0.75;
      const { warnings, frames } = await render(fake, [page(textNode(sizing))], new Map());
      expect(warnings).toEqual([expect.stringMatching(/^text "Headline" overflows/)]);
      expect(frames[0]?.children[0]?.getPluginData("figbridge.overflow")).not.toBe("");
      if (sizing === "fixed") expect(frames[0]?.children[0]?.height).toBe(30);
    },
  );
});
