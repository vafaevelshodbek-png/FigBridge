import { expect, it } from "vitest";
import { normalizeCapture } from "../web/normalize-capture.mjs";

interface CapturedNode {
  type?: string;
  id?: string;
  name?: string;
  cssZIndex?: number;
  w?: number;
  h?: number;
  mask?: unknown[];
  children?: CapturedNode[];
  x?: number;
  y?: number;
  cssStackingContext?: boolean;
}

it("lifts positioned contexts through nonstacking wrappers above portal siblings", () => {
  const scene = normalizeCapture<CapturedNode>({
    type: "frame",
    id: "body",
    cssStackingContext: true,
    children: [
      {
        type: "frame",
        id: "app",
        x: 10,
        y: 20,
        cssStackingContext: false,
        children: [
          { type: "frame", id: "guide", x: 2, y: 3, cssZIndex: 55, cssStackingContext: true },
        ],
      },
      { type: "frame", id: "modal", cssZIndex: 50, cssStackingContext: true },
    ],
  });
  expect(scene.children?.map((n) => n.id)).toEqual(["app", "modal", "guide"]);
  expect(scene.children?.[2]).toMatchObject({ x: 12, y: 23 });
  expect(scene.children?.[0]?.children).toEqual([]);
  expect(normalizeCapture(structuredClone(scene))).toEqual(scene);
});

it("keeps descendants inside their actual stacking context", () => {
  const scene = normalizeCapture<CapturedNode>({
    type: "frame",
    id: "body",
    cssStackingContext: true,
    children: [
      {
        type: "frame",
        id: "isolated",
        cssZIndex: 1,
        cssStackingContext: true,
        children: [{ type: "frame", id: "inner", cssZIndex: 999, cssStackingContext: true }],
      },
      { type: "frame", id: "modal", cssZIndex: 50, cssStackingContext: true },
    ],
  });
  expect(scene.children?.map((n) => n.id)).toEqual(["isolated", "modal"]);
  expect(scene.children?.[0]?.children?.[0]?.id).toBe("inner");
});

it("keeps a masked background below negative stacking decorations", () => {
  const scene = normalizeCapture<CapturedNode>({
    type: "frame",
    id: "masked",
    w: 100,
    h: 100,
    mask: [],
    children: [{ id: "before", name: "::before", cssZIndex: -1 }, { id: "text" }],
  });
  expect(scene.children?.[0]?.children?.map((node) => node.id)).toEqual([
    "masked/masked-background",
    "before",
    "text",
  ]);
});

it("paints before decorations behind content and respects explicit stacking levels", () => {
  const scene = {
    type: "frame",
    children: [
      { name: "content", id: "text" },
      { name: "::before", id: "shade" },
      { name: "high", id: "high", cssZIndex: 2 },
    ],
  };
  expect(normalizeCapture(scene).children.map((n) => n.id)).toEqual(["shade", "text", "high"]);
});

it("isolates masked frames and retains the measured browser line boundaries", () => {
  const scene = {
    type: "frame",
    id: "masked",
    w: 100,
    h: 100,
    mask: [{ type: "solid", color: "#000000" }],
    children: [
      { type: "text", id: "root/0/text0/line0", sizing: "fixed", fontFamily: "Nunito Variable" },
    ],
  };
  expect(normalizeCapture(scene)).toMatchObject({
    blendMode: "NORMAL",
    children: [
      { type: "group", children: [{ type: "rect" }, { sizing: "width", fontFamily: "Nunito" }] },
    ],
  });
});

it("is idempotent and preserves deliberate blending and unrelated text boxes", () => {
  const scene = {
    type: "frame",
    blendMode: "SCREEN",
    mask: [],
    children: [
      { type: "text", id: "input/value", sizing: "fixed" },
      {
        stops: [
          { position: 0, opacity: 1, color: "#f1e2cd" },
          { position: 1, opacity: 0, color: "#000000" },
        ],
      },
    ],
  };
  normalizeCapture(scene);
  const snapshot = structuredClone(scene);
  expect(normalizeCapture(scene)).toEqual(snapshot);
  expect(scene.blendMode).toBe("SCREEN");
  expect(scene).toMatchObject({
    children: [
      {
        type: "group",
        children: [
          { type: "rect" },
          { sizing: "fixed" },
          { stops: [{ color: "#f1e2cd" }, { color: "#f1e2cd" }] },
        ],
      },
    ],
  });
});
