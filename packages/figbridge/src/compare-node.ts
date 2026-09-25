/**
 * Compare a Figma node with an image file — a design frame against a screenshot of its
 * implementation, or an import against its source. Shared by `figma_compare` and
 * `figbridge compare`.
 */
import { readFile } from "node:fs/promises";
import { BridgeError, METHODS } from "@figbridge/protocol";
import { compareImages, DEFAULT_TOLERANCE, imageSize } from "@figbridge/scene/compare";
import type { HubClient } from "./client.js";

export interface CompareNodeOptions {
  nodeId: string;
  imagePath: string;
  tolerance?: number | undefined;
  session?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface CompareNodeResult {
  /** Share of differing pixels in percent, two decimals. */
  differingPercent: number;
  differingPixels: number;
  /** Size both images were compared at (the image's size). */
  width: number;
  height: number;
  /** The node's export size before scaling, when it did not match the image's aspect. */
  nodeResizedFrom?: { width: number; height: number };
  tolerance: number;
  verdict: "identical" | "close" | "different";
  /** PNG: differing pixels in red over a faded copy of the image. */
  diff: Buffer;
}

/** Up to this share of differing pixels reads as "close" (anti-aliasing, font hinting). */
const CLOSE = 0.005;

export async function compareNode(
  client: HubClient,
  options: CompareNodeOptions,
): Promise<CompareNodeResult> {
  let image: Uint8Array;
  try {
    image = new Uint8Array(await readFile(options.imagePath));
  } catch (error) {
    throw new BridgeError("DOCUMENT_INVALID", `Cannot read ${options.imagePath}.`, {
      cause: error,
    });
  }
  let size: { width: number; height: number };
  try {
    size = await imageSize(image);
  } catch (error) {
    throw new BridgeError("IMAGE_INVALID", `${options.imagePath} is not a PNG or JPEG image.`, {
      cause: error,
    });
  }
  const call = { session: options.session, signal: options.signal };
  const { node } = await client.call("node.get", { nodeId: options.nodeId }, call);
  const box = node["box"] as { w: number; h: number } | undefined;
  if (box === undefined || box.w <= 0) {
    throw new BridgeError("VALIDATION", `Node ${options.nodeId} has no size to compare.`);
  }
  // Export at the image's width, so a 2× screenshot compares at 2×.
  const scale = Math.min(4, Math.max(0.05, size.width / box.w));
  const exported = await client.call(
    "node.export",
    { nodeId: options.nodeId, format: "png", scale },
    { ...call, timeoutMs: METHODS["node.export"].timeoutMs },
  );
  const { bytes } = await client.getBlob(exported.blob);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  // The image is the reference frame of the comparison: the export is scaled to it.
  const result = await compareImages(image, bytes, { tolerance });
  return {
    differingPercent: Math.round(result.ratio * 10_000) / 100,
    differingPixels: result.differing,
    width: result.width,
    height: result.height,
    ...(result.resizedFrom === undefined ? {} : { nodeResizedFrom: result.resizedFrom }),
    tolerance,
    verdict: result.differing === 0 ? "identical" : result.ratio <= CLOSE ? "close" : "different",
    diff: result.diff,
  };
}
