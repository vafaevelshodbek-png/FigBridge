/**
 * Pixel comparison of two images: how much differs, and a map showing where.
 *
 * Used by the golden tests and by `figma_compare` / `figbridge compare` (a design frame
 * against a screenshot of its implementation). Node-only (depends on @napi-rs/canvas);
 * import from "@figbridge/scene/compare".
 */
import { createCanvas, type ImageData, loadImage } from "@napi-rs/canvas";

export interface CompareOptions {
  /**
   * A pixel differs when any channel moves by more than this (0–255). The default absorbs
   * anti-aliasing and colour-profile noise; lower it for strict pixel-perfect checks.
   */
  tolerance?: number;
}

export interface Comparison {
  width: number;
  height: number;
  /** Size of the second image when it differs from the first (it is scaled to compare). */
  resizedFrom?: { width: number; height: number };
  differing: number;
  /** Share of differing pixels, 0–1. */
  ratio: number;
  /** PNG: differing pixels in red over a faded copy of the first image. */
  diff: Buffer;
}

export const DEFAULT_TOLERANCE = 40;

async function pixels(png: Uint8Array, width?: number, height?: number): Promise<ImageData> {
  const image = await loadImage(png);
  const w = width ?? image.width;
  const h = height ?? image.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Compare `actual` against `expected`; `actual` is scaled to `expected`'s size if needed. */
export async function compareImages(
  expected: Uint8Array,
  actual: Uint8Array,
  options: CompareOptions = {},
): Promise<Comparison> {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const e = await pixels(expected);
  const original = await loadImage(actual);
  const resized = original.width !== e.width || original.height !== e.height;
  const a = await pixels(actual, e.width, e.height);
  const map = createCanvas(e.width, e.height);
  const out = map.getContext("2d").createImageData(e.width, e.height);
  let differing = 0;
  for (let i = 0; i < e.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++)
      delta = Math.max(delta, Math.abs((a.data[i + c] ?? 0) - (e.data[i + c] ?? 0)));
    const differs = delta > tolerance;
    if (differs) differing++;
    const grey = 255 - ((255 - (e.data[i] ?? 255)) >> 2);
    out.data.set(differs ? [255, 0, 0, 255] : [grey, grey, grey, 255], i);
  }
  map.getContext("2d").putImageData(out, 0, 0);
  return {
    width: e.width,
    height: e.height,
    ...(resized ? { resizedFrom: { width: original.width, height: original.height } } : {}),
    differing,
    ratio: differing / (e.width * e.height),
    diff: map.toBuffer("image/png"),
  };
}

/** Width and height of a PNG/JPEG without decoding the pixels twice. */
export async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const image = await loadImage(bytes);
  return { width: image.width, height: image.height };
}
