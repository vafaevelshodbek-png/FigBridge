/**
 * Rasterizes primitives Figma cannot express natively — images, soft-masked content and
 * non-normal blend modes — into transparent PNG layers, exactly as the PDF draws them.
 *
 * We composite ourselves (instead of pdf.js's renderer with an operation filter) so the
 * result depends only on our interpreter's output, and a layer contains ONLY its own
 * primitives: text and vectors drawn over a photo stay separate, editable layers.
 */
import { type Canvas, createCanvas, ImageData, Path2D, type SKRSContext2D } from "@napi-rs/canvas";
import type { Matrix } from "./matrix.js";
import type { Box, Segment } from "./path.js";
import type {
  ClipPath,
  ImagePrimitive,
  Primitive,
  ShadingPrimitive,
  SoftMask,
} from "./primitives.js";

/** Decoded image as pdf.js provides it. */
export interface DecodedImage {
  width: number;
  height: number;
  /** pdf.js ImageKind: 1 = 1-bit grayscale, 2 = RGB, 3 = RGBA. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** pdf.js "RadialAxial" shading IR: [type, "axial" | "radial", bbox, stops, p0, p1, r0, r1]. */
export type ShadingIR = readonly [
  string,
  string,
  unknown,
  readonly (readonly [number, string])[],
  readonly number[],
  readonly number[],
  number | null,
  number | null,
];

export interface CompositeSources {
  image(source: ImagePrimitive["source"]): DecodedImage | undefined;
  shading(pattern: string): ShadingIR | undefined;
  masks: ReadonlyMap<number, SoftMask>;
}

export interface Layer {
  /** Device-space box of the returned bitmap. */
  box: Box;
  png: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * Render `primitives` (paint order) within `region` at `scale` pixels per device pixel.
 * Returns undefined when nothing visible was drawn.
 */
export function compositeLayer(
  primitives: readonly Primitive[],
  region: Box,
  scale: number,
  sources: CompositeSources,
): Layer | undefined {
  const width = Math.max(1, Math.ceil((region.x1 - region.x0) * scale));
  const height = Math.max(1, Math.ceil((region.y1 - region.y0) * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const view: Matrix = [scale, 0, 0, scale, -region.x0 * scale, -region.y0 * scale];

  for (const primitive of primitives) {
    if (primitive.mask === undefined) {
      drawPrimitive(ctx, primitive, view, sources);
      continue;
    }
    // Draw on a scratch canvas, keep only what the mask lets through, then composite.
    const scratch = createCanvas(width, height);
    drawPrimitive(
      scratch.getContext("2d"),
      { ...primitive, blendMode: "source-over" },
      view,
      sources,
    );
    const mask = sources.masks.get(primitive.mask);
    if (mask !== undefined) applyMask(scratch, renderMask(mask, width, height, view, sources));
    ctx.save();
    ctx.globalCompositeOperation = primitive.blendMode as GlobalCompositeOperation;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  return trim(canvas, region, scale);
}

function drawPrimitive(
  ctx: SKRSContext2D,
  primitive: Primitive,
  view: Matrix,
  sources: CompositeSources,
): void {
  ctx.save();
  ctx.setTransform(...view);
  applyClips(ctx, primitive.clips);
  ctx.globalCompositeOperation = primitive.blendMode as GlobalCompositeOperation;
  ctx.globalAlpha = primitive.alpha;
  switch (primitive.kind) {
    case "path": {
      const path = toPath2D(primitive.segments);
      if (primitive.fill !== undefined) {
        ctx.globalAlpha = primitive.fill.alpha;
        ctx.fillStyle = primitive.fill.color;
        ctx.fill(path, primitive.fill.evenOdd ? "evenodd" : "nonzero");
      }
      if (primitive.stroke !== undefined) {
        ctx.globalAlpha = primitive.stroke.alpha;
        ctx.strokeStyle = primitive.stroke.color;
        ctx.lineWidth = primitive.stroke.width;
        ctx.setLineDash(primitive.stroke.dash);
        ctx.stroke(path);
      }
      break;
    }
    case "image":
      drawImage(ctx, primitive, view, sources);
      break;
    case "shading":
      drawShading(ctx, primitive, view, sources);
      break;
    case "text":
      break; // text is always emitted as editable text, never rasterized
  }
  ctx.restore();
}

function drawImage(
  ctx: SKRSContext2D,
  primitive: ImagePrimitive,
  view: Matrix,
  sources: CompositeSources,
): void {
  const image = sources.image(primitive.source);
  if (image === undefined) return;
  const bitmap = toCanvas(image, primitive.stencil);
  // The image unit square has y up; device space has y down: flip within the unit square.
  const [a, b, c, d, e, f] = primitive.ctm;
  ctx.setTransform(...view);
  ctx.transform(a, b, c, d, e, f);
  ctx.transform(1 / image.width, 0, 0, -1 / image.height, 0, 1);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0);
}

function drawShading(
  ctx: SKRSContext2D,
  primitive: ShadingPrimitive,
  view: Matrix,
  sources: CompositeSources,
): void {
  const ir = sources.shading(primitive.pattern);
  if (ir === undefined || ir[0] !== "RadialAxial") return;
  const [, type, , stops, p0, p1, r0, r1] = ir;
  const [a, b, c, d, e, f] = primitive.ctm;
  ctx.setTransform(...view);
  ctx.transform(a, b, c, d, e, f);
  const gradient =
    type === "radial"
      ? ctx.createRadialGradient(p0[0] ?? 0, p0[1] ?? 0, r0 ?? 0, p1[0] ?? 0, p1[1] ?? 0, r1 ?? 0)
      : ctx.createLinearGradient(p0[0] ?? 0, p0[1] ?? 0, p1[0] ?? 0, p1[1] ?? 0);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  // The shading fills the whole clip region; a huge rectangle in shading space covers it.
  ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
}

function renderMask(
  mask: SoftMask,
  width: number,
  height: number,
  view: Matrix,
  sources: CompositeSources,
): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (mask.subtype === "Luminosity") {
    ctx.fillStyle = mask.backdrop;
    ctx.fillRect(0, 0, width, height);
  }
  for (const primitive of mask.primitives)
    drawPrimitive(ctx, { ...primitive, clips: primitive.clips }, view, sources);
  return canvas;
}

/** Multiply the scratch canvas's alpha by the mask (luminance or alpha channel). */
function applyMask(target: Canvas, mask: Canvas): void {
  const ctx = target.getContext("2d");
  const pixels = ctx.getImageData(0, 0, target.width, target.height);
  const maskPixels = mask.getContext("2d").getImageData(0, 0, mask.width, mask.height).data;
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = maskPixels[i] ?? 0;
    const g = maskPixels[i + 1] ?? 0;
    const b = maskPixels[i + 2] ?? 0;
    // Rec. 601 luma, as the PDF spec prescribes for luminosity masks.
    const luminance = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    data[i + 3] = Math.round((data[i + 3] ?? 0) * luminance);
  }
  ctx.putImageData(pixels, 0, 0);
}

function applyClips(ctx: SKRSContext2D, clips: readonly ClipPath[]): void {
  for (const clip of clips) ctx.clip(toPath2D(clip.segments), clip.evenOdd ? "evenodd" : "nonzero");
}

function toPath2D(segments: readonly Segment[]): Path2D {
  const path = new Path2D();
  for (const s of segments) {
    if (s.op === "M") path.moveTo(s.to[0], s.to[1]);
    else if (s.op === "L") path.lineTo(s.to[0], s.to[1]);
    else if (s.op === "C") path.bezierCurveTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1]);
    else path.closePath();
  }
  return path;
}

/** Convert pdf.js decoded pixels to a canvas (RGBA). */
function toCanvas(image: DecodedImage, stencilColor: string | undefined): Canvas {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  const src = image.data;
  const pixels = image.width * image.height;
  if (image.kind === 3) rgba.set(src.subarray(0, rgba.length));
  else if (image.kind === 2) {
    for (let p = 0; p < pixels; p++) {
      rgba[p * 4] = src[p * 3] ?? 0;
      rgba[p * 4 + 1] = src[p * 3 + 1] ?? 0;
      rgba[p * 4 + 2] = src[p * 3 + 2] ?? 0;
      rgba[p * 4 + 3] = 255;
    }
  } else {
    // 1-bit, rows padded to whole bytes. For stencil masks, 0 bits paint the fill colour.
    const rowBytes = Math.ceil(image.width / 8);
    const [r, g, b] = stencilColor === undefined ? [0, 0, 0] : hexChannels(stencilColor);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const bit = ((src[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        const p = (y * image.width + x) * 4;
        if (stencilColor === undefined) {
          const v = bit === 1 ? 255 : 0;
          rgba[p] = v;
          rgba[p + 1] = v;
          rgba[p + 2] = v;
          rgba[p + 3] = 255;
        } else {
          rgba[p] = r;
          rgba[p + 1] = g;
          rgba[p + 2] = b;
          rgba[p + 3] = bit === 0 ? 255 : 0;
        }
      }
    }
  }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  return canvas;
}

function hexChannels(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Crop to the non-transparent pixels and encode as PNG. */
function trim(canvas: Canvas, region: Box, scale: number): Layer | undefined {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cropped = createCanvas(w, h);
  cropped.getContext("2d").drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return {
    box: {
      x0: region.x0 + minX / scale,
      y0: region.y0 + minY / scale,
      x1: region.x0 + (maxX + 1) / scale,
      y1: region.y0 + (maxY + 1) / scale,
    },
    png: cropped.toBuffer("image/png"),
    pixelWidth: w,
    pixelHeight: h,
  };
}
