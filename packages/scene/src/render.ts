/**
 * Reference rasterizer: draws a Scene slide to PNG without Figma.
 *
 * Used for golden/visual tests and the `verify` workflow (compare with the source render).
 * It follows Figma's semantics for the features importers emit; text uses whatever fonts
 * are installed, so text-heavy diffs need a tolerance.
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
  for (const node of slide.children) await drawNode(ctx, node, blobs);
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
  let offset = 0;
  node.characters.split(/\n|\u2028/).forEach((line, index) => {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    // Split the line into pieces by run boundaries.
    const pieces: { text: string; run: TextRun }[] = [];
    let cursor = lineStart;
    while (cursor < lineEnd) {
      const run = node.runs.find((r) => r.start <= cursor && cursor < r.end) ?? firstRun;
      const end = Math.min(lineEnd, Math.max(run.end, cursor + 1));
      pieces.push({ text: node.characters.slice(cursor, end), run });
      cursor = end;
    }
    const widths = pieces.map((piece) => {
      ctx.font = fontFor(piece.run);
      return ctx.measureText(piece.text).width;
    });
    const total = widths.reduce((sum, w) => sum + w, 0);
    let x =
      node.align === "center" ? (node.w - total) / 2 : node.align === "right" ? node.w - total : 0;
    const size = Math.max(...pieces.map((p) => p.run.fontSize), firstRun.fontSize);
    const baseline = (lineHeight - size * 1.21) / 2 + size * 0.97 + index * lineHeight;
    pieces.forEach((piece, i) => {
      ctx.font = fontFor(piece.run);
      ctx.fillStyle =
        piece.run.fill.type === "solid"
          ? rgba(piece.run.fill.color, piece.run.fill.opacity)
          : "#000000";
      ctx.fillText(piece.text, x, baseline);
      x += widths[i] ?? 0;
    });
    offset = lineEnd + 1;
  });
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
