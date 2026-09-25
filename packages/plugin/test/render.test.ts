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
    expect(warnings).toEqual([]);
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

  it("requires fonts to be loaded before text is written", () => {
    const text = fake.createText();
    expect(() => {
      text.characters = "hi";
    }).toThrow(/unloaded font/);
  });
});
