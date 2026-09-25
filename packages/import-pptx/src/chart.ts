/**
 * Charts → editable layers rebuilt natively from the chart part's cached values: bar and
 * column charts (clustered, stacked, 100% stacked), line charts, pie and doughnut charts.
 * Other chart types are reported and skipped.
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

interface Series {
  name: string;
  values: Map<number, number>;
  fill: Paint;
  /** Per-point fills (`c:dPt`), e.g. pie slices. */
  pointFills: Map<number, Paint>;
  label: TextStyle | undefined;
}

interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Office default series colours: the theme's accent1…accent6. */
function accent(ctx: SlideContext, index: number): Paint {
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

function firstPaint(
  ctx: SlideContext,
  target: string,
  el: XmlElement | undefined,
): Paint | undefined {
  const fill = fillElement(el);
  return fill === undefined ? undefined : paintsOf(ctx, target, fill)[0];
}

function readSeries(ctx: SlideContext, plot: XmlElement, target: string): Series[] {
  return childrenOf(plot, "ser").map((ser, index) => {
    const values = new Map<number, number>();
    for (const pt of findAll(child(ser, "val"), "pt"))
      values.set(num(pt, "idx", 0), Number(child(pt, "v")?.text ?? "0"));
    const pointFills = new Map<number, Paint>();
    for (const dPt of childrenOf(ser, "dPt")) {
      const paint = firstPaint(ctx, target, child(dPt, "spPr"));
      if (paint !== undefined) pointFills.set(num(child(dPt, "idx"), "val", 0), paint);
    }
    const spPr = child(ser, "spPr");
    const labels = child(ser, "dLbls");
    const showValue = attr(child(labels, "showVal"), "val") === "1";
    return {
      name: find(child(ser, "tx"), "v")?.text ?? "",
      values,
      // Line series carry their colour on the outline.
      fill:
        firstPaint(ctx, target, spPr) ??
        firstPaint(ctx, target, child(spPr, "ln")) ??
        accent(ctx, num(child(ser, "idx"), "val", index)),
      pointFills,
      label: showValue ? textStyle(ctx, labels) : undefined,
    };
  });
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
  const typed = find(chartPart, "plotArea")?.children.find((c) => c.name.endsWith("Chart"));
  if (target === undefined || typed === undefined) {
    ctx.warn(`slide ${String(ctx.slideNumber)}: chart "${name}" could not be read and was skipped`);
    return [];
  }
  const series = readSeries(ctx, typed, target);
  const categories = findAll(child(childrenOf(typed, "ser")[0], "cat"), "pt").map(
    (pt) => child(pt, "v")?.text ?? "",
  );
  const plot: Plot = {
    left: frame.x + frame.w * PLOT.left,
    right: frame.x + frame.w * PLOT.right,
    top: frame.y + frame.h * PLOT.top,
    bottom: frame.y + frame.h * PLOT.bottom,
  };
  const chart = child(chartPart, "chart");
  const isPie = PIE_CHARTS.has(typed.name);
  const decoration: SceneNode[] = [];
  // Elements without their own txPr use the chart-wide default (Office: 10pt).
  const base: TextStyle = textStyle(ctx, chartPart) ?? {
    sizePx: ptToPx(ctx, 10),
    bold: false,
    font: ctx.theme.minorFont,
    fill: undefined,
  };
  const title = titleNode(ctx, chart, series, frame, base);
  if (title !== undefined) {
    decoration.push(title);
    plot.top = Math.max(plot.top, title.y + title.h + frame.h * 0.03);
  }
  const legendEntries = isPie
    ? categories.map((category, i) => {
        const s = series[0];
        const pieFill =
          s?.pointFills.get(i) ??
          (attr(child(typed, "varyColors"), "val") !== "0" ? accent(ctx, i) : s?.fill);
        return { name: category, fill: pieFill ?? DEFAULT_BAR };
      })
    : series.map((s) => ({ name: s.name, fill: s.fill }));
  const legend = legendNodes(ctx, child(chart, "legend"), legendEntries, frame, plot, base);
  decoration.push(...legend.nodes);
  plot.right = Math.min(plot.right, legend.left);
  if (typed.name === "barChart" || typed.name === "bar3DChart") {
    if (attr(child(typed, "barDir"), "val") === "bar")
      decoration.push(...barCategoryLabels(ctx, chartPart, categories, plot, base));
  }
  let nodes: SceneNode[];
  switch (typed.name) {
    case "barChart":
    case "bar3DChart":
      nodes = barNodes(ctx, chartPart, typed, series, categories, frame, plot);
      break;
    case "lineChart":
    case "line3DChart":
      nodes = lineNodes(ctx, chartPart, series, categories, frame, plot);
      break;
    case "pieChart":
    case "pie3DChart":
    case "doughnutChart":
      nodes = pieNodes(ctx, typed, series, {
        ...frame,
        x: plot.left,
        y: plot.top,
        w: plot.right - plot.left,
        h: frame.y + frame.h - plot.top,
      });
      break;
    default:
      ctx.warn(
        `slide ${String(ctx.slideNumber)}: ${typed.name} "${name}" is not supported and was skipped`,
      );
      return [];
  }
  return nodes.length === 0
    ? []
    : [
        {
          id: ctx.nextId(),
          name,
          type: "group",
          opacity: 1,
          visible: true,
          children: [...nodes, ...decoration],
        },
      ];
}

const PIE_CHARTS: ReadonlySet<string> = new Set(["pieChart", "pie3DChart", "doughnutChart"]);
/** Average glyph advance as a fraction of the font size, for sizing label columns. */
const ADVANCE = 0.55;

/** Chart title: explicit rich text, or the series name for an auto title. */
function titleNode(
  ctx: SlideContext,
  chart: XmlElement | undefined,
  series: Series[],
  frame: Box,
  base: TextStyle,
): TextNode | undefined {
  const title = child(chart, "title");
  if (title === undefined || attr(child(chart, "autoTitleDeleted"), "val") === "1")
    return undefined;
  const text =
    findAll(child(title, "tx"), "t")
      .map((t) => t.text)
      .join("") || (series.length === 1 ? (series[0]?.name ?? "") : "");
  if (text === "") return undefined;
  const run = find(child(title, "tx"), "rPr") ?? find(child(title, "tx"), "defRPr");
  // Office sizes an unformatted title at 1.2× the chart's default text, bold.
  const style = textStyle(ctx, title) ?? {
    ...base,
    sizePx:
      attr(run, "sz") === undefined ? base.sizePx * 1.2 : ptToPx(ctx, num(run, "sz", 0) / 100),
    bold: attr(run, "b") !== "0",
  };
  return label(ctx, text, frame.x, frame.y + frame.h * 0.02, frame.w, style);
}

/** Legend on the right (default) or at the bottom: a swatch and a name per entry. */
function legendNodes(
  ctx: SlideContext,
  legend: XmlElement | undefined,
  entries: { name: string; fill: Paint }[],
  frame: Box,
  plot: Plot,
  base: TextStyle,
): { nodes: SceneNode[]; left: number } {
  const right = frame.x + frame.w;
  if (legend === undefined || entries.length === 0) return { nodes: [], left: right };
  const style = textStyle(ctx, legend) ?? base;
  const size = style.sizePx;
  const row = size * 1.4;
  const swatch = size * 0.7;
  const textWidth = Math.max(...entries.map((e) => e.name.length)) * size * ADVANCE + size;
  const width = swatch + size * 0.4 + textWidth;
  const left = right - width - frame.w * 0.02;
  const top = (plot.top + plot.bottom) / 2 - (entries.length * row) / 2;
  const nodes = entries.flatMap((entry, i): SceneNode[] => {
    const y = top + i * row;
    return [
      rect(
        ctx,
        `legend · ${entry.name}`,
        left,
        y + (row - swatch) / 2 - size * 0.1,
        swatch,
        swatch,
        [entry.fill],
      ),
      label(ctx, entry.name, left + swatch + size * 0.4, y, textWidth, style, "left"),
    ];
  });
  return { nodes, left: left - frame.w * 0.03 };
}

/** Horizontal bar charts put category names left of the plot, bottom-up. */
function barCategoryLabels(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  categories: readonly string[],
  plot: Plot,
  base: TextStyle,
): SceneNode[] {
  const catAxis = find(chartPart, "catAx");
  if (attr(child(catAxis, "delete"), "val") === "1" || categories.length === 0) return [];
  const style = textStyle(ctx, catAxis) ?? base;
  const width =
    Math.max(...categories.map((c) => c.length)) * style.sizePx * ADVANCE + style.sizePx;
  const x = plot.left;
  plot.left += width + style.sizePx * 0.5;
  const step = (plot.bottom - plot.top) / categories.length;
  return categories.map((category, i) =>
    label(
      ctx,
      category,
      x,
      plot.bottom - (i + 0.5) * step - style.sizePx * 0.7,
      width,
      style,
      "right",
    ),
  );
}

function categoryLabels(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  categories: readonly string[],
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const catAxis = find(chartPart, "catAx");
  const style = attr(child(catAxis, "delete"), "val") === "1" ? undefined : textStyle(ctx, catAxis);
  if (style === undefined) return [];
  const width = (plot.right - plot.left) / Math.max(categories.length, 1);
  return categories.map((category, i) =>
    label(
      ctx,
      category,
      plot.left + i * width,
      plot.bottom + frame.h * PLOT.labelGap,
      width,
      style,
    ),
  );
}

function axisLine(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const ln = find(child(find(chartPart, "catAx"), "spPr"), "ln");
  const color = resolveColor(child(ln, "solidFill"), ctx.colors);
  if (color === undefined) return [];
  const weight = Math.max(0.5, num(ln, "w", 9525) * ctx.scale);
  return [
    rect(ctx, "axis", frame.x, plot.bottom - weight / 2, frame.w, weight, [
      { type: "solid", color: color.color, opacity: color.alpha },
    ]),
  ];
}

/** Bar and column charts: clustered, stacked and 100% stacked. */
function barNodes(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  bar: XmlElement,
  series: Series[],
  categories: string[],
  frame: Box,
  plot: Plot,
): SceneNode[] {
  if (series.length === 0 || categories.length === 0) return [];
  const horizontal = attr(child(bar, "barDir"), "val") === "bar";
  const grouping = attr(child(bar, "grouping"), "val") ?? "clustered";
  const percent = grouping === "percentStacked";
  const stacked = percent || grouping === "stacked";
  const totals = categories.map((_, ci) =>
    series.reduce((sum, s) => sum + Math.max(0, s.values.get(ci) ?? 0), 0),
  );
  const max = stacked
    ? Math.max(0, ...totals)
    : Math.max(0, ...series.flatMap((s) => [...s.values.values()]));
  if (max <= 0) return [];
  const top = percent ? 1 : niceMax(max);
  const gap = num(child(bar, "gapWidth"), "val", 150) / 100;
  const overlap = stacked ? 1 : num(child(bar, "overlap"), "val", 0) / 100;
  const slots = stacked ? 1 : series.length;
  // Horizontal bars list categories bottom-up along the vertical axis.
  const along = horizontal ? plot.bottom - plot.top : plot.right - plot.left;
  const across = horizontal ? plot.right - plot.left : plot.bottom - plot.top;
  const categorySize = along / categories.length;
  const barSize = categorySize / (slots - (slots - 1) * overlap + gap);
  const nodes: SceneNode[] = [];
  categories.forEach((category, ci) => {
    const start = horizontal
      ? plot.bottom - (ci + 1) * categorySize + (gap * barSize) / 2
      : plot.left + ci * categorySize + (gap * barSize) / 2;
    let offset = 0;
    series.forEach((s, si) => {
      const raw = s.values.get(ci);
      if (raw === undefined) return;
      const value = percent ? raw / (totals[ci] || 1) : raw;
      const length = (across * Math.max(0, value)) / top;
      const pos = start + (stacked ? 0 : si * barSize * (1 - overlap));
      const fill = s.pointFills.get(ci) ?? s.fill;
      const barName = `${s.name} · ${category}`;
      if (horizontal)
        nodes.push(rect(ctx, barName, plot.left + offset, pos, length, barSize, [fill]));
      else
        nodes.push(rect(ctx, barName, pos, plot.bottom - offset - length, barSize, length, [fill]));
      if (s.label !== undefined) {
        const style = { ...s.label, fill: s.label.fill ?? fill };
        const text = formatValue(raw);
        nodes.push(
          horizontal
            ? label(
                ctx,
                text,
                plot.left + offset + length,
                pos + barSize / 2 - style.sizePx * 0.7,
                style.sizePx * 4,
                style,
              )
            : label(
                ctx,
                text,
                pos - barSize * 0.25,
                plot.bottom - offset - length - style.sizePx * 1.6,
                barSize * 1.5,
                style,
              ),
        );
      }
      if (stacked) offset += length;
    });
  });
  if (!horizontal) nodes.push(...categoryLabels(ctx, chartPart, categories, frame, plot));
  nodes.push(...axisLine(ctx, chartPart, frame, plot));
  return nodes;
}

/** Line charts: one stroked vector per series through the category centres. */
function lineNodes(
  ctx: SlideContext,
  chartPart: XmlElement | undefined,
  series: Series[],
  categories: string[],
  frame: Box,
  plot: Plot,
): SceneNode[] {
  const max = Math.max(0, ...series.flatMap((s) => [...s.values.values()]));
  if (series.length === 0 || categories.length === 0 || max <= 0) return [];
  const top = niceMax(max);
  const step = (plot.right - plot.left) / categories.length;
  const nodes: SceneNode[] = [];
  for (const s of series) {
    const points: [number, number][] = [];
    categories.forEach((_, ci) => {
      const value = s.values.get(ci);
      if (value !== undefined)
        points.push([
          plot.left + step * (ci + 0.5),
          plot.bottom - ((plot.bottom - plot.top) * value) / top,
        ]);
    });
    if (points.length < 2) continue;
    const x0 = Math.min(...points.map((p) => p[0]));
    const y0 = Math.min(...points.map((p) => p[1]));
    const x1 = Math.max(...points.map((p) => p[0]));
    const y1 = Math.max(...points.map((p) => p[1]));
    const d = points
      .map(
        ([x, y], i) => `${i === 0 ? "M" : "L"} ${String(round(x - x0))} ${String(round(y - y0))}`,
      )
      .join(" ");
    nodes.push({
      id: ctx.nextId(),
      name: s.name || "series",
      type: "vector",
      x: round(x0),
      y: round(y0),
      w: round(Math.max(0.01, x1 - x0)),
      h: round(Math.max(0.01, y1 - y0)),
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      paths: [{ d, fillRule: "nonzero" }],
      fills: [],
      strokes: [
        {
          paint: s.fill.type === "image" ? DEFAULT_BAR : s.fill,
          weight: Math.max(1, ptToPx(ctx, 2.25)),
          align: "center",
          cap: "round",
          join: "round",
        },
      ],
    });
  }
  nodes.push(...categoryLabels(ctx, chartPart, categories, frame, plot));
  nodes.push(...axisLine(ctx, chartPart, frame, plot));
  return nodes;
}

/** Pie and doughnut charts: one vector per slice, clockwise from 12 o'clock. */
function pieNodes(ctx: SlideContext, pie: XmlElement, series: Series[], frame: Box): SceneNode[] {
  const s = series[0];
  if (s === undefined) return [];
  const entries = [...s.values.entries()].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total <= 0) return [];
  const hole = pie.name === "doughnutChart" ? num(child(pie, "holeSize"), "val", 50) / 100 : 0;
  const size = Math.min(frame.w, frame.h) * 0.8;
  const r = size / 2;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const varyColors = attr(child(pie, "varyColors"), "val") !== "0";
  let angle = num(child(pie, "firstSliceAng"), "val", 0) - 90;
  return entries.map(([idx, value], i) => {
    const sweep = (value / total) * 360;
    const d = slicePath(r, r * hole, angle, sweep);
    angle += sweep;
    return {
      id: ctx.nextId(),
      name: `${s.name || "slice"} · ${String(idx + 1)}`,
      type: "vector",
      x: round(cx - r),
      y: round(cy - r),
      w: round(size),
      h: round(size),
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      paths: [{ d, fillRule: "evenodd" }],
      fills: [s.pointFills.get(idx) ?? (varyColors ? accent(ctx, i) : s.fill)],
      strokes: [],
    };
  });
}

/** Pie/doughnut slice in its local box (0..2r); angles in degrees, clockwise from +x. */
export function slicePath(r: number, inner: number, start: number, sweep: number): string {
  const p = (radius: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${String(round(r + radius * Math.cos(a)))} ${String(round(r + radius * Math.sin(a)))}`;
  };
  const arc = (radius: number, large: number, clockwise: number, to: string) =>
    `A ${String(round(radius))} ${String(round(radius))} 0 ${String(large)} ${String(clockwise)} ${to}`;
  if (sweep >= 359.999) {
    const ring = `M ${p(r, 0)} ${arc(r, 1, 1, p(r, 180))} ${arc(r, 1, 1, p(r, 360))} Z`;
    return inner > 0
      ? `${ring} M ${p(inner, 0)} ${arc(inner, 1, 0, p(inner, 180))} ${arc(inner, 1, 0, p(inner, 360))} Z`
      : ring;
  }
  const large = sweep > 180 ? 1 : 0;
  const end = start + sweep;
  if (inner <= 0)
    return `M ${String(round(r))} ${String(round(r))} L ${p(r, start)} ${arc(r, large, 1, p(r, end))} Z`;
  return `M ${p(r, start)} ${arc(r, large, 1, p(r, end))} L ${p(inner, end)} ${arc(inner, large, 0, p(inner, start))} Z`;
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
