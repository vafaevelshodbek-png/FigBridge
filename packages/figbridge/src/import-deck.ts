/**
 * Import a slide deck into the connected Figma file: convert to Scene, upload images once,
 * render slide frames in a grid. Shared by the MCP tool and the CLI.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { importPdf } from "@figbridge/import-pdf";
import { importPptx } from "@figbridge/import-pptx";
import { APPROVAL_TIMEOUT_MS, BridgeError, type MethodResult } from "@figbridge/protocol";
import { ulid } from "ulid";
import type { HubClient } from "./client.js";

export interface ImportDeckOptions {
  path: string;
  pages?: readonly number[] | undefined;
  /** Top-left of the grid on the current page; default: below everything already there. */
  x?: number | undefined;
  y?: number | undefined;
  columns?: number | undefined;
  gap?: number | undefined;
  session?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface ImportDeckResult {
  frames: { page: string; frameId: string; nodes: number }[];
  warnings: string[];
}

/** A slide can take long (many nodes, image decoding in Figma), after the user approves it. */
const SLIDE_TIMEOUT_MS = 180_000 + APPROVAL_TIMEOUT_MS;

export async function importDeck(
  client: HubClient,
  options: ImportDeckOptions,
): Promise<ImportDeckResult> {
  const extension = extname(options.path).toLowerCase();
  if (extension !== ".pdf" && extension !== ".pptx") {
    throw new BridgeError(
      "DOCUMENT_INVALID",
      `Unsupported file type "${extension}". Supported: .pdf, .pptx`,
    );
  }
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(options.path));
  } catch (error) {
    throw new BridgeError("DOCUMENT_INVALID", `Cannot read ${options.path}.`, { cause: error });
  }
  let converted: Awaited<ReturnType<typeof importPdf>>;
  try {
    const convert = extension === ".pptx" ? importPptx : importPdf;
    converted = await convert(data, basename(options.path), {
      ...(options.pages === undefined ? {} : { pages: options.pages }),
    });
  } catch (error) {
    throw new BridgeError(
      "DOCUMENT_INVALID",
      `Cannot convert ${basename(options.path)}: ${String(error)}`,
      { cause: error },
    );
  }
  const { scene, blobs, warnings } = converted;

  for (const [blob, { bytes, mimeType }] of blobs) {
    const stored = await client.putBlob(bytes, mimeType);
    if (stored !== blob) throw new BridgeError("INTERNAL", `Blob id mismatch for ${blob}.`);
  }

  // One key per slide of this import: a retry after a reconnect is answered from the plugin's
  // cache, but importing the same file again (e.g. after a fix) renders new frames.
  const run = ulid();
  const columns = options.columns ?? 6;
  const gap = options.gap ?? 200;
  const origin =
    options.x !== undefined && options.y !== undefined
      ? { x: options.x, y: options.y }
      : await freeSpot(client, options.session, options.signal, gap);
  const frames: ImportDeckResult["frames"] = [];
  for (const [index, slide] of scene.slides.entries()) {
    options.signal?.throwIfAborted();
    const x = origin.x + (index % columns) * (slide.width + gap);
    const y = origin.y + Math.floor(index / columns) * (slide.height + gap);
    let rendered: MethodResult<"scene.render">;
    try {
      rendered = await client.call(
        "scene.render",
        { slide, x, y },
        {
          session: options.session,
          signal: options.signal,
          timeoutMs: SLIDE_TIMEOUT_MS,
          idempotencyKey: `import:${run}:${String(index)}`,
        },
      );
    } catch (thrown) {
      // Frames already rendered stay in the file: say which, so the caller can resume
      // with `pages` or clean up instead of importing everything again.
      const error = BridgeError.from(thrown);
      throw new BridgeError(
        error.code,
        `Slide ${slide.name} failed: ${error.message} ${String(frames.length)} of ${String(scene.slides.length)} slides were imported before it.`,
        { data: { frames, failedPage: slide.name }, cause: thrown, retryable: error.retryable },
      );
    }
    frames.push({ page: slide.name, frameId: rendered.frameId, nodes: rendered.created });
    warnings.push(...rendered.warnings.map((w) => `slide ${slide.name}: ${w}`));
    options.onProgress?.(index + 1, scene.slides.length);
  }
  return { frames, warnings: [...new Set(warnings)] };
}

/** Top-level layers read when looking for free space (a page rarely has more). */
const OUTLINE_LIMIT = 500;

/**
 * Where a new grid goes when the caller did not say: left-aligned with the page's content,
 * one gap below its lowest layer — so importing several decks one after another stacks
 * them instead of piling them up at (0, 0). In Figma Slides placement does not apply.
 */
async function freeSpot(
  client: HubClient,
  session: string | undefined,
  signal: AbortSignal | undefined,
  gap: number,
): Promise<{ x: number; y: number }> {
  const { nodes } = await client.call(
    "document.outline",
    { depth: 1, limit: OUTLINE_LIMIT },
    { session, signal },
  );
  const boxes = nodes.flatMap((n) => (n.box === undefined ? [] : [n.box]));
  if (boxes.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.max(...boxes.map((b) => b.y + b.h)) + gap * 2,
  };
}
