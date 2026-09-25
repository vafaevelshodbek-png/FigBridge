/**
 * Raster layers: what cannot be drawn as Figma vectors (soft masks, blends, images) is grouped
 * into zones and composited once per zone, at a resolution Figma accepts.
 */
import type { CompositeSources } from "./compositor.js";
import type { Box } from "./path.js";
import type { Primitive } from "./primitives.js";
import { intersect } from "./shapes.js";

/** Minimum raster scale: crisp on retina displays even for low-res sources. */
export const MIN_RASTER_SCALE = 2;

/** Figma's createImage rejects images larger than this on either side. */
export const FIGMA_MAX_IMAGE_SIDE = 4096;

/** Resolution that keeps the sharpest source image at (at least) its native pixel density. */
export function rasterScale(
  items: readonly Primitive[],
  sources: CompositeSources,
  max: number,
): number {
  let scale = Math.min(MIN_RASTER_SCALE, max);
  for (const item of items) {
    if (item.kind !== "image") continue;
    const image = sources.image(item.source);
    const width = item.box.x1 - item.box.x0;
    if (image !== undefined && width > 0) scale = Math.max(scale, image.width / width);
  }
  return Math.min(scale, max);
}

export type RasterItem = { primitive: Primitive; box: Box };

export type Zone = { box: Box; items: RasterItem[]; firstOp: number; lastOp: number };

/**
 * Union overlapping raster items into zones; each zone becomes one image layer.
 *
 * A zone must not span a vector painted in between that overlaps it: one bitmap cannot be
 * both below and above that vector. Such a vector "seals" the zone, and later raster items
 * start a new zone (a new layer above the vector).
 */
export function clusterZones(
  items: readonly RasterItem[],
  vectors: readonly { op: number; box: Box }[],
): Zone[] {
  const zones: Zone[] = [];
  const sealed = new Set<Zone>();
  const sealedBy = (zone: Zone, beforeOp: number) =>
    vectors.some(
      (v) => v.op > zone.lastOp && v.op < beforeOp && intersect(v.box, zone.box) !== undefined,
    );
  for (const item of [...items].sort((a, b) => a.primitive.op - b.primitive.op)) {
    const op = item.primitive.op;
    for (const zone of zones) if (!sealed.has(zone) && sealedBy(zone, op)) sealed.add(zone);
    const hits = zones.filter((z) => !sealed.has(z) && intersect(z.box, item.box) !== undefined);
    const merged: Zone = { box: item.box, items: [item], firstOp: op, lastOp: op };
    for (const hit of hits) {
      merged.box = union(merged.box, hit.box);
      merged.items.unshift(...hit.items);
      merged.firstOp = Math.min(merged.firstOp, hit.firstOp);
      zones.splice(zones.indexOf(hit), 1);
    }
    merged.items.sort((a, b) => a.primitive.op - b.primitive.op);
    zones.push(merged);
  }
  return zones;
}

export function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}
