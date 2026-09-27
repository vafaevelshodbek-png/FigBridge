/**
 * Scene paints → Figma paints.
 */
import type { Paint as ScenePaint, Stroke as SceneStroke } from "@figbridge/scene";
import type { ColorVariables } from "./color-variables.js";
import { hexToRgb, linearGradientTransform } from "./geometry.js";

/** Resolves a Scene blob reference to a Figma image hash (uploading the bytes once). */
export type ImageResolver = (blob: string) => Promise<string>;

const SCALE_MODE = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" } as const;

export async function toFigmaPaint(
  paint: ScenePaint,
  images: ImageResolver,
  variables?: ColorVariables,
): Promise<Paint> {
  switch (paint.type) {
    case "solid": {
      const solid: SolidPaint = {
        type: "SOLID",
        color: hexToRgb(paint.color),
        opacity: paint.opacity,
      };
      return paint.variable === undefined || variables === undefined
        ? solid
        : variables.bind(solid, paint.variable);
    }
    case "linear-gradient":
      return {
        type: "GRADIENT_LINEAR",
        gradientTransform: linearGradientTransform(paint.from, paint.to),
        gradientStops: paint.stops.map((stop) => ({
          position: stop.position,
          color: { ...hexToRgb(stop.color), a: stop.opacity },
        })),
        opacity: paint.opacity,
      };
    case "radial-gradient": {
      const [cx, cy] = paint.center;
      const [rx, ry] = paint.radius;
      const sx = rx > 0 ? 1 / (2 * rx) : 1;
      const sy = ry > 0 ? 1 / (2 * ry) : 1;
      return {
        type: "GRADIENT_RADIAL",
        gradientTransform: [
          [sx, 0, 0.5 - sx * cx],
          [0, sy, 0.5 - sy * cy],
        ],
        gradientStops: paint.stops.map((stop) => ({
          position: stop.position,
          color: { ...hexToRgb(stop.color), a: stop.opacity },
        })),
        opacity: paint.opacity,
      };
    }
    case "image": {
      const image: ImagePaint = {
        type: "IMAGE",
        imageHash: await images(paint.blob),
        scaleMode: SCALE_MODE[paint.scaleMode],
        opacity: paint.opacity,
      };
      if (paint.crop !== undefined) {
        const { x, y, w, h } = paint.crop;
        return {
          ...image,
          scaleMode: "CROP",
          imageTransform: [
            [w, 0, x],
            [0, h, y],
          ],
        };
      }
      if (paint.scaleMode === "tile" && paint.tileScale !== undefined) {
        return { ...image, scalingFactor: paint.tileScale };
      }
      return image;
    }
  }
}

export function toFigmaPaints(
  paints: readonly ScenePaint[],
  images: ImageResolver,
  variables?: ColorVariables,
): Promise<Paint[]> {
  return Promise.all(paints.map((paint) => toFigmaPaint(paint, images, variables)));
}

const STROKE_ALIGN = { inside: "INSIDE", center: "CENTER", outside: "OUTSIDE" } as const;
const STROKE_CAP = { none: "NONE", round: "ROUND", square: "SQUARE" } as const;
const STROKE_JOIN = { miter: "MITER", round: "ROUND", bevel: "BEVEL" } as const;

/**
 * Apply strokes. Figma has one weight/align/dash per node, so the first stroke defines them;
 * importers emit at most one stroke per node in practice.
 */
export async function applyStrokes(
  node: GeometryMixin & MinimalStrokesMixin,
  strokes: readonly SceneStroke[],
  images: ImageResolver,
  variables?: ColorVariables,
): Promise<void> {
  const [first] = strokes;
  if (first === undefined) {
    // Clear explicitly: Figma gives a new vector a default 1 px black stroke.
    node.strokes = [];
    return;
  }
  node.strokes = await toFigmaPaints(
    strokes.map((stroke) => stroke.paint),
    images,
    variables,
  );
  node.strokeWeight = first.weight;
  node.strokeAlign = STROKE_ALIGN[first.align];
  node.dashPattern = first.dash ?? [];
  if ("strokeCap" in node) (node as VectorNode).strokeCap = STROKE_CAP[first.cap];
  node.strokeJoin = STROKE_JOIN[first.join];
}
