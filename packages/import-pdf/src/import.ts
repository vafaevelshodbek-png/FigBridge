/**
 * PDF → Scene: the importer pipeline.
 *
 *   operator list ─interpret→ primitives ─┬─ text      → paragraphs → text nodes
 *                                          ├─ vectors   → rects (radii) / vectors
 *                                          ├─ shadings  → gradient rects (simple) or raster
 *                                          └─ raster    → composited PNG layers (images, masks)
 *   then background → frame fill, cards group their content.
 */
import {
  contentBlobId,
  type Paint,
  type Scene,
  type SceneNode,
  type Slide,
} from "@figbridge/scene";
import { getDocument, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { groupCards } from "./cards.js";
import { dedupe, gradientRect, isInvisible, isPageRect } from "./classify.js";
import { compositeLayer } from "./compositor.js";
import { interpret } from "./interpret.js";
import { toMatrix } from "./matrix.js";
import { asRoundedRect, type Box, bounds } from "./path.js";
import { fontName, PDFJS_ASSETS, rasterSources } from "./pdfjs.js";
import type { PathPrimitive, Primitive } from "./primitives.js";
import { clusterZones, FIGMA_MAX_IMAGE_SIDE, rasterScale } from "./raster.js";
import { round } from "./round.js";
import { area, clipBox, intersect, mergeRuns, toRect, toVector, visibleBox } from "./shapes.js";
import {
  buildLines,
  buildParagraphs,
  dedupeGlyphs,
  dropCovered,
  type Occluder,
  paragraphToNode,
  repairLigatures,
} from "./text.js";

/** Slide width the grouping heuristics were tuned at; other widths scale them. */
const REFERENCE_WIDTH = 1920;

/** Fill opacity at which a shape hides what is under it. */
const OPAQUE = 0.99;

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
  const width = options.width ?? REFERENCE_WIDTH;
  // Grouping thresholds are tuned in px at REFERENCE_WIDTH; scale them with the output.
  const unit = width / REFERENCE_WIDTH;
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
  for (const run of mergeRuns(dedupe(vectors), unit)) {
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
  const occluders = primitives.flatMap((p): Occluder[] => {
    if (p.kind !== "path" || p.fill === undefined || p.fill.alpha < OPAQUE || p.alpha < OPAQUE)
      return [];
    const rect = asRoundedRect(p.segments);
    if (rect === undefined) return [];
    const visible = visibleBox(rect.box, p.clips);
    return visible === undefined ? [] : [{ op: p.op, ...visible }];
  });
  const shown = dropCovered(dedupeGlyphs(repairLigatures(glyphs)), occluders);
  const textNodes = buildParagraphs(buildLines(shown), unit)
    .map((paragraph) => paragraphToNode(paragraph, nextId(), unit))
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

// Re-exported for tests.
export { bounds };
