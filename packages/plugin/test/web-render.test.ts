import { SlideSchema } from "@figbridge/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { FontLoader } from "../src/main/render/fonts.js";
import { SceneRenderer } from "../src/main/render/scene-renderer.js";
import { installFakeFigma } from "./fake-figma.js";

describe("native web frames", () => {
  beforeEach(() => installFakeFigma());
  it("includes the frame background in its alpha mask", async () => {
    const fake = installFakeFigma();
    const renderer = new SceneRenderer({
      fonts: new FontLoader((font) => fake.loadFontAsync(font)),
      images: () => Promise.resolve("unused"),
      warnings: [],
      checkCancelled: () => undefined,
    });
    await renderer.renderSlide(
      SlideSchema.parse({
        name: "Masked background",
        width: 100,
        height: 100,
        children: [
          {
            type: "frame",
            id: "masked",
            name: "masked",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            fills: [{ type: "solid", color: "#ff0000" }],
            mask: [{ type: "solid", color: "#000000", opacity: 0.5 }],
            children: [],
          },
        ],
      }),
      fake.currentPage as never,
      0,
      0,
    );
    const frame = fake.all().find((n) => n.name === "masked");
    expect(frame?.fills).toEqual([]);
    expect(frame?.children[0]).toMatchObject({ isMask: true, maskType: "ALPHA" });
    expect(frame?.children[1]).toMatchObject({
      name: "CSS masked contents",
      children: [
        { name: "CSS masked background", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] },
      ],
    });
  });
  it("retains hierarchy, scrolling content and text as native nodes", async () => {
    const fake = installFakeFigma();
    const warnings: string[] = [];
    const renderer = new SceneRenderer({
      fonts: new FontLoader((font) => fake.loadFontAsync(font)),
      images: () => Promise.resolve("unused"),
      warnings,
      checkCancelled: () => undefined,
    });
    const slide = SlideSchema.parse({
      name: "UI",
      width: 390,
      height: 844,
      children: [
        {
          type: "frame",
          id: "scroll",
          name: "scroll",
          x: 12,
          y: 24,
          w: 360,
          h: 500,
          clip: true,
          overflow: "VERTICAL",
          children: [{ type: "rect", id: "far", name: "offscreen", x: 3, y: 3500, w: 80, h: 50 }],
        },
      ],
    });
    await renderer.renderSlide(slide, fake.currentPage as never, 100, 200);
    expect(warnings).toEqual([]);
    const frame = fake.all().find((n) => n.name === "scroll");
    expect(frame).toMatchObject({
      type: "FRAME",
      x: 12,
      y: 24,
      clipsContent: true,
      overflowDirection: "VERTICAL",
    });
    expect(frame?.children[0]).toMatchObject({ x: 3, y: 3500 });
    expect(frame?.getPluginData("figbridge.sourceId")).toBe("scroll");
  });
});
