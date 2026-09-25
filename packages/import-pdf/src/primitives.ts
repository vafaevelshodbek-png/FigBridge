/**
 * What the interpreter emits: drawing primitives in device space, in paint order, with the
 * graphics state that affects how they look.
 */
import type { Matrix } from "./matrix.js";
import type { Box, Segment } from "./path.js";

export interface ClipPath {
  segments: Segment[];
  evenOdd: boolean;
}

export interface PaintState {
  /** Clips active when the primitive was painted, outermost first. */
  clips: ClipPath[];
  /** Soft mask or non-normal blend mode: Figma cannot express it natively, so it is rasterized. */
  raster: boolean;
  /** Canvas composite operation name (pdf.js already uses canvas names, e.g. "screen"). */
  blendMode: string;
  /** Soft mask applied to this primitive (see {@link SoftMask}). */
  mask?: number;
  /** Opacity for images and shadings: fill alpha × enclosing group opacities. */
  alpha: number;
}

/** A luminosity/alpha soft mask captured from a transparency group. */
export interface SoftMask {
  id: number;
  subtype: "Luminosity" | "Alpha";
  backdrop: string;
  primitives: Primitive[];
}

export interface PathPrimitive extends PaintState {
  kind: "path";
  op: number;
  segments: Segment[];
  box: Box;
  fill?: { color: string; alpha: number; evenOdd: boolean };
  stroke?: {
    color: string;
    alpha: number;
    width: number;
    dash: number[];
    cap: number;
    join: number;
  };
}

export interface ImagePrimitive extends PaintState {
  kind: "image";
  op: number;
  /** pdf.js object id of the decoded image (resolve with `page.objs`), or inline data. */
  source: { objId: string } | { inline: unknown };
  /** Maps the image's unit square (y up) to device space. */
  ctm: Matrix;
  /** Device-space bounding box of the unit square. */
  box: Box;
  /** Stencil masks paint the current fill colour through the image's alpha. */
  stencil?: string;
}

export interface ShadingPrimitive extends PaintState {
  kind: "shading";
  op: number;
  pattern: string;
  ctm: Matrix;
}

export interface Glyph {
  text: string;
  /** Baseline origin, device space. */
  x: number;
  y: number;
  /** Advance width in device pixels. */
  advance: number;
  /** Nominal glyph width (font units → px) used to detect ligature glyphs. */
  nominal: number;
  size: number;
  font: string;
  color: string;
  alpha: number;
  /** Text direction is horizontal (unrotated) — rotated text is kept but grouped separately. */
  upright: boolean;
}

export interface TextPrimitive extends PaintState {
  kind: "text";
  op: number;
  glyphs: Glyph[];
}

export type Primitive = PathPrimitive | ImagePrimitive | ShadingPrimitive | TextPrimitive;

export interface FontInfo {
  name: string;
}

export interface InterpretResult {
  primitives: Primitive[];
  masks: Map<number, SoftMask>;
}
