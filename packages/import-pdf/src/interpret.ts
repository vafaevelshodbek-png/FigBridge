/**
 * Replays a pdf.js operator list with full graphics state and emits paint primitives in
 * paint order, each tagged with the index of the operator that painted it.
 *
 * Everything is converted to device space (slide pixels, y down) using the viewport
 * transform, so later stages never see PDF user space.
 */
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { IDENTITY, type Matrix, multiply, scaleOf, toMatrix } from "./matrix.js";
import { bounds, decodePath } from "./path.js";
import type {
  ClipPath,
  FontInfo,
  Glyph,
  InterpretResult,
  PaintState,
  PathPrimitive,
  Primitive,
  SoftMask,
} from "./primitives.js";

interface TextState {
  font: string;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  matrix: Matrix;
  lineMatrix: Matrix;
}

interface GraphicsState {
  ctm: Matrix;
  fillColor: string;
  strokeColor: string;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  dash: number[];
  lineCap: number;
  lineJoin: number;
  blendMode: string;
  clips: ClipPath[];
  softMask: number | undefined;
  /** Shading pattern used as fill colour (`scn` with a pattern), device-space matrix. */
  fillPattern: { pattern: string; ctm: Matrix } | undefined;
  /** CTM at the start of the current content stream (page or form): pattern space base. */
  baseCtm: Matrix;
  text: TextState;
}

const TEXT_RENDER_INVISIBLE = 3;

/**
 * @param fnArray,argsArray  pdf.js operator list
 * @param viewport          user space → device space
 * @param fontOf            resolves a pdf.js font id to its PostScript name
 */
export function interpret(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  viewport: Matrix,
  fontOf: (id: string) => FontInfo,
): InterpretResult {
  const primitives: Primitive[] = [];
  const masks = new Map<number, SoftMask>();
  const stack: GraphicsState[] = [];
  /**
   * Open transparency groups. A group is composited onto its parent with the fill alpha that
   * was current when it opened; its content starts opaque. A mask group captures its content.
   */
  const groupStack: { mask: SoftMask | null; alpha: number; saved: [number, number] }[] = [];
  const groupAlpha = () => groupStack.reduce((product, g) => product * g.alpha, 1);
  let lastMask: number | undefined;
  let nextMaskId = 1;
  let pendingClip: "nonzero" | "evenodd" | undefined;

  let gs: GraphicsState = {
    ctm: viewport,
    fillColor: "#000000",
    strokeColor: "#000000",
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    dash: [],
    lineCap: 0,
    lineJoin: 0,
    blendMode: "source-over",
    clips: [],
    softMask: undefined,
    fillPattern: undefined,
    baseCtm: viewport,
    text: {
      font: "",
      size: 0,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      leading: 0,
      rise: 0,
      renderMode: 0,
      matrix: IDENTITY,
      lineMatrix: IDENTITY,
    },
  };

  const clone = (s: GraphicsState): GraphicsState => ({
    ...s,
    dash: [...s.dash],
    clips: [...s.clips],
    text: { ...s.text },
  });
  const paintState = (): PaintState => ({
    clips: gs.clips,
    raster: gs.blendMode !== "source-over" || gs.softMask !== undefined,
    blendMode: gs.blendMode,
    alpha: gs.fillAlpha * groupAlpha(),
    ...(gs.softMask === undefined ? {} : { mask: gs.softMask }),
  });
  /** Paint into the innermost capturing mask group, or onto the page. */
  const emit = (primitive: Primitive) => {
    const capturing = [...groupStack].reverse().find((g) => g.mask !== null)?.mask;
    (capturing?.primitives ?? primitives).push(primitive);
  };

  const showText = (op: number, items: readonly unknown[]) => {
    const t = gs.text;
    const glyphs: Glyph[] = [];
    const font = fontOf(t.font).name;
    for (const item of items) {
      if (typeof item === "number") {
        // TJ adjustment: thousandths of text space, moves left for positive values.
        t.matrix = multiply(t.matrix, [1, 0, 0, 1, (-item / 1000) * t.size * t.hScale, 0]);
        continue;
      }
      const glyph = item as {
        unicode?: string;
        originalCharCode?: number;
        width?: number;
        isSpace?: boolean;
      } | null;
      if (glyph === null) continue;
      const width = ((glyph.width ?? 0) / 1000) * t.size;
      const advance =
        (width + t.charSpacing + (glyph.isSpace === true ? t.wordSpacing : 0)) * t.hScale;
      // Text rendering matrix: [size·h, 0, 0, size, 0, rise] × Tm × CTM
      const trm = multiply(
        gs.ctm,
        multiply(t.matrix, [t.size * t.hScale, 0, 0, t.size, 0, t.rise]),
      );
      const scale = scaleOf(trm);
      if (t.renderMode !== TEXT_RENDER_INVISIBLE && scale > 0) {
        glyphs.push({
          op,
          text: glyphText(glyph.unicode, glyph.originalCharCode),
          x: trm[4],
          y: trm[5],
          advance: advance * scaleOf(multiply(gs.ctm, t.matrix)),
          nominal: width * scaleOf(multiply(gs.ctm, t.matrix)),
          size: scale,
          font,
          color: gs.fillColor,
          alpha: gs.fillAlpha * groupAlpha(),
          upright: Math.abs(trm[1]) < 1e-6 && Math.abs(trm[2]) < 1e-6 && trm[0] > 0,
        });
      }
      t.matrix = multiply(t.matrix, [1, 0, 0, 1, advance, 0]);
    }
    if (glyphs.length > 0) emit({ kind: "text", op, glyphs, ...paintState() });
  };

  const nextLine = () => {
    const t = gs.text;
    t.lineMatrix = multiply(t.lineMatrix, [1, 0, 0, 1, 0, -t.leading]);
    t.matrix = t.lineMatrix;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i] ?? -1;
    const args = (argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(clone(gs));
        break;
      case OPS.restore:
        gs = stack.pop() ?? gs;
        break;
      case OPS.transform:
        gs.ctm = multiply(gs.ctm, toMatrix(args as number[]));
        break;
      case OPS.setFillRGBColor:
        gs.fillColor = String(args[0]);
        gs.fillPattern = undefined;
        break;
      case OPS.setFillColorN: {
        // ["Shading", patternId, matrix] — the matrix maps pattern space to the page's
        // base space of the current content stream (page or form), not the current CTM.
        const [kind, id, matrix] = args as [string, string, ArrayLike<number> | undefined];
        gs.fillPattern =
          kind === "Shading"
            ? {
                pattern: id,
                ctm: multiply(gs.baseCtm, toMatrix(matrix ?? [1, 0, 0, 1, 0, 0])),
              }
            : undefined;
        break;
      }
      case OPS.setStrokeRGBColor:
        gs.strokeColor = String(args[0]);
        break;
      case OPS.setLineWidth:
        gs.lineWidth = Number(args[0]);
        break;
      case OPS.setDash:
        gs.dash = [...((args[0] as number[] | undefined) ?? [])];
        break;
      case OPS.setLineCap:
        gs.lineCap = Number(args[0]);
        break;
      case OPS.setLineJoin:
        gs.lineJoin = Number(args[0]);
        break;
      case OPS.setGState:
        for (const [key, value] of (args[0] ?? []) as [string, unknown][]) {
          if (key === "ca") gs.fillAlpha = Number(value);
          else if (key === "CA") gs.strokeAlpha = Number(value);
          else if (key === "BM") gs.blendMode = String(value);
          else if (key === "LW") gs.lineWidth = Number(value);
          else if (key === "SMask") gs.softMask = value === true ? lastMask : undefined;
          else if (key === "Font" && Array.isArray(value)) {
            gs.text.font = String(value[0]);
            gs.text.size = Number(value[1]);
          }
        }
        break;
      case OPS.clip:
        pendingClip = "nonzero";
        break;
      case OPS.eoClip:
        pendingClip = "evenodd";
        break;
      case OPS.constructPath: {
        const [paintOp, [data]] = args as [number, [ArrayLike<number> | undefined]];
        const segments = decodePath(data ?? [], gs.ctm);
        if (pendingClip !== undefined) {
          gs.clips = [...gs.clips, { segments, evenOdd: pendingClip === "evenodd" }];
          pendingClip = undefined;
        }
        if (paintOp === OPS.endPath) break;
        const box = bounds(segments);
        if (box === undefined) break;
        const fills = paintOp !== OPS.stroke && paintOp !== OPS.closeStroke;
        const strokes =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;
        const evenOdd =
          paintOp === OPS.eoFill ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeEOFillStroke;
        if (fills && gs.fillPattern !== undefined) {
          // A path filled with a gradient: a shading clipped to the path.
          emit({
            kind: "shading",
            op: i,
            pattern: gs.fillPattern.pattern,
            ctm: gs.fillPattern.ctm,
            ...paintState(),
            clips: [...gs.clips, { segments, evenOdd }],
          });
          if (!strokes) break;
        }
        const primitive: PathPrimitive = { kind: "path", op: i, segments, box, ...paintState() };
        if (fills && gs.fillPattern === undefined)
          primitive.fill = { color: gs.fillColor, alpha: gs.fillAlpha * groupAlpha(), evenOdd };
        if (strokes) {
          const scale = scaleOf(gs.ctm);
          // The painted area of a stroke extends half the line width beyond the path.
          const half = (gs.lineWidth * scale) / 2;
          primitive.box = {
            x0: box.x0 - half,
            y0: box.y0 - half,
            x1: box.x1 + half,
            y1: box.y1 + half,
          };
          primitive.stroke = {
            color: gs.strokeColor,
            alpha: gs.strokeAlpha * groupAlpha(),
            width: gs.lineWidth * scale,
            dash: gs.dash.map((d) => d * scale),
            cap: gs.lineCap,
            join: gs.lineJoin,
          };
        }
        emit(primitive);
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintImageMaskXObject: {
        // Images occupy the unit square in the current user space.
        const box = bounds(decodePath([0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 4], gs.ctm));
        // paintImageXObject carries an object id; image masks carry the decoded mask inline.
        const source = typeof args[0] === "string" ? { objId: args[0] } : { inline: args[0] };
        if (box !== undefined) {
          emit({
            kind: "image",
            op: i,
            source,
            ctm: gs.ctm,
            box,
            ...(fn === OPS.paintImageMaskXObject ? { stencil: gs.fillColor } : {}),
            ...paintState(),
          });
        }
        break;
      }
      case OPS.shadingFill:
        emit({ kind: "shading", op: i, pattern: String(args[0]), ctm: gs.ctm, ...paintState() });
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(clone(gs));
        const [matrix, bbox] = args as [ArrayLike<number> | null, ArrayLike<number> | null];
        if (matrix !== null) gs.ctm = multiply(gs.ctm, toMatrix(matrix));
        gs.baseCtm = gs.ctm;
        if (bbox !== null && bbox.length === 4) {
          const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = Array.from(bbox);
          gs.clips = [
            ...gs.clips,
            {
              segments: decodePath([0, x0, y0, 1, x1, y0, 1, x1, y1, 1, x0, y1, 4], gs.ctm),
              evenOdd: false,
            },
          ];
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        gs = stack.pop() ?? gs;
        break;
      case OPS.beginGroup: {
        const group = args[0] as
          | {
              smask?: { subtype?: string; backdrop?: string } | null;
              bbox?: ArrayLike<number> | null;
              matrix?: ArrayLike<number> | null;
            }
          | undefined;
        const smask = group?.smask;
        const isMask = smask !== null && smask !== undefined;
        groupStack.push({
          mask: isMask
            ? {
                id: nextMaskId++,
                subtype: smask.subtype === "Alpha" ? "Alpha" : "Luminosity",
                backdrop: smask.backdrop ?? "#000000",
                primitives: [],
              }
            : null,
          // A mask's content defines coverage; its own opacity must not dim the mask.
          alpha: isMask ? 1 : gs.fillAlpha,
          saved: [gs.fillAlpha, gs.strokeAlpha],
        });
        gs.fillAlpha = 1;
        gs.strokeAlpha = 1;
        const bbox = group?.bbox;
        if (bbox !== null && bbox !== undefined && bbox.length === 4) {
          const ctm =
            group?.matrix === null || group?.matrix === undefined
              ? gs.ctm
              : multiply(gs.ctm, toMatrix(group.matrix));
          const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = Array.from(bbox);
          gs.clips = [
            ...gs.clips,
            {
              segments: decodePath([0, x0, y0, 1, x1, y0, 1, x1, y1, 1, x0, y1, 4], ctm),
              evenOdd: false,
            },
          ];
        }
        break;
      }
      case OPS.endGroup: {
        const closed = groupStack.pop();
        if (closed !== undefined) {
          [gs.fillAlpha, gs.strokeAlpha] = closed.saved;
          if (closed.mask !== null) {
            masks.set(closed.mask.id, closed.mask);
            lastMask = closed.mask.id;
          }
        }
        break;
      }
      // ── text ───────────────────────────────────────────────────────────────
      case OPS.beginText:
        gs.text.matrix = IDENTITY;
        gs.text.lineMatrix = IDENTITY;
        break;
      case OPS.setFont:
        gs.text.font = String(args[0]);
        gs.text.size = Number(args[1]);
        break;
      case OPS.setTextMatrix:
        gs.text.matrix = toMatrix(args[0] as ArrayLike<number>);
        gs.text.lineMatrix = gs.text.matrix;
        break;
      case OPS.moveText:
        gs.text.lineMatrix = multiply(gs.text.lineMatrix, [
          1,
          0,
          0,
          1,
          Number(args[0]),
          Number(args[1]),
        ]);
        gs.text.matrix = gs.text.lineMatrix;
        break;
      case OPS.setLeadingMoveText:
        gs.text.leading = -Number(args[1]);
        gs.text.lineMatrix = multiply(gs.text.lineMatrix, [
          1,
          0,
          0,
          1,
          Number(args[0]),
          Number(args[1]),
        ]);
        gs.text.matrix = gs.text.lineMatrix;
        break;
      case OPS.nextLine:
        nextLine();
        break;
      case OPS.setLeading:
        gs.text.leading = Number(args[0]);
        break;
      case OPS.setCharSpacing:
        gs.text.charSpacing = Number(args[0]);
        break;
      case OPS.setWordSpacing:
        gs.text.wordSpacing = Number(args[0]);
        break;
      case OPS.setHScale:
        gs.text.hScale = Number(args[0]) / 100;
        break;
      case OPS.setTextRise:
        gs.text.rise = Number(args[0]);
        break;
      case OPS.setTextRenderingMode:
        gs.text.renderMode = Number(args[0]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(i, (args[0] ?? []) as unknown[]);
        break;
      case OPS.nextLineShowText:
        nextLine();
        showText(i, (args[0] ?? []) as unknown[]);
        break;
      case OPS.nextLineSetSpacingShowText:
        gs.text.wordSpacing = Number(args[0]);
        gs.text.charSpacing = Number(args[1]);
        nextLine();
        showText(i, (args[2] ?? []) as unknown[]);
        break;
      default:
        break;
    }
  }
  return { primitives, masks };
}

/**
 * A glyph's text. Some subset fonts map a few glyphs (often the full stop) to U+FFFD in their
 * ToUnicode table; their character code is then still plain ASCII, so fall back to it.
 */
export function glyphText(unicode: string | undefined, code: number | undefined): string {
  if (unicode === "\uFFFD" && code !== undefined && code > 0x20 && code < 0x7f)
    return String.fromCharCode(code);
  return unicode ?? "";
}
