/**
 * Mesh shadings (PDF shading types 4–7: free-form and lattice triangles, Coons and tensor
 * patches). pdf.js hands them over as triangles with a colour per vertex; we rasterize them
 * with Gouraud shading into a bitmap in shading space, as pdf.js's own renderer does.
 */
import { type Canvas, createCanvas } from "@napi-rs/canvas";

/** pdf.js "Mesh" IR: [type, shadingType, coords, colors, vertexCount, bounds, bbox, background]. */
export type MeshIR = readonly [
  "Mesh",
  number,
  ArrayLike<number>,
  ArrayLike<number>,
  number,
  readonly number[] | null,
  readonly number[] | null,
  ArrayLike<number> | null,
];

/** Bitmaps larger than this per side are rendered at lower resolution. */
const MAX_SIDE = 4096;

export interface MeshBitmap {
  canvas: Canvas;
  /** Shading-space origin and size of the bitmap. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Rasterize a mesh at `scale` device pixels per shading unit. Returns undefined for an empty
 * mesh.
 */
export function rasterizeMesh(ir: MeshIR, scale: number): MeshBitmap | undefined {
  const [, , coords, colors, count, bounds] = ir;
  if (bounds === null || count < 3) return undefined;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = bounds;
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (!(w > 0 && h > 0)) return undefined;
  const k = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
  const width = Math.max(1, Math.ceil(w * k));
  const height = Math.max(1, Math.ceil(h * k));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const px = (i: number) => ((coords[i * 2] ?? 0) - bx0) * k;
  const py = (i: number) => ((coords[i * 2 + 1] ?? 0) - by0) * k;
  for (let i = 0; i + 2 < count; i += 3) triangle(image.data, width, height, colors, px, py, i);
  context.putImageData(image, 0, 0);
  return { canvas, x: bx0, y: by0, w: width / k, h: height / k };
}

/** Fill one triangle with colours interpolated barycentrically between its vertices. */
function triangle(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  colors: ArrayLike<number>,
  px: (i: number) => number,
  py: (i: number) => number,
  first: number,
): void {
  const [a, b, c] = [first, first + 1, first + 2];
  const [ax, ay, bx, by, cx, cy] = [px(a), py(a), px(b), py(b), px(c), py(c)];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  // Half a pixel of slack closes the hairline gaps between neighbouring triangles.
  const slack = 0.5 / Math.sqrt(Math.abs(area));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const sx = x + 0.5;
      const wa = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
      const wb = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
      const wc = 1 - wa - wb;
      if (wa < -slack || wb < -slack || wc < -slack) continue;
      const j = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[j + ch] =
          wa * (colors[a * 4 + ch] ?? 0) +
          wb * (colors[b * 4 + ch] ?? 0) +
          wc * (colors[c * 4 + ch] ?? 0);
      }
      out[j + 3] = 255;
    }
  }
}
