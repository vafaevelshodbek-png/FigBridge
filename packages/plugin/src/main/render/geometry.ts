/**
 * Pure geometry helpers for placing Scene nodes (no Figma API, unit-tested).
 */

/** A 2×3 affine matrix in Figma's `relativeTransform` layout: [[a, c, tx], [b, d, ty]]. */
export type Affine = [[number, number, number], [number, number, number]];

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise (screen coordinates, y down). */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * Transform that maps the node's local box (0..w, 0..h) to parent coordinates such that the
 * box is rotated and flipped around its centre and the unrotated box sits at (x, y).
 *
 * Figma's `rotation` property turns around the top-left corner and counter-clockwise, and it
 * cannot express flips — so we write `relativeTransform` directly.
 */
export function placementTransform(p: Placement): Affine {
  const radians = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const fx = p.flipX ? -1 : 1;
  const fy = p.flipY ? -1 : 1;
  const a = cos * fx;
  const b = sin * fx;
  const c = -sin * fy;
  const d = cos * fy;
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return [
    [a, c, cx - (a * p.w) / 2 - (c * p.h) / 2],
    [b, d, cy - (b * p.w) / 2 - (d * p.h) / 2],
  ];
}

/** True when the placement needs a matrix (rotation or flip) rather than plain x/y. */
export function needsMatrix(p: Placement): boolean {
  return p.rotation % 360 !== 0 || p.flipX || p.flipY;
}

/** Figma requires strictly positive sizes; Scene allows zero (hairlines). */
export const MIN_SIZE = 0.01;

export function safeSize(value: number): number {
  return Math.max(value, MIN_SIZE);
}

/**
 * Figma's gradientTransform for a linear gradient running from `from` to `to`, both in the
 * node's unit square. The transform maps the node space to gradient space, where the
 * gradient runs along x from 0 to 1.
 */
export function linearGradientTransform(from: [number, number], to: [number, number]): Affine {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy || 1;
  // Rows: projection onto the gradient direction, and onto its perpendicular.
  const a = dx / lengthSquared;
  const c = dy / lengthSquared;
  const b = -dy / lengthSquared;
  const d = dx / lengthSquared;
  return [
    [a, c, -(a * from[0] + c * from[1])],
    [b, d, 0.5 - (b * from[0] + d * from[1])],
  ];
}

/** Parse `#RRGGBB` into Figma's 0..1 channel object. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}
