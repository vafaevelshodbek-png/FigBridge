import { describe, expect, it } from "vitest";
import { SceneNodeSchema, SceneSchema, SlideSchema } from "../src/index.js";

const rect = { id: "r1", name: "card", type: "rect", x: 10, y: 20, w: 300, h: 200 } as const;

describe("scene nodes", () => {
  it("fills defaults so renderers never see undefined geometry flags", () => {
    const node = SceneNodeSchema.parse(rect);
    expect(node).toMatchObject({
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      fills: [],
      radii: [0, 0, 0, 0],
    });
  });

  it("supports recursive groups with inferred types", () => {
    const group = SceneNodeSchema.parse({
      id: "g",
      name: "card",
      type: "group",
      children: [rect, { ...rect, id: "r2" }],
    });
    expect(group.type === "group" && group.children).toHaveLength(2);
  });

  it("rejects empty groups, bad colours and out-of-range opacity", () => {
    expect(
      SceneNodeSchema.safeParse({ id: "g", name: "", type: "group", children: [] }).success,
    ).toBe(false);
    expect(
      SceneNodeSchema.safeParse({ ...rect, fills: [{ type: "solid", color: "red" }] }).success,
    ).toBe(false);
    expect(SceneNodeSchema.safeParse({ ...rect, opacity: 1.5 }).success).toBe(false);
  });

  it("requires blob references, not inline image data", () => {
    const image = { id: "i", name: "photo", type: "image", x: 0, y: 0, w: 10, h: 10 };
    expect(
      SceneNodeSchema.safeParse({ ...image, image: { type: "image", blob: "img:abcdefgh" } })
        .success,
    ).toBe(true);
    expect(
      SceneNodeSchema.safeParse({
        ...image,
        image: { type: "image", blob: "data:image/png;base64,AAAA" },
      }).success,
    ).toBe(false);
  });

  it("describes text with runs and paragraphs", () => {
    const text = SceneNodeSchema.parse({
      id: "t",
      name: "Title",
      type: "text",
      x: 0,
      y: 0,
      w: 400,
      h: 60,
      characters: "Hello\nWorld",
      runs: [
        {
          start: 0,
          end: 11,
          fontFamily: "Inter",
          fontStyle: "Bold",
          fontSize: 48,
          fill: { type: "solid", color: "#111111" },
        },
      ],
      paragraphs: [
        { start: 0, end: 5 },
        { start: 6, end: 11, list: "bullet" },
      ],
    });
    expect(text.type === "text" && text.paragraphs[1]?.list).toBe("bullet");
  });
});

describe("scene document", () => {
  it("parses a minimal document and pins the IR version", () => {
    const slide = SlideSchema.parse({ name: "01", width: 1920, height: 1080 });
    const scene = SceneSchema.parse({
      version: 1,
      source: { kind: "pdf", name: "deck.pdf", pages: 1 },
      slides: [slide],
    });
    expect(scene.slides[0]?.children).toEqual([]);
    expect(SceneSchema.safeParse({ ...scene, version: 2 }).success).toBe(false);
  });
});
