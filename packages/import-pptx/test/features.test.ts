/**
 * DrawingML features one at a time, on minimal decks built in memory (build-pptx.ts):
 * fills, outlines, geometry, groups, pictures and charts.
 */
import { isFigmaPath, type Paint, type SceneNode, SceneSchema } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { importPptx } from "../src/index.js";
import { buildPptx, type DeckSpec, shape } from "./build-pptx.js";

/** A 2×2 PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR42mP8z8DwnwEIGBmBAAAhUAMB0T0AGgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function importDeck(spec: DeckSpec) {
  const result = await importPptx(buildPptx(spec), "test.pptx");
  SceneSchema.parse(result.scene);
  return result;
}

async function nodesOf(shapes: string, extra: Omit<DeckSpec, "slides"> & { rels?: string } = {}) {
  const { rels, ...deck } = extra;
  const result = await importDeck({
    ...deck,
    slides: [{ shapes, ...(rels === undefined ? {} : { rels }) }],
  });
  const slide = result.scene.slides[0];
  if (slide === undefined) throw new Error("no slide");
  return { nodes: flatten(slide.children), warnings: result.warnings, blobs: result.blobs };
}

function flatten(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((n) => (n.type === "group" ? [n, ...flatten(n.children)] : [n]));
}

function fillsOf(node: SceneNode | undefined): Paint[] {
  return node !== undefined && "fills" in node ? node.fills : [];
}

describe("fills", () => {
  it("solid colours with alpha and theme colours", async () => {
    const { nodes } = await nodesOf(
      shape(
        "a",
        `<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>`,
      ) + shape("b", `<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>`),
    );
    expect(fillsOf(nodes[0])).toEqual([{ type: "solid", color: "#FF0000", opacity: 0.5 }]);
    expect(fillsOf(nodes[1])).toEqual([{ type: "solid", color: "#ED7D31", opacity: 1 }]);
  });

  it("linear gradients follow the angle; path gradients are radial", async () => {
    const stops = `<a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst>`;
    const { nodes } = await nodesOf(
      shape("lin", `<a:gradFill>${stops}<a:lin ang="5400000"/></a:gradFill>`) +
        shape(
          "rad",
          `<a:gradFill>${stops}<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`,
        ),
    );
    const [lin] = fillsOf(nodes[0]);
    expect(lin).toMatchObject({
      type: "linear-gradient",
      stops: [
        { position: 0, color: "#000000" },
        { position: 1, color: "#FFFFFF" },
      ],
    });
    if (lin?.type === "linear-gradient") {
      // 90° runs top to bottom.
      expect(lin.from[0]).toBeCloseTo(lin.to[0]);
      expect(lin.to[1]).toBeGreaterThan(lin.from[1]);
    }
    expect(fillsOf(nodes[1])[0]).toMatchObject({ type: "radial-gradient", center: [0.5, 0.5] });
  });

  it("patterns become a tiled PNG", async () => {
    const { nodes, blobs } = await nodesOf(
      shape(
        "p",
        `<a:pattFill prst="dkDnDiag"><a:fgClr><a:srgbClr val="112233"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>`,
      ),
    );
    const [paint] = fillsOf(nodes[0]);
    expect(paint).toMatchObject({ type: "image", scaleMode: "tile" });
    if (paint?.type === "image") {
      expect(paint.tileScale).toBeGreaterThan(0);
      expect(blobs.get(paint.blob)?.mimeType).toBe("image/png");
    }
  });

  it("noFill with no outline draws nothing; fillRef takes the theme style with its colour", async () => {
    const { nodes } = await nodesOf(
      shape("none", `<a:noFill/>`) +
        shape("styled", "", {
          style: `<p:style><a:lnRef idx="0"/><a:fillRef idx="1"><a:schemeClr val="accent6"/></a:fillRef><a:effectRef idx="0"/><a:fontRef idx="minor"/></p:style>`,
        }),
    );
    expect(nodes.map((n) => n.name)).toEqual(["styled"]);
    expect(fillsOf(nodes[0])).toEqual([{ type: "solid", color: "#70AD47", opacity: 1 }]);
  });
});

describe("outlines", () => {
  it("width, dash preset and caps", async () => {
    const { nodes } = await nodesOf(
      shape(
        "line",
        `<a:noFill/><a:ln w="25400" cap="rnd"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:prstDash val="dash"/></a:ln>`,
      ),
    );
    const node = nodes[0];
    expect(node !== undefined && "strokes" in node ? node.strokes[0] : undefined).toMatchObject({
      paint: { type: "solid", color: "#0000FF" },
      cap: "round",
      dash: [expect.any(Number) as number, expect.any(Number) as number],
    });
  });
});

describe("geometry", () => {
  it.each([
    ["roundRect", "rect"],
    ["ellipse", "ellipse"],
    ["triangle", "vector"],
    ["rightArrow", "vector"],
    ["line", "vector"],
  ])("%s → %s", async (prst, type) => {
    const { nodes } = await nodesOf(
      shape(
        "s",
        `<a:solidFill><a:srgbClr val="888888"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`,
        { prst },
      ),
    );
    expect(nodes[0]?.type).toBe(type);
    if (prst === "roundRect" && nodes[0]?.type === "rect")
      expect(nodes[0].radii[0]).toBeGreaterThan(0);
  });

  it("unknown presets fall back to their box with a warning", async () => {
    const { nodes, warnings } = await nodesOf(
      shape("star", `<a:solidFill><a:srgbClr val="888888"/></a:solidFill>`, { prst: "star5" }),
    );
    expect(nodes[0]?.type).toBe("rect");
    expect(warnings).toContainEqual(expect.stringContaining("star5"));
  });

  it("custom geometry with arcs becomes Figma-compatible paths", async () => {
    const custGeom = `<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="10800000" swAng="10800000"/><a:lnTo><a:pt x="50" y="100"/></a:lnTo><a:cubicBezTo><a:pt x="40" y="100"/><a:pt x="0" y="80"/><a:pt x="0" y="50"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom>`;
    const { nodes } = await nodesOf(
      shape("c", `${custGeom}<a:solidFill><a:srgbClr val="888888"/></a:solidFill>`),
    );
    const node = nodes[0];
    expect(node?.type).toBe("vector");
    if (node?.type === "vector")
      for (const path of node.paths) expect(isFigmaPath(path.d)).toBe(true);
  });
});

describe("groups", () => {
  it("child coordinates map through the group's scale", async () => {
    const child = shape("inner", `<a:solidFill><a:srgbClr val="000000"/></a:solidFill>`, {
      x: 0,
      y: 0,
      w: 1000,
      h: 1000,
    });
    const group =
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>${child}</p:grpSp>`;
    const { nodes } = await nodesOf(group);
    const inner = nodes.find((n) => n.name === "inner");
    expect(inner).toBeDefined();
    if (inner !== undefined && inner.type !== "group") {
      expect(inner.w).toBeCloseTo(inner.h);
      // 1000 child units span the whole 1 828 800 EMU group, i.e. 2 in → 2/13.333 of the slide width.
      expect(inner.w / 1920).toBeCloseTo(2 / 13.333, 2);
    }
  });
});

describe("pictures", () => {
  const pic = (embed: string, crop = "") =>
    `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`;

  it("embeds the image and applies the crop", async () => {
    const { nodes, blobs } = await nodesOf(pic("rImg", `<a:srcRect l="25000" r="25000"/>`), {
      rels: `<Relationship Id="rImg" Target="../media/image1.png"/>`,
      parts: { "ppt/media/image1.png": PNG },
    });
    const node = nodes[0];
    expect(node?.type).toBe("image");
    if (node?.type === "image") {
      expect(blobs.get(node.image.blob)?.bytes).toEqual(PNG);
      expect(node.image.crop).toMatchObject({ x: 0.25, w: 0.5 });
    }
  });

  it("passes animated GIFs through byte for byte, so the animation survives", async () => {
    // Two 1×1 frames: a minimal animated GIF (NETSCAPE loop extension, two image blocks).
    const gif = Uint8Array.from(
      atob(
        "R0lGODlhAQABAPABAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQAMgAAACwAAAAAAQABAAACAkQBACH5BAAyAAAALAAAAAABAAEAAAICTAEAOw==",
      ),
      (c) => c.charCodeAt(0),
    );
    const { nodes, blobs } = await nodesOf(pic("rGif"), {
      rels: `<Relationship Id="rGif" Target="../media/image1.gif"/>`,
      parts: { "ppt/media/image1.gif": gif },
    });
    const node = nodes[0];
    expect(node?.type).toBe("image");
    if (node?.type === "image") {
      const stored = blobs.get(node.image.blob);
      expect(stored?.mimeType).toBe("image/gif");
      expect(stored?.bytes).toEqual(gif);
    }
  });

  it("skips formats Figma cannot show, with a warning", async () => {
    const { nodes, warnings } = await nodesOf(pic("rEmf"), {
      rels: `<Relationship Id="rEmf" Target="../media/image1.emf"/>`,
      parts: { "ppt/media/image1.emf": new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0]) },
    });
    expect(nodes).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/emf|unsupported|image/i);
  });
});

describe("charts", () => {
  const frame =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="6096000" cy="3429000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const series = (name: string, values: number[]) =>
    `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:strCache>${values.map((_, i) => `<c:pt idx="${String(i)}"><c:v>Q${String(i + 1)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:numCache>${values.map((v, i) => `<c:pt idx="${String(i)}"><c:v>${String(v)}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val></c:ser>`;
  const chart = (plot: string, extra = "") => ({
    rels: `<Relationship Id="rChart" Target="../charts/chart1.xml"/>`,
    parts: {
      "ppt/charts/chart1.xml": `<c:chartSpace><c:chart>${extra}<c:plotArea>${plot}<c:catAx><c:delete val="0"/></c:catAx></c:plotArea></c:chart></c:chartSpace>`,
    },
  });

  it("pie: one Figma-compatible slice per point, varied theme colours, legend", async () => {
    const { nodes } = await nodesOf(
      frame,
      chart(
        `<c:pieChart><c:varyColors val="1"/>${series("Sales", [5, 3, 2])}</c:pieChart>`,
        `<c:legend><c:legendPos val="r"/></c:legend>`,
      ),
    );
    const slices = nodes.filter(
      (n): n is Extract<SceneNode, { type: "vector" }> => n.type === "vector",
    );
    expect(slices).toHaveLength(3);
    for (const slice of slices) expect(isFigmaPath(slice.paths[0]?.d ?? "")).toBe(true);
    expect(slices.map((s) => fillsOf(s)[0])).toEqual([
      { type: "solid", color: "#4472C4", opacity: 1 },
      { type: "solid", color: "#ED7D31", opacity: 1 },
      { type: "solid", color: "#A5A5A5", opacity: 1 },
    ]);
    expect(nodes.flatMap((n) => (n.type === "text" ? [n.characters] : []))).toEqual([
      "Q1",
      "Q2",
      "Q3",
    ]);
  });

  it("doughnut slices have holes", async () => {
    const { nodes } = await nodesOf(
      frame,
      chart(`<c:doughnutChart><c:holeSize val="60"/>${series("S", [1, 1])}</c:doughnutChart>`),
    );
    const slice = nodes.find((n) => n.type === "vector");
    expect(
      slice?.type === "vector" ? slice.paths[0]?.d.match(/C /g)?.length : 0,
    ).toBeGreaterThanOrEqual(4);
  });

  it("stacked horizontal bars: one rectangle per point, stacked end to end", async () => {
    const two =
      series("A", [1, 2]) + series("B", [3, 4]).replace('<c:idx val="0"/>', '<c:idx val="1"/>');
    const { nodes } = await nodesOf(
      frame,
      chart(`<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/>${two}</c:barChart>`),
    );
    const bars = nodes.filter((n) => n.type === "rect" && n.name.includes("·"));
    expect(bars).toHaveLength(4);
    // Paint order is by category, then series: A·Q1, B·Q1, A·Q2, B·Q2.
    const [a1, b1] = bars;
    if (a1?.type === "rect" && b1?.type === "rect") expect(b1.x).toBeCloseTo(a1.x + a1.w, 1);
  });

  it("line charts are stroked vectors through the points", async () => {
    const { nodes } = await nodesOf(
      frame,
      chart(`<c:lineChart>${series("L", [1, 3, 2])}</c:lineChart>`),
    );
    const line = nodes.find((n) => n.type === "vector");
    expect(line?.type === "vector" ? line.paths[0]?.d.split("L").length : 0).toBe(3);
    expect(line?.type === "vector" ? line.strokes[0]?.weight : 0).toBeGreaterThan(0);
  });

  it("stacked areas: one closed shape per series, the second on top of the first", async () => {
    const two =
      series("A", [1, 2, 3]) +
      series("B", [2, 2, 2]).replace('<c:idx val="0"/>', '<c:idx val="1"/>');
    const { nodes } = await nodesOf(
      frame,
      chart(`<c:areaChart><c:grouping val="stacked"/>${two}</c:areaChart>`),
    );
    const areas = nodes.filter(
      (n): n is Extract<SceneNode, { type: "vector" }> => n.type === "vector",
    );
    expect(areas).toHaveLength(2);
    for (const area of areas) expect(area.paths[0]?.d.endsWith(" Z")).toBe(true);
    const [a, b] = areas;
    // B sits above A: its top edge is higher on the slide.
    if (a !== undefined && b !== undefined) expect(b.y).toBeLessThan(a.y);
  });

  it("bar + line combinations share one value axis", async () => {
    const plot =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series("Sales", [10, 20])}</c:barChart>` +
      `<c:lineChart>${series("Target", [15, 40]).replace('<c:idx val="0"/>', '<c:idx val="1"/>')}</c:lineChart>`;
    const { nodes } = await nodesOf(frame, chart(plot));
    const bars = nodes.filter((n) => n.type === "rect" && n.name.includes("·"));
    const line = nodes.find((n) => n.type === "vector");
    expect(bars).toHaveLength(2);
    expect(line).toBeDefined();
    // The axis reaches the line's 40, so the tallest bar (20) is about half of it.
    const tallest = Math.max(...bars.map((b) => (b.type === "rect" ? b.h : 0)));
    const plotHeight = line?.type === "vector" ? line.h / ((40 - 15) / 45) : 0;
    expect(tallest / plotHeight).toBeCloseTo(20 / 45, 1);
  });

  it("scatter: markers on two value axes, lines when the style has them", async () => {
    const xy =
      `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>S</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt><c:pt idx="2"><c:v>9</c:v></c:pt></c:numCache></c:numRef></c:xVal>` +
      `<c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>8</c:v></c:pt><c:pt idx="2"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:yVal></c:ser>`;
    const axes = `<c:valAx><c:axPos val="b"/></c:valAx><c:valAx><c:axPos val="l"/></c:valAx>`;
    const deck = (style: string) => ({
      rels: `<Relationship Id="rChart" Target="../charts/chart1.xml"/>`,
      parts: {
        "ppt/charts/chart1.xml": `<c:chartSpace><c:chart><c:plotArea><c:scatterChart><c:scatterStyle val="${style}"/>${xy}</c:scatterChart>${axes}</c:plotArea></c:chart></c:chartSpace>`,
      },
    });
    const markers = await nodesOf(frame, deck("marker"));
    expect(markers.nodes.filter((n) => n.type === "ellipse")).toHaveLength(3);
    expect(markers.nodes.some((n) => n.type === "vector")).toBe(false);
    const withLines = await nodesOf(frame, deck("lineMarker"));
    expect(withLines.nodes.filter((n) => n.type === "vector")).toHaveLength(1);
    const dots = withLines.nodes.filter((n) => n.type === "ellipse");
    // x = 1, 4, 9 on a 0..10 axis: the gaps grow 3 : 5.
    const [p1, p2, p3] = dots.map((d) => d.x);
    if (p1 !== undefined && p2 !== undefined && p3 !== undefined)
      expect((p3 - p2) / (p2 - p1)).toBeCloseTo(5 / 3, 1);
  });

  it("unsupported chart types are reported, not guessed", async () => {
    const { nodes, warnings } = await nodesOf(
      frame,
      chart(`<c:radarChart>${series("R", [1, 2])}</c:radarChart>`),
    );
    expect(nodes).toHaveLength(0);
    expect(warnings).toContainEqual(expect.stringContaining("radarChart"));
  });
});

describe("SmartArt and embedded objects", () => {
  const frame = (data: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Diagram 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="1828800"/></p:xfrm><a:graphic>${data}</a:graphic></p:graphicFrame>`;

  it("imports the diagram PowerPoint stored as shapes, placed within the frame", async () => {
    const diagram = frame(
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rData" r:lo="rLo" r:qs="rQs" r:cs="rCs"/></a:graphicData>`,
    );
    const { nodes } = await nodesOf(diagram, {
      rels: `<Relationship Id="rData" Target="../diagrams/data1.xml"/><Relationship Id="rDrawing" Target="../diagrams/drawing1.xml"/>`,
      parts: {
        "ppt/diagrams/data1.xml": `<dgm:dataModel><dgm:extLst><a:ext><dsp:dataModelExt relId="rDrawing"/></a:ext></dgm:extLst></dgm:dataModel>`,
        "ppt/diagrams/drawing1.xml":
          `<dsp:drawing><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
          shape("Box", `<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>`, {
            x: 0,
            y: 0,
            w: 914400,
            h: 914400,
            text: "Step 1",
          }).replaceAll("p:", "dsp:") +
          `</dsp:spTree></dsp:drawing>`,
      },
    });
    const group = nodes.find((n) => n.name === "Diagram 1");
    expect(group?.type).toBe("group");
    const box = nodes.find((n) => n.type === "rect");
    // The drawing's origin is the frame's top-left: 1 in from the slide's corner.
    expect(box?.type === "rect" ? box.x : 0).toBeCloseTo(1920 / 13.333, 0);
    expect(nodes.some((n) => n.type === "text" && n.characters === "Step 1")).toBe(true);
  });

  it("a diagram without a stored drawing is reported, not guessed", async () => {
    const { nodes, warnings } = await nodesOf(
      frame(
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rNone"/></a:graphicData>`,
      ),
    );
    expect(nodes).toHaveLength(0);
    expect(warnings).toContainEqual(expect.stringContaining("diagram object skipped"));
  });

  it("an embedded object shows its preview picture", async () => {
    const pic =
      `<p:pic><p:nvPicPr><p:cNvPr id="8" name="Preview"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`;
    const { nodes } = await nodesOf(
      frame(
        `<a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj progId="Excel.Sheet.12" r:id="rOle">${pic}</p:oleObj></a:graphicData>`,
      ),
      {
        rels: `<Relationship Id="rImg" Target="../media/image1.png"/>`,
        parts: { "ppt/media/image1.png": PNG },
      },
    );
    expect(nodes.map((n) => n.type)).toEqual(["group", "image"]);
  });
});
