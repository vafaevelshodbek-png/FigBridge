/**
 * PDF drawing features one at a time, on small documents built in memory (build-pdf.ts).
 * Page space is 400 × 300 pt imported at 1920 px wide, so 1 pt = 4.8 px.
 */
import { isFigmaPath, type SceneNode, SceneSchema } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { importPdf } from "../src/index.js";
import { buildPdf, type PageSpec, type PdfObject } from "./build-pdf.js";

const PX = 1920 / 400;

async function page(spec: PageSpec, extra: PdfObject[] = []) {
  const result = await importPdf(buildPdf([spec], extra), "test.pdf");
  SceneSchema.parse(result.scene);
  const slide = result.scene.slides[0];
  if (slide === undefined) throw new Error("no slide");
  const flatten = (nodes: readonly SceneNode[]): SceneNode[] =>
    nodes.flatMap((n) => (n.type === "group" ? flatten(n.children) : [n]));
  return { slide, nodes: flatten(slide.children), result };
}

describe("paths", () => {
  it("a full-page fill becomes the slide background", async () => {
    const { slide, nodes } = await page({
      content: "0.2 0.4 0.6 rg 0 0 400 300 re f 1 0 0 rg 10 10 50 50 re f",
    });
    expect(slide.background).toEqual([{ type: "solid", color: "#336699", opacity: 1 }]);
    expect(nodes).toHaveLength(1);
  });

  it("a full-page fill seen through a ring-shaped clip is content, not the background", async () => {
    const { slide, nodes } = await page({
      content: "q 50 50 200 200 re 100 100 100 100 re W* n 1 0 0 rg 0 0 400 300 re f Q",
    });
    expect(slide.background).toEqual([{ type: "solid", color: "#FFFFFF", opacity: 1 }]);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("rectangles keep their fill and opacity from the graphics state", async () => {
    const { nodes } = await page(
      { content: "/G1 gs 0 0.5 0 rg 50 50 100 100 re f", resources: "/ExtGState << /G1 4 0 R >>" },
      ["<< /Type /ExtGState /ca 0.4 >>"],
    );
    expect(nodes).toMatchObject([
      {
        type: "rect",
        x: 50 * PX,
        w: 100 * PX,
        fills: [{ type: "solid", color: "#008000", opacity: 0.4 }],
      },
    ]);
  });

  it("strokes carry width, dash and caps in pixels", async () => {
    const { nodes } = await page({ content: "0 0 1 RG 4 w [6 3] 0 d 1 J 50 50 m 350 250 l S" });
    const [line] = nodes;
    expect(line?.type).toBe("vector");
    if (line?.type === "vector") {
      expect(line.strokes[0]).toMatchObject({
        weight: 4 * PX,
        cap: "round",
        dash: [6 * PX, 3 * PX],
      });
      expect(isFigmaPath(line.paths[0]?.d ?? "")).toBe(true);
    }
  });

  it("curved outlines stay vectors — a hump is not a rounded card", async () => {
    const { nodes } = await page({
      content: "0 0 0 rg 50 50 m 50 150 150 150 150 50 c 200 50 250 100 v 300 150 350 100 y h f",
    });
    expect(nodes.map((n) => n.type)).toEqual(["vector"]);
  });

  it("a rectangle with rounded corners drawn as curves is a rounded rect", async () => {
    // Corners of radius 10, the top-right drawn with two curves as exporters often do.
    const k = 5.52;
    const content = [
      "0 0 1 rg 60 50 m 240 50 l",
      `${String(250 - k)} 50 250 ${String(60 - k)} 250 60 c`,
      "250 140 l",
      `250 ${String(145 - k / 2)} 248.5 147 247 148.5 c 245.5 150 ${String(242.5 + k / 2)} 150 240 150 c`,
      "60 150 l",
      `${String(50 + k)} 150 50 ${String(140 + k)} 50 140 c`,
      "50 60 l",
      `50 ${String(50 + k)} ${String(50 + k)} 50 60 50 c h f`,
    ].join(" ");
    const { nodes } = await page({ content });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("rect");
    if (nodes[0]?.type === "rect")
      for (const r of nodes[0].radii) expect(r).toBeCloseTo(10 * PX, 0);
  });
});

describe("gradients and effects", () => {
  it("an axial shading becomes an editable linear gradient", async () => {
    const { nodes } = await page(
      { content: "q 50 50 300 200 re W n /Sh1 sh Q", resources: "/Shading << /Sh1 4 0 R >>" },
      [
        "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 0 350 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>",
      ],
    );
    const [rect] = nodes;
    expect(rect?.type).toBe("rect");
    if (rect?.type === "rect") {
      const [fill] = rect.fills;
      expect(fill).toMatchObject({ type: "linear-gradient" });
      if (fill?.type === "linear-gradient") {
        expect(fill.stops[0]).toMatchObject({ position: 0, color: "#FF0000" });
        expect(fill.stops.at(-1)).toMatchObject({ position: 1, color: "#0000FF" });
        expect(fill.from[0]).toBeCloseTo(0, 2);
        expect(fill.to[0]).toBeCloseTo(1, 2);
      }
    }
  });

  it("a soft mask is composited into an image layer", async () => {
    const { nodes, result } = await page(
      { content: "/GS1 gs 0 0 1 rg 50 50 300 200 re f", resources: "/ExtGState << /GS1 4 0 R >>" },
      [
        "<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 5 0 R >> >>",
        {
          dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 400 300] /Group << /S /Transparency /CS /DeviceRGB >> >>",
          stream: "q 1 1 1 rg 50 50 150 200 re f Q",
        },
      ],
    );
    expect(nodes.map((n) => n.type)).toEqual(["image"]);
    const [image] = nodes;
    // The mask shows only the left half of the blue rectangle.
    if (image?.type === "image") {
      expect(image.w).toBeCloseTo(150 * PX, -1);
      expect(result.blobs.get(image.image.blob)?.mimeType).toBe("image/png");
    }
  });

  it("group opacity multiplies into its members", async () => {
    const { nodes } = await page(
      {
        content: "q /G1 gs /Fm1 Do Q",
        resources: "/XObject << /Fm1 4 0 R >> /ExtGState << /G1 5 0 R >>",
      },
      [
        {
          dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 400 300] /Group << /S /Transparency >> >>",
          stream: "1 0 0 rg 50 50 100 100 re f",
        },
        "<< /Type /ExtGState /ca 0.5 /CA 0.5 >>",
      ],
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const opacity = node.type === "rect" ? node.fills[0]?.opacity : node.opacity;
      expect(opacity).toBeCloseTo(0.5, 2);
    }
  });
});

describe("images", () => {
  it("RGB images keep their placement", async () => {
    const { nodes } = await page(
      { content: "q 200 0 0 100 50 50 cm /Im1 Do Q", resources: "/XObject << /Im1 4 0 R >>" },
      [
        {
          dict: "<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>",
          stream: new Uint8Array([255, 0, 0, 0, 0, 255]),
        },
      ],
    );
    expect(nodes).toMatchObject([{ type: "image", x: 50 * PX, w: 200 * PX, h: 100 * PX }]);
  });

  it("1-bit stencil masks are painted in the fill colour", async () => {
    const { nodes } = await page(
      {
        content: "q 1 0 0 rg 100 0 0 100 50 50 cm /Im1 Do Q",
        resources: "/XObject << /Im1 4 0 R >>",
      },
      [
        {
          dict: "<< /Type /XObject /Subtype /Image /Width 8 /Height 2 /ImageMask true /BitsPerComponent 1 >>",
          stream: new Uint8Array([0b10101010, 0b01010101]),
        },
      ],
    );
    expect(nodes.map((n) => n.type)).toEqual(["image"]);
  });
});

describe("text", () => {
  it("line operators build paragraphs of editable text", async () => {
    const { nodes } = await page({
      content: "BT /F1 18 Tf 22 TL 50 250 Td (First line) Tj T* (Second) Tj ET",
    });
    const texts = nodes.flatMap((n) => (n.type === "text" ? [n] : []));
    expect(texts.map((t) => t.characters)).toEqual(["First line\nSecond"]);
    expect(texts[0]?.runs[0]?.fontSize).toBeCloseTo(18 * PX, 1);
  });

  it("the ' and \" operators move to the next line", async () => {
    const { nodes } = await page({
      content: "BT /F1 12 Tf 16 TL 50 250 Td (One) Tj (Two) ' 1 0.5 (Three) \" ET",
    });
    const text = nodes.flatMap((n) => (n.type === "text" ? [n.characters] : [])).join("\n");
    expect(text.split("\n")).toEqual(["One", "Two", "Three"]);
  });
});
