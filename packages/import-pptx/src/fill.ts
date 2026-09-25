/**
 * DrawingML fills and outlines → Scene paints and strokes.
 *
 * Resolution order for a shape: its own `spPr` fill, then the theme style matrix entry the
 * shape's `p:style` references (`fillRef`/`lnRef`, with `phClr` bound to the reference colour).
 * `undefined` means "not specified here" (inherit); `[]` means an explicit `noFill`.
 */
import type { Paint, Stroke } from "@figbridge/scene";
import { type Rgba, resolveColor } from "./color.js";
import type { SlideContext } from "./context.js";
import { blipFillPaint, storeBlob } from "./images.js";
import { EMU_PER_PATTERN_PIXEL, patternTile } from "./pattern.js";
import { DEGREE, PERCENT } from "./units.js";
import { attr, child, childrenOf, num, type XmlElement } from "./xml.js";

/** Default outline width when neither the shape nor the theme gives one: 0.75 pt. */
const DEFAULT_LINE_EMU = 9525;

/** Dash presets as multiples of the line width (PowerPoint's proportions). */
const DASH: Readonly<Record<string, readonly number[]>> = {
  dash: [4, 3],
  sysDash: [3, 1],
  sysDot: [1, 1],
  dot: [1, 1],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  sysDashDot: [3, 1, 1, 1],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

const FILL_ELEMENTS = new Set([
  "noFill",
  "solidFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
]);

/** The first fill element among `props`' children, if any. */
export function fillElement(props: XmlElement | undefined): XmlElement | undefined {
  return props?.children.find((c) => FILL_ELEMENTS.has(c.name));
}

/** Convert one fill element to paints. `placeholder` binds `phClr`. */
export function paintsOf(
  ctx: SlideContext,
  part: string,
  fill: XmlElement,
  placeholder?: Rgba,
): Paint[] {
  switch (fill.name) {
    case "noFill":
      return [];
    case "solidFill": {
      const c = resolveColor(fill, ctx.colors, placeholder);
      return c === undefined ? [] : [solid(c)];
    }
    case "gradFill":
      return gradientOf(ctx, fill, placeholder);
    case "blipFill": {
      const paint = blipFillPaint(ctx, part, fill);
      return paint === undefined ? [] : [paint];
    }
    case "pattFill": {
      const fg = resolveColor(child(fill, "fgClr"), ctx.colors, placeholder) ?? BLACK;
      const bg = resolveColor(child(fill, "bgClr"), ctx.colors, placeholder) ?? WHITE;
      const png = patternTile(attr(fill, "prst") ?? "pct50", fg, bg);
      const blob = storeBlob(ctx, png, "image/png");
      const tileScale = Math.max(0.01, EMU_PER_PATTERN_PIXEL * ctx.scale);
      return [{ type: "image", blob, scaleMode: "tile", tileScale, opacity: 1 }];
    }
    case "grpFill":
      return ctx.groupFills[ctx.groupFills.length - 1] ?? [];
    default:
      return [];
  }
}

const BLACK: Rgba = { color: "#000000", alpha: 1 };
const WHITE: Rgba = { color: "#FFFFFF", alpha: 1 };

export function solid(c: Rgba): Paint {
  return { type: "solid", color: c.color, opacity: c.alpha };
}

/**
 * Shape fill from `spPr`, else from the style's `fillRef` into the theme's fill styles
 * (indices 1–999 → `fillStyleLst`, 1001+ → `bgFillStyleLst`; 0 means no fill).
 */
export function shapeFill(
  ctx: SlideContext,
  part: string,
  spPr: XmlElement | undefined,
  style: XmlElement | undefined,
): Paint[] | undefined {
  const own = fillElement(spPr);
  if (own !== undefined) return paintsOf(ctx, part, own);
  const ref = child(style, "fillRef");
  return ref === undefined ? undefined : themeFill(ctx, part, ref);
}

/** Resolve a `fillRef`/`bgRef` element against the theme's format scheme. */
export function themeFill(ctx: SlideContext, part: string, ref: XmlElement): Paint[] {
  const idx = num(ref, "idx", 0);
  const color = resolveColor(ref, ctx.colors);
  if (idx === 0) return [];
  const list = idx >= 1000 ? ctx.theme.bgFillStyles : ctx.theme.fillStyles;
  const entry = list[(idx >= 1000 ? idx - 1000 : idx) - 1];
  if (entry !== undefined && FILL_ELEMENTS.has(entry.name))
    return paintsOf(ctx, part, entry, color);
  return color === undefined ? [] : [solid(color)];
}

function gradientOf(ctx: SlideContext, fill: XmlElement, placeholder?: Rgba): Paint[] {
  const stops = childrenOf(child(fill, "gsLst"), "gs")
    .map((gs) => {
      const c = resolveColor(gs, ctx.colors, placeholder);
      return c === undefined
        ? undefined
        : {
            position: Math.min(1, Math.max(0, num(gs, "pos", 0) / PERCENT)),
            color: c.color,
            opacity: c.alpha,
          };
    })
    .filter((s) => s !== undefined)
    .sort((a, b) => a.position - b.position);
  const [first] = stops;
  if (first === undefined) return [];
  if (stops.length === 1) stops.push({ ...first, position: 1 });
  const path = child(fill, "path");
  if (path !== undefined) {
    const rect = child(path, "fillToRect");
    const cx = (num(rect, "l", 50_000) + PERCENT - num(rect, "r", 50_000)) / 2 / PERCENT;
    const cy = (num(rect, "t", 50_000) + PERCENT - num(rect, "b", 50_000)) / 2 / PERCENT;
    // The gradient reaches the farthest corner of the shape.
    const rx = Math.max(cx, 1 - cx);
    const ry = Math.max(cy, 1 - cy);
    const radius = attr(path, "path") === "circle" ? Math.hypot(rx, ry) : Math.max(rx, ry);
    return [
      { type: "radial-gradient", center: [cx, cy], radius: [radius, radius], stops, opacity: 1 },
    ];
  }
  const [from, to] = linearEnds(num(child(fill, "lin"), "ang", 90 * DEGREE) / DEGREE);
  return [{ type: "linear-gradient", from, to, stops, opacity: 1 }];
}

/**
 * Gradient end points in the unit square for an OOXML angle (degrees clockwise from +x):
 * the gradient spans the square's projection onto the direction, so corners get the end stops.
 */
export function linearEnds(degrees: number): [[number, number], [number, number]] {
  const a = (degrees * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(dx) + Math.abs(dy)) / 2;
  const r = (n: number) => Math.round(n * 10_000) / 10_000;
  return [
    [r(0.5 - dx * half), r(0.5 - dy * half)],
    [r(0.5 + dx * half), r(0.5 + dy * half)],
  ];
}

/** Resolved outline: Scene stroke plus the arrowheads DrawingML attaches to line ends. */
export interface Outline {
  stroke: Stroke;
  head: ArrowEnd | undefined;
  tail: ArrowEnd | undefined;
}

export interface ArrowEnd {
  type: string;
  /** Size multipliers relative to the line width. */
  width: number;
  length: number;
}

/** Outline from `spPr/a:ln`, falling back to the style's `lnRef` theme line. */
export function shapeOutline(
  ctx: SlideContext,
  part: string,
  spPr: XmlElement | undefined,
  style: XmlElement | undefined,
): Outline | undefined {
  const ln = child(spPr, "ln");
  const ref = child(style, "lnRef");
  const refIdx = num(ref, "idx", 0);
  const themeLine = refIdx > 0 ? ctx.theme.lineStyles[refIdx - 1] : undefined;
  const refColor = ref === undefined ? undefined : resolveColor(ref, ctx.colors);

  const ownFill = fillElement(ln);
  let paints: Paint[] | undefined;
  if (ownFill !== undefined) paints = paintsOf(ctx, part, ownFill);
  else if (themeLine !== undefined) {
    const themeFillEl = fillElement(themeLine);
    paints =
      themeFillEl === undefined
        ? refColor && [solid(refColor)]
        : paintsOf(ctx, part, themeFillEl, refColor);
  }
  const paint = paints?.[0];
  if (paint === undefined) return undefined;

  const widthEmu = num(ln, "w", num(themeLine, "w", DEFAULT_LINE_EMU));
  // w="0" is a hairline: one device pixel.
  const weight = widthEmu > 0 ? widthEmu * ctx.scale : 1;
  const dashName = attr(child(ln, "prstDash") ?? child(themeLine, "prstDash"), "val");
  const dash = dashName === undefined ? undefined : DASH[dashName];
  const cap = attr(ln, "cap") ?? attr(themeLine, "cap");
  const joinEl = [ln, themeLine]
    .flatMap((l) => l?.children ?? [])
    .find((c) => c.name === "round" || c.name === "bevel" || c.name === "miter");
  const stroke: Stroke = {
    paint: paint.type === "image" ? { type: "solid", color: "#000000", opacity: 1 } : paint,
    weight,
    align: "center",
    cap: cap === "rnd" ? "round" : cap === "sq" ? "square" : "none",
    join: joinEl?.name === "round" ? "round" : joinEl?.name === "bevel" ? "bevel" : "miter",
    ...(dash === undefined ? {} : { dash: dash.map((d) => d * weight) }),
  };
  return { stroke, head: arrowEnd(child(ln, "headEnd")), tail: arrowEnd(child(ln, "tailEnd")) };
}

const ARROW_SIZE: Readonly<Record<string, number>> = { sm: 2, med: 3, lg: 5 };

function arrowEnd(el: XmlElement | undefined): ArrowEnd | undefined {
  const type = attr(el, "type");
  if (type === undefined || type === "none") return undefined;
  return {
    type,
    width: ARROW_SIZE[attr(el, "w") ?? "med"] ?? 3,
    length: ARROW_SIZE[attr(el, "len") ?? "med"] ?? 3,
  };
}
