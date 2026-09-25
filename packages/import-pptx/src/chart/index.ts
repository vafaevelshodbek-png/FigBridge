/**
 * Charts → editable layers rebuilt natively from the chart part's cached values: bar and
 * column (clustered, stacked, 100 % stacked), line, area, scatter, pie and doughnut charts,
 * and combinations of bar, line and area on shared axes. Other chart types are reported.
 */
import type { SceneNode } from "@figbridge/scene";
import { ptToPx, type SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import { attr, child, childrenOf, find, findAll, type XmlElement } from "../xml.js";
import { areaNodes } from "./area.js";
import { dataMax, type ValueScale, valueAxis, valueScale } from "./axis.js";
import { barNodes } from "./bar.js";
import { axisLine, barCategoryLabels, categoryLabels, legendNodes, titleNode } from "./layout.js";
import { lineNodes } from "./line.js";
import { PIE_CHARTS, pieNodes } from "./pie.js";
import { scatterNodes } from "./scatter.js";
import { readSeries, type Series } from "./series.js";
import { accent, DEFAULT_BAR, PLOT, type Plot, type TextStyle, textStyle } from "./style.js";

const BAR = new Set(["barChart", "bar3DChart"]);
const LINE = new Set(["lineChart", "line3DChart"]);
const AREA = new Set(["areaChart", "area3DChart"]);
const SCATTER = new Set(["scatterChart"]);

interface Part {
  el: XmlElement;
  series: Series[];
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
  const plotArea = find(chartPart, "plotArea");
  const typed = plotArea?.children.filter((c) => c.name.endsWith("Chart")) ?? [];
  if (target === undefined || typed.length === 0) {
    ctx.warn(`slide ${String(ctx.slideNumber)}: chart "${name}" could not be read and was skipped`);
    return [];
  }
  const supported = (el: XmlElement) =>
    BAR.has(el.name) ||
    LINE.has(el.name) ||
    AREA.has(el.name) ||
    SCATTER.has(el.name) ||
    PIE_CHARTS.has(el.name);
  for (const el of typed.filter((c) => !supported(c))) {
    ctx.warn(
      `slide ${String(ctx.slideNumber)}: ${el.name} in "${name}" is not supported and was skipped`,
    );
  }
  const parts: Part[] = typed
    .filter(supported)
    .map((el) => ({ el, series: readSeries(ctx, el, target) }));
  const first = parts[0];
  if (first === undefined) return [];
  const allSeries = parts.flatMap((p) => p.series);
  const categories = findAll(child(childrenOf(first.el, "ser")[0], "cat"), "pt").map(
    (pt) => child(pt, "v")?.text ?? "",
  );

  const plot: Plot = {
    left: frame.x + frame.w * PLOT.left,
    right: frame.x + frame.w * PLOT.right,
    top: frame.y + frame.h * PLOT.top,
    bottom: frame.y + frame.h * PLOT.bottom,
  };
  const chart = child(chartPart, "chart");
  const decoration: SceneNode[] = [];
  // Elements without their own txPr use the chart-wide default (Office: 10pt).
  const base: TextStyle = textStyle(ctx, chartPart) ?? {
    sizePx: ptToPx(ctx, 10),
    bold: false,
    font: ctx.theme.minorFont,
    fill: undefined,
  };
  const title = titleNode(ctx, chart, allSeries, frame, base);
  if (title !== undefined) {
    decoration.push(title);
    plot.top = Math.max(plot.top, title.y + title.h + frame.h * 0.03);
  }
  const pie = PIE_CHARTS.has(first.el.name);
  const legendEntries = pie
    ? categories.map((category, i) => {
        const s = first.series[0];
        const fill =
          s?.pointFills.get(i) ??
          (attr(child(first.el, "varyColors"), "val") !== "0" ? accent(ctx, i) : s?.fill);
        return { name: category, fill: fill ?? DEFAULT_BAR };
      })
    : allSeries.map((s) => ({ name: s.name, fill: s.fill }));
  const legend = legendNodes(ctx, child(chart, "legend"), legendEntries, frame, plot, base);
  decoration.push(...legend.nodes);
  plot.right = Math.min(plot.right, legend.left);

  let nodes: SceneNode[];
  let gridlines: SceneNode[] = [];
  if (pie) {
    nodes = pieNodes(ctx, first.el, first.series, {
      ...frame,
      x: plot.left,
      y: plot.top,
      w: plot.right - plot.left,
      h: frame.y + frame.h - plot.top,
    });
  } else if (SCATTER.has(first.el.name)) {
    // Two value axes: the one at the bottom is x.
    const axes = childrenOf(plotArea, "valAx");
    const xAxis = axes.find((a) => attr(child(a, "axPos"), "val") === "b") ?? axes[0];
    const yAxis = axes.find((a) => a !== xAxis);
    const xMax = Math.max(
      0,
      ...first.series.flatMap((s) => [...(s.xValues ?? new Map<number, number>()).values()]),
    );
    const yMax = dataMax(first.series, 0, false);
    if (xMax <= 0 || yMax <= 0) return [];
    const xScale = valueScale(xAxis, xMax, false);
    const yScale = valueScale(yAxis, yMax, false);
    const y = valueAxis(ctx, yAxis, yScale, plot, false, base);
    const x = valueAxis(ctx, xAxis, xScale, plot, true, base);
    gridlines = [...y.gridlines(), ...x.gridlines()];
    decoration.push(...y.labels(), ...x.labels());
    nodes = scatterNodes(ctx, first.el, first.series, plot, xScale, yScale);
  } else {
    // Bar, line and area share one category axis and one value scale.
    const horizontal = parts.some(
      (p) => BAR.has(p.el.name) && attr(child(p.el, "barDir"), "val") === "bar",
    );
    const groupingOf = (p: Part) => attr(child(p.el, "grouping"), "val") ?? "clustered";
    const percent = parts.length === 1 && groupingOf(first) === "percentStacked";
    const max = Math.max(
      ...parts.map((p) => {
        const stacked =
          !LINE.has(p.el.name) && ["stacked", "percentStacked"].includes(groupingOf(p));
        return dataMax(p.series, categories.length, stacked);
      }),
    );
    if (max <= 0 || categories.length === 0) return [];
    const scale: ValueScale = valueScale(find(chartPart, "valAx"), max, percent);
    // The value axis reserves its label room first; category labels then take theirs.
    const axis = valueAxis(ctx, find(chartPart, "valAx"), scale, plot, horizontal, base);
    if (horizontal) decoration.push(...barCategoryLabels(ctx, chartPart, categories, plot, base));
    decoration.push(...axis.labels());
    gridlines = axis.gridlines();
    nodes = [];
    // Areas behind bars behind lines, as PowerPoint layers them.
    for (const group of [AREA, BAR, LINE]) {
      for (const p of parts.filter((q) => group.has(q.el.name))) {
        if (AREA.has(p.el.name))
          nodes.push(...areaNodes(ctx, p.el, p.series, categories.length, plot, scale));
        else if (BAR.has(p.el.name))
          nodes.push(...barNodes(ctx, p.el, p.series, categories, plot, scale));
        else nodes.push(...lineNodes(ctx, p.series, categories.length, plot, scale));
      }
    }
    if (!horizontal) nodes.push(...categoryLabels(ctx, chartPart, categories, frame, plot));
    nodes.push(...axisLine(ctx, chartPart, frame, plot));
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
          // Gridlines under the data, labels and legend on top.
          children: [...gridlines, ...nodes, ...decoration],
        },
      ];
}
