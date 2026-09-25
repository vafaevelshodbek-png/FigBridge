/**
 * Decisions about single primitives: page background, invisible shapes, duplicates, and shadings
 * that are plain gradients.
 */
import type { SceneNode } from "@figbridge/scene";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ShadingIR } from "./compositor.js";
import { apply } from "./matrix.js";
import { asRoundedRect, type Box } from "./path.js";
import { getObject } from "./pdfjs.js";
import type { PathPrimitive, ShadingPrimitive } from "./primitives.js";
import { round } from "./round.js";
import { area, intersect } from "./shapes.js";

/** Background detection: a plain rectangle covering at least this share of the page. */
export const BACKGROUND_COVERAGE = 0.98;

/** Fully transparent shapes (hit areas, placeholders in exported decks) are not layers. */
export function isInvisible(p: PathPrimitive): boolean {
  return (
    (p.fill === undefined || p.fill.alpha === 0) && (p.stroke === undefined || p.stroke.alpha === 0)
  );
}

/**
 * A plain rectangle covering the page, and not clipped to less than the page: a fill seen
 * through a ring-shaped or partial clip is content, not the background.
 */
export function isPageRect(p: PathPrimitive, slide: Box): boolean {
  const covers = (segments: PathPrimitive["segments"]) => {
    const rect = asRoundedRect(segments);
    if (rect === undefined || rect.radii.some((r) => r > 0)) return false;
    const covered = intersect(rect.box, slide);
    return covered !== undefined && area(covered) >= BACKGROUND_COVERAGE * area(slide);
  };
  // One rectangle is the same region under either fill rule; rings fail asRoundedRect.
  return covers(p.segments) && p.clips.every((clip) => covers(clip.segments));
}

/** Identical shapes painted twice (common in exported decks) would double opacity and clutter layers. */
export function dedupe(paths: readonly PathPrimitive[]): PathPrimitive[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = JSON.stringify([p.box, p.fill, p.stroke, p.segments.length]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A plain (unmasked) axial shading clipped to a rectangle → a rectangle with a linear gradient. */
export function gradientRect(
  primitive: ShadingPrimitive,
  visible: Box,
  page: PDFPageProxy,
  nextId: () => string,
): SceneNode | undefined {
  const ir = getObject<ShadingIR>(page, primitive.pattern);
  if (ir?.[0] !== "RadialAxial" || ir[1] !== "axial") return undefined;
  const innermost = primitive.clips[primitive.clips.length - 1];
  const shape = innermost === undefined ? undefined : asRoundedRect(innermost.segments);
  if (shape === undefined) return undefined;
  const [, , , stops, p0, p1] = ir;
  const w = visible.x1 - visible.x0;
  const h = visible.y1 - visible.y0;
  if (w <= 0 || h <= 0) return undefined;
  const [ax, ay] = apply(primitive.ctm, p0[0] ?? 0, p0[1] ?? 0);
  const [bx, by] = apply(primitive.ctm, p1[0] ?? 0, p1[1] ?? 0);
  return {
    id: nextId(),
    name: "gradient",
    type: "rect",
    x: round(visible.x0),
    y: round(visible.y0),
    w: round(w),
    h: round(h),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    fills: [
      {
        type: "linear-gradient",
        from: [(ax - visible.x0) / w, (ay - visible.y0) / h],
        to: [(bx - visible.x0) / w, (by - visible.y0) / h],
        stops: stops.map(([position, color]) => ({
          position,
          color: color.toUpperCase(),
          opacity: 1,
        })),
        opacity: primitive.alpha,
      },
    ],
    strokes: [],
    radii: shape.radii,
  };
}
