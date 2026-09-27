/**
 * Export a node and return bytes in the requested format. When Figma's raster export is stuck,
 * the plugin answers with SVG; it is rasterized here at the size the raster would have had.
 */
import { METHODS, type MethodParamsParsed } from "@figbridge/protocol";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { HubClient, InvokeOptions } from "./client.js";

export interface ExportedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

const SVG = "image/svg+xml";

export async function exportNode(
  client: HubClient,
  params: MethodParamsParsed<"node.export">,
  call: InvokeOptions = {},
): Promise<ExportedImage> {
  const exported = await client.call("node.export", params, {
    timeoutMs: METHODS["node.export"].timeoutMs,
    ...call,
  });
  const { bytes } = await client.getBlob(exported.blob);
  const size = { width: exported.width, height: exported.height };
  if (params.format === "svg" || exported.mimeType !== SVG)
    return { bytes, mimeType: exported.mimeType, ...size };
  return { ...(await rasterizeSvg(bytes, params.format, size)), ...size };
}

/** Draw SVG bytes into a PNG or JPEG of the given size. */
export async function rasterizeSvg(
  svg: Uint8Array,
  format: "png" | "jpg",
  size: { width: number; height: number },
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(Math.max(1, size.width), Math.max(1, size.height));
  const context = canvas.getContext("2d");
  if (format === "jpg") {
    // JPEG has no alpha: Figma's own JPG export puts transparent areas on white.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return format === "png"
    ? { bytes: new Uint8Array(canvas.toBuffer("image/png")), mimeType: "image/png" }
    : { bytes: new Uint8Array(canvas.toBuffer("image/jpeg", 92)), mimeType: "image/jpeg" };
}
