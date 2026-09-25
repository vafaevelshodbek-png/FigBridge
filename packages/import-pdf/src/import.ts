/**
 * PDF → Scene: the importer pipeline.
 *
 *   operator list ─interpret→ primitives ─┬─ text      → paragraphs → text nodes
 *                                          ├─ vectors   → rects (radii) / vectors
 *                                          ├─ shadings  → gradient rects (simple) or raster
 *                                          └─ raster    → composited PNG layers (images, masks)
 *   then background → frame fill, cards group their content.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  contentBlobId,
  type Paint,
  type Scene,
  type SceneNode,
  type Slide,
} from "@figbridge/scene";
import { getDocument, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { groupCards } from "./cards.js";
import {
  type CompositeSources,
  compositeLayer,
  type DecodedImage,
  type ShadingIR,
} from "./compositor.js";
import {
  interpret,
  type PathPrimitive,
  type Primitive,
  type ShadingPrimitive,
} from "./interpret.js";
import { apply, toMatrix } from "./matrix.js";
import { asRoundedRect, type Box, bounds } from "./path.js";
import { area, clipBox, intersect, mergeRuns, toRect, toVector, visibleBox } from "./shapes.js";
import {
  buildLines,
  buildParagraphs,
  dedupeGlyphs,
  paragraphToNode,
  repairLigatures,
} from "./text.js";

export interface ImportOptions {
  /** Output slide width in px; height follows the page aspect ratio. Default 1920. */
  width?: number;
  /** 1-based page numbers to import; default all. */
  pages?: readonly number[];
  /** Upper bound on raster resolution relative to slide pixels. Default 3. */
  maxRasterScale?: number;
  onPage?: (done: number, total: number) => void;
}

export interface ImportResult {
  scene: Scene;
  /** Images referenced by the scene, keyed by content-addressed blob id. */
  blobs: Map<string, { bytes: Uint8Array; mimeType: string }>;
  warnings: string[];
}

/** Background detection: a plain rectangle covering at least this share of the page. */
const BACKGROUND_COVERAGE = 0.98;
/**
 * pdf.js loads its image decoders (JBIG2, JPEG 2000 — common in scans), CJK character maps
 * and the standard 14 fonts from these folders; in Node they must be given as paths.
 */
const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const PDFJS_ASSETS = {
  wasmUrl: `${join(PDFJS_ROOT, "wasm")}/`,
  cMapUrl: `${join(PDFJS_ROOT, "cmaps")}/`,
  cMapPacked: true,
  standardFontDataUrl: `${join(PDFJS_ROOT, "standard_fonts")}/`,
};

/** Minimum raster scale: crisp on retina displays even for low-res sources. */
const MIN_RASTER_SCALE = 2;
/** Figma's createImage rejects images larger than this on either side. */
const FIGMA_MAX_IMAGE_SIDE = 4096;

export async function importPdf(
  data: Uint8Array,
  name: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const loading = getDocument({ data, verbosity: 0, ...PDFJS_ASSETS });
  const document = await loading.promise;
  try {
    const numbers = options.pages ?? Array.from({ length: document.numPages }, (_, i) => i + 1);
    const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
    const warnings: string[] = [];
    const slides: Slide[] = [];
    for (const [index, number] of numbers.entries()) {
      if (number < 1 || number > document.numPages)
        throw new RangeError(`Page ${String(number)} does not exist.`);
      const page = await document.getPage(number);
      slides.push(await importPage(page, number, options, blobs, warnings));
      page.cleanup();
      options.onPage?.(index + 1, numbers.length);
    }
    return {
      scene: { version: 1, source: { kind: "pdf", name, pages: document.numPages }, slides },
      blobs,
      warnings,
    };
  } finally {
    await loading.destroy();
  }
}

async function importPage(
  page: PDFPageProxy,
  number: number,
  options: ImportOptions,
  blobs: ImportResult["blobs"],
  warnings: string[],
): Promise<Slide> {
  const width = options.width ?? 1920;
  const pageWidth = (page.view[2] ?? width) - (page.view[0] ?? 0);
  const viewport = page.getViewport({ scale: width / pageWidth });
  const operatorList = await page.getOperatorList();
  const { primitives, masks } = interpret(
    operatorList.fnArray,
    operatorList.argsArray,
    toMatrix(viewport.transform),
    (id) => ({ name: fontName(page, id) }),
  );

  let counter = 0;
  const nextId = () => `p${String(number)}_${String(++counter)}`;
  const slideBox: Box = { x0: 0, y0: 0, x1: viewport.width, y1: viewport.height };

  // ── background ────────────────────────────────────────────────────────────
  let background: Paint[] = [{ type: "solid", color: "#FFFFFF", opacity: 1 }];
  const firstIndex = primitives.findIndex((p) => p.kind === "path" && !p.raster);
  const first = primitives[firstIndex];
  if (first?.kind === "path" && first.fill !== undefined && isPageRect(first, slideBox)) {
    background = [
      { type: "solid", color: first.fill.color.toUpperCase(), opacity: first.fill.alpha },
    ];
    primitives.splice(firstIndex, 1);
  }

  // ── classify ──────────────────────────────────────────────────────────────
  const ordered: { order: number; node: SceneNode }[] = [];
  const glyphs = primitives.flatMap((p) => (p.kind === "text" ? p.glyphs : []));
  const raster: { primitive: Primitive; box: Box }[] = [];
  const vectors: PathPrimitive[] = [];

  for (const primitive of primitives) {
    if (primitive.kind === "text") continue;
    const box = primitive.kind === "shading" ? clipBox(primitive.clips) : primitive.box;
    if (box === undefined) continue;
    const visible = intersect(
      visibleBox(box, primitive.clips) ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
      slideBox,
    );
    if (visible === undefined) continue;
    if (primitive.kind === "shading" && !primitive.raster) {
      const gradient = gradientRect(primitive, visible, page, nextId);
      if (gradient !== undefined) {
        ordered.push({ order: primitive.op, node: gradient });
        continue;
      }
    }
    if (primitive.kind === "path" && isInvisible(primitive)) continue;
    if (primitive.kind === "path" && !primitive.raster) vectors.push(primitive);
    else raster.push({ primitive, box: visible });
  }

  // ── vectors ───────────────────────────────────────────────────────────────
  for (const run of mergeRuns(dedupe(vectors))) {
    const [head] = run;
    if (head === undefined) continue;
    const visible = visibleBox(head.box, head.clips) ?? head.box;
    const node =
      run.length === 1
        ? (toRect(head, nextId(), visible) ?? toVector(run, nextId()))
        : toVector(run, nextId());
    if (node !== undefined) ordered.push({ order: head.op, node });
  }

  // ── raster layers ─────────────────────────────────────────────────────────
  const sources = await rasterSources(page, primitives, masks, warnings);
  // Everything painted natively (vectors, gradient rects) can seal a raster zone.
  const vectorBoxes = [
    ...vectors.map((v) => ({ op: v.op, box: v.box })),
    ...ordered.map((o) => ({
      op: o.order,
      box:
        o.node.type === "group"
          ? { x0: 0, y0: 0, x1: 0, y1: 0 }
          : { x0: o.node.x, y0: o.node.y, x1: o.node.x + o.node.w, y1: o.node.y + o.node.h },
    })),
  ];
  for (const zone of clusterZones(raster, vectorBoxes)) {
    const scale = rasterScale(
      zone.items.map((i) => i.primitive),
      sources,
      Math.min(
        options.maxRasterScale ?? 3,
        (FIGMA_MAX_IMAGE_SIDE - 1) /
          Math.max(zone.box.x1 - zone.box.x0, zone.box.y1 - zone.box.y0, 1),
      ),
    );
    const layer = compositeLayer(
      zone.items.map((i) => i.primitive),
      zone.box,
      scale,
      sources,
    );
    if (layer === undefined) continue;
    const blob = contentBlobId(layer.png);
    blobs.set(blob, { bytes: layer.png, mimeType: "image/png" });
    ordered.push({
      order: Math.min(...zone.items.map((i) => i.primitive.op)),
      node: {
        id: nextId(),
        name: zone.items.some((i) => i.primitive.kind === "image") ? "image" : "effect",
        type: "image",
        x: round(layer.box.x0),
        y: round(layer.box.y0),
        w: round(layer.box.x1 - layer.box.x0),
        h: round(layer.box.y1 - layer.box.y0),
        rotation: 0,
        flipX: false,
        flipY: false,
        opacity: 1,
        visible: true,
        image: { type: "image", blob, scaleMode: "fill", opacity: 1 },
        radii: [0, 0, 0, 0],
        strokes: [],
      },
    });
  }

  // ── text (always on top: PDFs paint text last in practice) ────────────────
  const textNodes = buildParagraphs(buildLines(dedupeGlyphs(repairLigatures(glyphs))))
    .map((paragraph) => paragraphToNode(paragraph, nextId()))
    .filter((node) => node !== undefined);
  if (glyphs.some((g) => !g.upright))
    warnings.push(`page ${String(number)}: rotated text was skipped`);

  // FIGBRIDGE_DEBUG_OPS=1 appends the painting operator index to layer names (debugging order).
  const debugOps = process.env["FIGBRIDGE_DEBUG_OPS"] === "1";
  const sorted = ordered.sort((a, b) => a.order - b.order);
  if (debugOps) for (const o of sorted) o.node.name = `${o.node.name} @${String(o.order)}`;
  const nodes = [...sorted.map((o) => o.node), ...textNodes];
  return {
    name: String(number).padStart(2, "0"),
    width: round(viewport.width),
    height: round(viewport.height),
    background,
    children: groupCards(nodes, area(slideBox), nextId),
  };
}

/** Fully transparent shapes (hit areas, placeholders in exported decks) are not layers. */
function isInvisible(p: PathPrimitive): boolean {
  return (
    (p.fill === undefined || p.fill.alpha === 0) && (p.stroke === undefined || p.stroke.alpha === 0)
  );
}

function isPageRect(p: PathPrimitive, slide: Box): boolean {
  const rect = asRoundedRect(p.segments);
  if (rect === undefined || rect.radii.some((r) => r > 0)) return false;
  const covered = intersect(rect.box, slide);
  return covered !== undefined && area(covered) >= BACKGROUND_COVERAGE * area(slide);
}

/** Identical shapes painted twice (common in exported decks) would double opacity and clutter layers. */
function dedupe(paths: readonly PathPrimitive[]): PathPrimitive[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = JSON.stringify([p.box, p.fill, p.stroke, p.segments.length]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fontName(page: PDFPageProxy, id: string): string {
  try {
    const font = page.commonObjs.get(id) as { name?: string } | undefined;
    return font?.name ?? id;
  } catch {
    return id;
  }
}

/** A plain (unmasked) axial shading clipped to a rectangle → a rectangle with a linear gradient. */
function gradientRect(
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

/** pdf.js keeps objects shared across pages (ids starting with "g_") in `commonObjs`. */
function storeFor(page: PDFPageProxy, id: string) {
  return id.startsWith("g_") ? page.commonObjs : page.objs;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of pdf.js's untyped object store
function getObject<T>(page: PDFPageProxy, id: string): T | undefined {
  try {
    // Objects pdf.js failed to decode resolve to null.
    return (storeFor(page, id).get(id) as T | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolve once pdf.js has decoded the object, or after `timeoutMs` (reported as missing). */
function whenResolved(page: PDFPageProxy, id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    storeFor(page, id).get(id, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** How long to wait for pdf.js to decode one image before giving up on it. */
const IMAGE_DECODE_TIMEOUT_MS = 15_000;

async function rasterSources(
  page: PDFPageProxy,
  primitives: readonly Primitive[],
  masks: CompositeSources["masks"],
  warnings: string[],
): Promise<CompositeSources> {
  // Make sure every referenced image object is resolved before synchronous compositing.
  const ids = new Set<string>();
  const collect = (list: readonly Primitive[]) => {
    for (const p of list) if (p.kind === "image" && "objId" in p.source) ids.add(p.source.objId);
  };
  collect(primitives);
  for (const mask of masks.values()) collect(mask.primitives);
  const resolved = await Promise.all(
    [...ids].map((id) => whenResolved(page, id, IMAGE_DECODE_TIMEOUT_MS)),
  );
  const missing = resolved.filter((ok) => !ok).length;
  if (missing > 0)
    warnings.push(
      `page ${String(page.pageNumber)}: ${String(missing)} image(s) could not be decoded`,
    );
  return {
    masks,
    image: (source) =>
      "objId" in source
        ? getObject<DecodedImage>(page, source.objId)
        : (source.inline as DecodedImage | undefined),
    shading: (pattern) => getObject<ShadingIR>(page, pattern),
  };
}

/** Resolution that keeps the sharpest source image at (at least) its native pixel density. */
function rasterScale(items: readonly Primitive[], sources: CompositeSources, max: number): number {
  let scale = Math.min(MIN_RASTER_SCALE, max);
  for (const item of items) {
    if (item.kind !== "image") continue;
    const image = sources.image(item.source);
    const width = item.box.x1 - item.box.x0;
    if (image !== undefined && width > 0) scale = Math.max(scale, image.width / width);
  }
  return Math.min(scale, max);
}

type RasterItem = { primitive: Primitive; box: Box };
type Zone = { box: Box; items: RasterItem[]; firstOp: number; lastOp: number };

/**
 * Union overlapping raster items into zones; each zone becomes one image layer.
 *
 * A zone must not span a vector painted in between that overlaps it: one bitmap cannot be
 * both below and above that vector. Such a vector "seals" the zone, and later raster items
 * start a new zone (a new layer above the vector).
 */
function clusterZones(
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

function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

// Re-exported for tests.
export { bounds };
