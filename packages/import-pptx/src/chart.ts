/**
 * Charts → editable layers. Clustered column charts are rebuilt natively (bars, value
 * labels, category labels, axis line) from the chart part's cached values. Other chart
 * types are reported and skipped.
 */
import type { Paint, SceneNode, TextNode } from "@figbridge/scene";
import { resolveColor } from "./color.js";
import { ptToPx, resolveTypeface, round, type SlideContext } from "./context.js";
import { fillElement, paintsOf } from "./fill.js";
import { parseFontStyle } from "./fonts.js";
import type { Box } from "./transform.js";
import { attr, child, childrenOf, find, findAll, num, type XmlElement } from "./xml.js";

/**
 * Plot area as fractions of the chart frame. PowerPoint auto-layouts charts; these match its
 * render for titleless clustered column charts (measured on reference decks).
 */
const PLOT = { left: 0.01, right: 0.99, top: 0.13, bottom: 0.876, labelGap: 0.035 } as const;
const DEFAULT_BAR: Paint = { type: "solid", color: "#4472C4", opacity: 1 };

interface TextStyle {
  sizePx: number;
  bold: boolean;
  font: string;
  fill: Paint | undefined;
}

function textStyle(ctx: SlideContext, el: XmlElement | undefined): TextStyle | undefined {
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

export function chartNodes(
  ctx: SlideContext,
  chartRef: XmlElement,
  frame: Box,
  name: string,
  part: string,
): SceneNode[] {
  const target = ctx.pkg.rels(part).internal.get(attr(chartRef, "r:id") ?? "");
  const chartPart = target === undefined ? undefined : ctx.pkg.xml(target);
  const bar = find(chartPart, "barChart");
  const isColumn = attr(child(bar, "barDir"), "val") === "col";
  const grouping = attr(child(bar, "grouping"), "val") ?? "clustered";
  if (bar === undefined || target === undefined || !isColumn || grouping !== "clustered") {
    ctx.warn(
      `slide ${String(ctx.slideNumber)}: chart "${name}" is not a clustered column chart and was skipped`,
    );
    return [];
  }
  const series = childrenOf(bar, "ser").map((ser) => {
    const values = new Map<number, number>();
    for (const pt of findAll(child(ser, "val"), "pt"))
      values.set(num(pt, "idx", 0), Number(child(pt, "v")?.text ?? "0"));
    const fill = fillElement(child(ser, "spPr"));
    const labels = child(ser, "dLbls");
    const showValue = attr(child(labels, "showVal"), "val") === "1";
    return {
      name: find(child(ser, "tx"), "v")?.text ?? "",
      values,
      fill: (fill === undefined ? [] : paintsOf(ctx, target, fill))[0] ?? DEFAULT_BAR,
      label: showValue ? textStyle(ctx, labels) : undefined,
    };
  });
  const first = childrenOf(bar, "ser")[0];
  const categories = findAll(child(first, "cat"), "pt").map((pt) => child(pt, "v")?.text ?? "");
  const max = Math.max(0, ...series.flatMap((s) => [...s.values.values()]));
  if (series.length === 0 || categories.length === 0 || max <= 0) return [];

  const gap = num(child(bar, "gapWidth"), "val", 150) / 100;
  const overlap = num(child(bar, "overlap"), "val", 0) / 100;
  const top = niceMax(max);
  const left = frame.x + frame.w * PLOT.left;
  const right = frame.x + frame.w * PLOT.right;
  const plotTop = frame.y + frame.h * PLOT.top;
  const plotBottom = frame.y + frame.h * PLOT.bottom;
  const categoryWidth = (right - left) / categories.length;
  const barWidth = categoryWidth / (series.length - (series.length - 1) * overlap + gap);
  const catAxis = find(chartPart, "catAx");
  const catStyle =
    attr(child(catAxis, "delete"), "val") === "1" ? undefined : textStyle(ctx, catAxis);

  const nodes: SceneNode[] = [];
  categories.forEach((category, ci) => {
    const groupX = left + ci * categoryWidth + (gap * barWidth) / 2;
    series.forEach((s, si) => {
      const value = s.values.get(ci);
      if (value === undefined) return;
      const x = groupX + si * barWidth * (1 - overlap);
      const h = ((plotBottom - plotTop) * value) / top;
      nodes.push(rect(ctx, `${s.name} · ${category}`, x, plotBottom - h, barWidth, h, [s.fill]));
      if (s.label !== undefined) {
        const style = { ...s.label, fill: s.label.fill ?? s.fill };
        nodes.push(
          label(
            ctx,
            formatValue(value),
            x - barWidth * 0.25,
            plotBottom - h - style.sizePx * 1.6,
            barWidth * 1.5,
            style,
          ),
        );
      }
    });
    if (catStyle !== undefined) {
      nodes.push(
        label(
          ctx,
          category,
          left + ci * categoryWidth,
          plotBottom + frame.h * PLOT.labelGap,
          categoryWidth,
          catStyle,
        ),
      );
    }
  });
  const axisLine = find(child(catAxis, "spPr"), "ln");
  const axisColor = resolveColor(child(axisLine, "solidFill"), ctx.colors);
  if (axisColor !== undefined) {
    const weight = Math.max(0.5, num(axisLine, "w", 9525) * ctx.scale);
    nodes.push(
      rect(ctx, "axis", frame.x, plotBottom - weight / 2, frame.w, weight, [
        { type: "solid", color: axisColor.color, opacity: axisColor.alpha },
      ]),
    );
  }
  return [{ id: ctx.nextId(), name, type: "group", opacity: 1, visible: true, children: nodes }];
}

/** Axis maximum PowerPoint would choose: a 1/2/5 step giving at most 7 gridlines. */
export function niceMax(max: number): number {
  let step = 10 ** Math.floor(Math.log10(max / 5));
  for (const m of [1, 2, 5, 10]) {
    if (max / (step * m) <= 7) {
      step *= m;
      break;
    }
  }
  return Math.ceil((max * 1.05) / step) * step;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function rect(
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

function label(
  ctx: SlideContext,
  text: string,
  x: number,
  y: number,
  w: number,
  style: TextStyle,
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
    align: "center",
    verticalAlign: "top",
    sizing: "fixed",
  };
}
