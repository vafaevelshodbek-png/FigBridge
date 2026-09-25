/**
 * Charts → editable layers rebuilt natively from the chart part's cached values: bar and
 * column charts (clustered, stacked, 100% stacked), line charts, pie and doughnut charts.
 * Other chart types are reported and skipped.
 */
import type { SceneNode } from "@figbridge/scene";
import { ptToPx, type SlideContext } from "../context.js";
import type { Box } from "../transform.js";
import { attr, child, childrenOf, find, findAll, type XmlElement } from "../xml.js";
import { barNodes } from "./bar.js";
import { barCategoryLabels, legendNodes, titleNode } from "./layout.js";
import { lineNodes } from "./line.js";
import { PIE_CHARTS, pieNodes } from "./pie.js";
import { readSeries } from "./series.js";
import { accent, DEFAULT_BAR, PLOT, type Plot, type TextStyle, textStyle } from "./style.js";

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
