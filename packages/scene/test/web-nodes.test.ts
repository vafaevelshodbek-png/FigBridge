import { describe, expect, it } from "vitest";
import { SceneNodeSchema } from "../src/index.js";

describe("web UI scene nodes", () => {
  it("preserves nested local coordinates, clips and scrolling beyond a viewport", () => {
    const node = SceneNodeSchema.parse({
      type: "frame",
      id: "scroll",
      name: "scroll",
      x: 10,
      y: 20,
      w: 390,
      h: 844,
      clip: true,
      overflow: "VERTICAL",
      children: [
        { type: "frame", id: "map", name: "map", x: 0, y: 0, w: 390, h: 4000, children: [] },
      ],
    });
    expect(node).toMatchObject({ clip: true, overflow: "VERTICAL", children: [{ h: 4000 }] });
  });
  it("accepts original SVG and rejects external scripting payloads", () => {
    const base = { type: "svg", id: "icon", name: "icon", x: 0, y: 0, w: 24, h: 24 };
    expect(
      SceneNodeSchema.safeParse({
        ...base,
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L24 24"/></svg>',
      }).success,
    ).toBe(true);
    expect(
      SceneNodeSchema.safeParse({ ...base, svg: "<svg><script>alert(1)</script></svg>" }).success,
    ).toBe(false);
  });
  it("supports editable components, provenance and native shadows", () => {
    const node = SceneNodeSchema.parse({
      type: "frame",
      id: "button",
      name: "Button",
      x: 0,
      y: 0,
      w: 100,
      h: 40,
      component: true,
      source: "button.primary",
      children: [],
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.2 },
          offset: { x: 0, y: 2 },
          radius: 4,
          spread: 0,
          visible: true,
          blendMode: "NORMAL",
        },
      ],
    });
    expect(node).toMatchObject({
      component: true,
      source: "button.primary",
      effects: [{ radius: 4 }],
    });
  });
});
