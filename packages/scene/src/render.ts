/**
 * Reference rasterizer: draws a Scene slide to PNG without Figma.
 *
 * Used for golden/visual tests and the `verify` workflow (compare with the source render).
 * It follows Figma's semantics for the features importers emit. Text uses installed fonts;
 * for output that is identical across machines (golden tests), pass `fontFamily` to draw
 * every run in one registered font.
 *
 * Node-only (depends on @napi-rs/canvas); import from "@figbridge/scene/render".
 */
import { createCanvas, loadImage, Path2D, type SKRSContext2D } from "@napi-rs/canvas";
import type { Paint, SceneNode, Slide, Stroke, TextRun } from "./schema.js";

export type BlobSource = (blob: string) => Uint8Array | undefined;

export interface RenderOptions {
  scale?: number;
  /** Background when the slide has none (default white). */
  fallbackBackground?: string;
  /** Draw all text in this family (keeping weight and style), e.g. a font bundled for tests. */
  fontFamily?: string;
}

/** The slide's nodes with every text run set to `family`. */
function withFontFamily(nodes: readonly SceneNode[], family: string): SceneNode[] {
  return nodes.map((node) => {
    if (node.type === "group" || node.type === "frame")
      return { ...node, children: withFontFamily(node.children, family) };
    if (node.type !== "text") return node;
    return { ...node, runs: node.runs.map((run) => ({ ...run, fontFamily: family })) };
  });
}

export async function renderSlide(
  slide: Slide,
  blobs: BlobSource,
  options: RenderOptions = {},
): Promise<Buffer> {
  const scale = options.scale ?? 1;
  const canvas = createCanvas(Math.round(slide.width * scale), Math.round(slide.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = options.fallbackBackground ?? "#FFFFFF";
  ctx.fillRect(0, 0, slide.width, slide.height);
  for (const paint of slide.background) {
    await fillBox(ctx, paint, { x: 0, y: 0, w: slide.width, h: slide.height }, blobs, () => {
      ctx.fillRect(0, 0, slide.width, slide.height);
    });
  }
  const children =
    options.fontFamily === undefined
      ? slide.children
      : withFontFamily(slide.children, options.fontFamily);
  for (const node of children) await drawNode(ctx, node, blobs);
  return canvas.toBuffer("image/png");
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function drawNode(ctx: SKRSContext2D, node: SceneNode, blobs: BlobSource): Promise<void> {
  if (!node.visible) return;
  ctx.save();
  ctx.globalAlpha *= node.opacity;
  if (node.type === "group") {
    for (const child of node.children) await drawNode(ctx, child, blobs);
    ctx.restore();
    return;
  }
  // Rotation/flip around the box centre, as the Figma renderer does.
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  ctx.translate(cx, cy);
  ctx.rotate((node.rotation * Math.PI) / 180);
  ctx.scale(node.flipX ? -1 : 1, node.flipY ? -1 : 1);
  ctx.translate(-node.w / 2, -node.h / 2);
  const box: Rect = { x: 0, y: 0, w: node.w, h: node.h };

  switch (node.type) {
    case "frame": {
      const path = roundedRect(box, node.radii);
      for (const paint of node.fills)
        await fillBox(
          ctx,
          paint,
          box,
          blobs,
          () => {
            ctx.fill(path);
          },
          path,
        );
      strokePath(ctx, path, node.strokes);
      if (node.clip) ctx.clip(path);
      for (const child of node.children) await drawNode(ctx, child, blobs);
      break;
    }
    case "svg": {
      const image = await loadImage(Buffer.from(node.svg));
      ctx.drawImage(image, 0, 0, node.w, node.h);
      break;
    }
    case "rect":
    case "image": {
      const path = roundedRect(box, node.radii);
      const paints = node.type === "image" ? [node.image] : node.fills;
      for (const paint of paints) {
        await fillBox(
          ctx,
          paint,
          box,
          blobs,
          () => {
            ctx.fill(path);
          },
          path,
        );
      }
      strokePath(ctx, path, node.strokes);
      break;
    }
    case "ellipse": {
      const path = new Path2D();
      path.ellipse(node.w / 2, node.h / 2, node.w / 2, node.h / 2, 0, 0, Math.PI * 2);
      for (const paint of node.fills) {
        await fillBox(ctx, paint, box, blobs, () => {
          ctx.fill(path);
        });
      }
      strokePath(ctx, path, node.strokes);
      break;
    }
    case "vector":
      for (const p of node.paths) {
        const path = new Path2D(p.d);
        for (const paint of node.fills) {
          await fillBox(ctx, paint, box, blobs, () => {
            ctx.fill(path, p.fillRule);
          });
        }
        strokePath(ctx, path, node.strokes);
      }
      break;
    case "text":
      drawText(ctx, node);
      break;
  }
  ctx.restore();
}

async function fillBox(
  ctx: SKRSContext2D,
  paint: Paint,
  box: Rect,
  blobs: BlobSource,
  fill: () => void,
  clip?: Path2D,
): Promise<void> {
  ctx.save();
  ctx.globalAlpha *= paint.opacity;
  switch (paint.type) {
    case "solid":
      ctx.fillStyle = paint.color;
      fill();
      break;
    case "linear-gradient": {
      const g = ctx.createLinearGradient(
        box.x + paint.from[0] * box.w,
        box.y + paint.from[1] * box.h,
        box.x + paint.to[0] * box.w,
        box.y + paint.to[1] * box.h,
      );
      for (const stop of paint.stops) g.addColorStop(stop.position, rgba(stop.color, stop.opacity));
      ctx.fillStyle = g;
      fill();
      break;
    }
    case "radial-gradient": {
      const cx = box.x + paint.center[0] * box.w;
      const cy = box.y + paint.center[1] * box.h;
      const g = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        Math.max(paint.radius[0] * box.w, paint.radius[1] * box.h),
      );
      for (const stop of paint.stops) g.addColorStop(stop.position, rgba(stop.color, stop.opacity));
      ctx.fillStyle = g;
      fill();
      break;
    }
    case "image": {
      const bytes = blobs(paint.blob);
      if (bytes === undefined) break;
      const image = await loadImage(Buffer.from(bytes));
      if (clip !== undefined) ctx.clip(clip);
      const crop = paint.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      ctx.drawImage(
        image,
        crop.x * image.width,
        crop.y * image.height,
        crop.w * image.width,
        crop.h * image.height,
        box.x,
        box.y,
        box.w,
        box.h,
      );
      break;
    }
  }
  ctx.restore();
}

function strokePath(ctx: SKRSContext2D, path: Path2D, strokes: readonly Stroke[]): void {
  for (const stroke of strokes) {
    if (stroke.paint.type !== "solid") continue;
    ctx.save();
    ctx.globalAlpha *= stroke.paint.opacity;
    ctx.strokeStyle = stroke.paint.color;
    ctx.lineWidth = stroke.weight;
    ctx.setLineDash(stroke.dash ?? []);
    ctx.lineCap = stroke.cap === "none" ? "butt" : stroke.cap;
    ctx.lineJoin = stroke.join;
    ctx.stroke(path);
    ctx.restore();
  }
}

function fontFor(run: TextRun): string {
  const weight = /black|heavy/i.test(run.fontStyle)
    ? "900"
    : /extra bold/i.test(run.fontStyle)
      ? "800"
      : /semi bold/i.test(run.fontStyle)
        ? "600"
        : /bold/i.test(run.fontStyle)
          ? "700"
          : /medium/i.test(run.fontStyle)
            ? "500"
            : /light/i.test(run.fontStyle)
              ? "300"
              : "400";
  const italic = /italic/i.test(run.fontStyle) ? "italic " : "";
  return `${italic}${weight} ${String(run.fontSize)}px "${run.fontFamily}", Inter, Arial, sans-serif`;
}

interface Piece {
  text: string;
  run: TextRun;
  width: number;
}

interface Line {
  pieces: Piece[];
  /** Left inset for list items. */
  indent: number;
  /** List marker drawn in the indent on a paragraph's first line. */
  marker: string | undefined;
  /** Extra space above the line (paragraph spacing). */
  gap: number;
}

/**
 * Lays text out into visual lines: hard breaks split paragraphs, and unless the node grows
 * horizontally (`sizing: "width"`) words wrap greedily at the node width, as in Figma.
 * List items are inset and get a bullet or number, as Figma draws them.
 */
function layoutLines(
  ctx: SKRSContext2D,
  node: Extract<SceneNode, { type: "text" }>,
  firstRun: TextRun,
): Line[] {
  const wrap = node.sizing !== "width";
  const measure = (text: string, run: TextRun) => {
    ctx.font = fontFor(run);
    return ctx.measureText(text).width;
  };
  const lines: Line[] = [];
  let offset = 0;
  let ordinal = 0;
  let previousAfter = 0;
  let previousParagraph: (typeof node.paragraphs)[number] | undefined;
  const hardLines = node.characters.split(/\n|\u2028/);
  for (const hard of hardLines) {
    const lineStart = offset;
    const lineEnd = offset + hard.length;
    const breakChar = node.characters[lineEnd];
    offset = lineEnd + 1;
    const paragraph = node.paragraphs.find(
      (p) => p.start <= lineStart && lineStart < Math.max(p.end, p.start + 1),
    );
    const startsParagraph = paragraph !== previousParagraph || paragraph === undefined;
    previousParagraph = paragraph;
    const list = paragraph?.list ?? "none";
    const size =
      node.runs.find((r) => r.start <= lineStart && lineStart < r.end)?.fontSize ??
      firstRun.fontSize;
    const indent = list === "none" ? 0 : size * LIST_INDENT * ((paragraph?.indentLevel ?? 0) + 1);
    ordinal = list === "ordered" ? (startsParagraph ? ordinal + 1 : ordinal) : 0;
    const marker =
      !startsParagraph || list === "none"
        ? undefined
        : list === "bullet"
          ? "•"
          : `${String(ordinal)}.`;
    const gap =
      startsParagraph && lines.length > 0 ? previousAfter + (paragraph?.spaceBefore ?? 0) : 0;
    if (startsParagraph) previousAfter = 0;
    // Words (with their trailing spaces), split further at run boundaries.
    const tokens: Piece[] = [];
    let cursor = lineStart;
    while (cursor < lineEnd) {
      const run = node.runs.find((r) => r.start <= cursor && cursor < r.end) ?? firstRun;
      const runEnd = Math.min(lineEnd, Math.max(run.end, cursor + 1));
      for (const word of node.characters.slice(cursor, runEnd).match(/\S+\s*|\s+/g) ?? []) {
        tokens.push({ text: word, run, width: measure(word, run) });
      }
      cursor = runEnd;
    }
    const available = node.w - indent;
    let line: Line = { pieces: [], indent, marker, gap };
    let width = 0;
    for (const token of tokens) {
      const ink = measure(token.text.trimEnd(), token.run);
      // Tokens without a leading space continue the previous word across a run boundary.
      const previous = line.pieces[line.pieces.length - 1];
      const joinsWord = previous !== undefined && !/\s$/.test(previous.text);
      if (wrap && previous !== undefined && !joinsWord && width + ink > available + 0.5) {
        lines.push(line);
        line = { pieces: [], indent, marker: undefined, gap: 0 };
        width = 0;
      }
      line.pieces.push(token);
      width += token.width;
    }
    lines.push(line);
    if (breakChar !== "\u2028") previousAfter = paragraph?.spaceAfter ?? 0;
  }
  return lines;
}

/** Figma's list inset per level, as a multiple of the font size. */
const LIST_INDENT = 1.5;

/** Draws text run by run so colours, weights and sizes within a line are preserved. */
function drawText(ctx: SKRSContext2D, node: Extract<SceneNode, { type: "text" }>): void {
  const firstRun = node.runs[0];
  if (firstRun === undefined) return;
  const paragraph = node.paragraphs[0];
  const lineHeight =
    paragraph?.lineHeight.unit === "pixels"
      ? paragraph.lineHeight.value
      : paragraph?.lineHeight.unit === "percent"
        ? (paragraph.lineHeight.value / 100) * firstRun.fontSize
        : firstRun.fontSize * 1.21;
  ctx.textBaseline = "alphabetic";
  const lines = layoutLines(ctx, node, firstRun);
  const block = lines.reduce((sum, line) => sum + line.gap + lineHeight, 0);
  const top =
    node.sizing === "fixed" && node.verticalAlign === "center"
      ? (node.h - block) / 2
      : node.sizing === "fixed" && node.verticalAlign === "bottom"
        ? node.h - block
        : 0;
  let y = top;
  for (const line of lines) {
    y += line.gap;
    const { pieces } = line;
    // Trailing spaces do not count towards alignment.
    const last = pieces[pieces.length - 1];
    if (last !== undefined) ctx.font = fontFor(last.run);
    const trailing =
      last === undefined ? 0 : last.width - ctx.measureText(last.text.trimEnd()).width;
    const total = pieces.reduce((sum, p) => sum + p.width, 0) - trailing;
    const room = node.w - line.indent;
    let x =
      line.indent +
      (node.align === "center" ? (room - total) / 2 : node.align === "right" ? room - total : 0);
    const size = Math.max(...pieces.map((p) => p.run.fontSize), firstRun.fontSize);
    const baseline = y + (lineHeight - size * 1.21) / 2 + size * 0.97;
    const markerRun = pieces[0]?.run ?? firstRun;
    const paint = (run: TextRun) =>
      run.fill.type === "solid" ? rgba(run.fill.color, run.fill.opacity) : "#000000";
    if (line.marker !== undefined) {
      ctx.font = fontFor(markerRun);
      ctx.fillStyle = paint(markerRun);
      ctx.fillText(line.marker, line.indent - markerRun.fontSize * LIST_INDENT * 0.75, baseline);
    }
    for (const piece of pieces) {
      ctx.font = fontFor(piece.run);
      ctx.fillStyle = paint(piece.run);
      ctx.fillText(piece.text, x, baseline);
      x += piece.width;
    }
    y += lineHeight;
  }
}

function roundedRect(box: Rect, radii: readonly [number, number, number, number]): Path2D {
  const [tl, tr, br, bl] = radii;
  const path = new Path2D();
  path.roundRect(box.x, box.y, box.w, box.h, [tl, tr, br, bl]);
  return path;
}

function rgba(hex: string, alpha: number): string {
  const v = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((v >> 16) & 0xff)},${String((v >> 8) & 0xff)},${String(v & 0xff)},${String(alpha)})`;
}
