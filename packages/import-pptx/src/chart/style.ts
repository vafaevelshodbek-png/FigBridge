/**
 * Shared chart drawing: text styles, series colours, and the rectangle/label nodes every chart type emits.
 */
import type { Paint, SceneNode, TextNode } from "@figbridge/scene";
import { resolveColor } from "../color.js";
import { ptToPx, resolveTypeface, round, type SlideContext } from "../context.js";
import { fillElement, paintsOf } from "../fill.js";
import { parseFontStyle } from "../fonts.js";
import { attr, child, find, num, type XmlElement } from "../xml.js";

/**
 * Plot area as fractions of the chart frame. PowerPoint auto-layouts charts; these match its
 * render for titleless clustered column charts (measured on reference decks).
 */
export const PLOT = { left: 0.01, right: 0.99, top: 0.13, bottom: 0.876, labelGap: 0.035 } as const;

export const DEFAULT_BAR: Paint = { type: "solid", color: "#4472C4", opacity: 1 };

export interface TextStyle {
  sizePx: number;
  bold: boolean;
  font: string;
  fill: Paint | undefined;
}

export function textStyle(ctx: SlideContext, el: XmlElement | undefined): TextStyle | undefined {
  const def = find(child(el, "txPr"), "defRPr");
  if (def === undefined) return undefined;
  const color = resolveColor(child(def, "solidFill"), ctx.colors);
  return {
    sizePx: ptToPx(ctx, num(def, "sz", 1000) / 100),
    bold: attr(def, "b") === "1",
    font: resolveTypeface(ctx.theme, attr(child(def, "latin"), "typeface")) ?? ctx.theme.minorFont,
    fill:
      color === undefined ? undefined : { type: "solid", color: color.color, opacity: color.alpha },
  };
}

export interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Office default series colours: the theme's accent1…accent6. */
export function accent(ctx: SlideContext, index: number): Paint {
  const scheme: XmlElement = {
    name: "schemeClr",
    attrs: { val: `accent${String((index % 6) + 1)}` },
    children: [],
    text: "",
  };
  const color = resolveColor(
    { name: "solidFill", attrs: {}, children: [scheme], text: "" },
    ctx.colors,
  );
  return color === undefined
    ? DEFAULT_BAR
    : { type: "solid", color: color.color, opacity: color.alpha };
}

export function firstPaint(
  ctx: SlideContext,
  target: string,
  el: XmlElement | undefined,
): Paint | undefined {
  const fill = fillElement(el);
  return fill === undefined ? undefined : paintsOf(ctx, target, fill)[0];
}

export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function rect(
  ctx: SlideContext,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fills: Paint[],
): SceneNode {
  return {
    id: ctx.nextId(),
    name,
    type: "rect",
    x: round(x),
    y: round(y),
    w: round(Math.max(w, 0.01)),
    h: round(Math.max(h, 0.01)),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    fills,
    strokes: [],
    radii: [0, 0, 0, 0],
  };
}

export function label(
  ctx: SlideContext,
  text: string,
  x: number,
  y: number,
  w: number,
  style: TextStyle,
  align: "left" | "center" | "right" = "center",
): TextNode {
  const { family, style: fontStyle } = parseFontStyle(style.font, style.bold, false);
  return {
    id: ctx.nextId(),
    name: text,
    type: "text",
    x: round(x),
    y: round(y),
    w: round(w),
    h: round(style.sizePx * 1.4),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    characters: text,
    runs: [
      {
        start: 0,
        end: text.length,
        fontFamily: family,
        fontStyle,
        fontSize: round(style.sizePx),
        fill: style.fill ?? { type: "solid", color: "#141414", opacity: 1 },
        letterSpacing: 0,
        textCase: "original",
        decoration: "none",
      },
    ],
    paragraphs: [],
    align,
    verticalAlign: "top",
    sizing: "fixed",
  };
}
