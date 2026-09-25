/**
 * Embedded pictures → content-addressed blobs and image paints.
 */
import { contentBlobId, type ImagePaint } from "@figbridge/scene";
import { clamp01 } from "./color.js";
import type { SlideContext } from "./context.js";
import { attr, child, num, type XmlElement } from "./xml.js";

/** srcRect / alphaModFix values are thousandths of a percent. */
const PERCENT = 100_000;

type Sniffed = { kind: "raster"; mimeType: string } | { kind: "unsupported"; format: string };

/** Identify an image by its magic bytes (file extensions in packages are unreliable). */
export function sniffImage(bytes: Uint8Array): Sniffed {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return { kind: "raster", mimeType: "image/png" };
  if (at(0) === 0xff && at(1) === 0xd8) return { kind: "raster", mimeType: "image/jpeg" };
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46)
    return { kind: "raster", mimeType: "image/gif" };
  if (at(0) === 0x01 && at(1) === 0 && at(2) === 0 && at(3) === 0 && at(40) === 0x20)
    return { kind: "unsupported", format: "EMF" };
  if (at(0) === 0xd7 && at(1) === 0xcd && at(2) === 0xc6 && at(3) === 0x9a)
    return { kind: "unsupported", format: "WMF" };
  if (at(0) === 0x42 && at(1) === 0x4d) return { kind: "unsupported", format: "BMP" };
  if ((at(0) === 0x49 && at(1) === 0x49) || (at(0) === 0x4d && at(1) === 0x4d))
    return { kind: "unsupported", format: "TIFF" };
  return { kind: "unsupported", format: "unknown" };
}

/** Store raw bytes (already known to be a Figma-supported raster) and return the blob id. */
export function storeBlob(ctx: SlideContext, bytes: Uint8Array, mimeType: string): string {
  const id = contentBlobId(bytes);
  if (!ctx.blobs.has(id)) ctx.blobs.set(id, { bytes, mimeType });
  return id;
}

/**
 * The image referenced by `a:blip r:embed` in `part`, as a blob id.
 *
 * For SVG pictures (`asvg:svgBlip` in the blip's extensions) the blip itself embeds the PNG
 * fallback PowerPoint writes alongside; Scene has no SVG node, so that raster is used.
 */
export function blipBlob(ctx: SlideContext, part: string, blip: XmlElement): string | undefined {
  const rid = attr(blip, "r:embed");
  if (rid === undefined) {
    if (attr(blip, "r:link") !== undefined) ctx.warn("linked (external) picture skipped");
    return undefined;
  }
  const target = ctx.pkg.rels(part).internal.get(rid);
  const bytes = target === undefined ? undefined : ctx.pkg.bytes(target);
  if (bytes === undefined) {
    ctx.warn(`picture ${rid} is missing from the package`);
    return undefined;
  }
  const sniffed = sniffImage(bytes);
  if (sniffed.kind === "unsupported") {
    ctx.warn(`${sniffed.format} picture skipped (${target ?? rid})`);
    return undefined;
  }
  return storeBlob(ctx, bytes, sniffed.mimeType);
}

/** Build the image paint for a `blipFill` element (pictures and shape picture fills). */
export function blipFillPaint(
  ctx: SlideContext,
  part: string,
  blipFill: XmlElement,
): ImagePaint | undefined {
  const blip = child(blipFill, "blip");
  if (blip === undefined) return undefined;
  const blob = blipBlob(ctx, part, blip);
  if (blob === undefined) return undefined;
  const opacity = clamp01(num(child(blip, "alphaModFix"), "amt", PERCENT) / PERCENT);
  if (child(blipFill, "tile") !== undefined)
    return { type: "image", blob, scaleMode: "tile", tileScale: 1, opacity };
  const crop = cropOf(child(blipFill, "srcRect"));
  return crop === undefined
    ? { type: "image", blob, scaleMode: "fill", opacity }
    : { type: "image", blob, scaleMode: "crop", crop, opacity };
}

/**
 * `srcRect` insets (l/t/r/b, may be negative for letterboxing) → the visible unit sub-rect.
 * Negative insets (image smaller than the frame) are clamped: Scene crops cannot extend.
 */
export function cropOf(
  srcRect: XmlElement | undefined,
): { x: number; y: number; w: number; h: number } | undefined {
  if (srcRect === undefined) return undefined;
  const l = clamp01(num(srcRect, "l", 0) / PERCENT);
  const t = clamp01(num(srcRect, "t", 0) / PERCENT);
  const r = clamp01(num(srcRect, "r", 0) / PERCENT);
  const b = clamp01(num(srcRect, "b", 0) / PERCENT);
  if (l === 0 && t === 0 && r === 0 && b === 0) return undefined;
  const w = Math.max(0.001, 1 - l - r);
  const h = Math.max(0.001, 1 - t - b);
  return { x: Math.min(l, 1 - w), y: Math.min(t, 1 - h), w, h };
}
