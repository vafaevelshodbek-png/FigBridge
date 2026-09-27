/**
 * Access to pdf.js internals: asset folders for Node, font names, and decoded objects (images,
 * shadings) that pdf.js resolves asynchronously.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CompositeSources, DecodedImage, ShadingIR } from "./compositor.js";
import type { Primitive } from "./primitives.js";

/**
 * pdf.js loads its image decoders (JBIG2, JPEG 2000 — common in scans), CJK character maps
 * and the standard 14 fonts from these folders; in Node they must be given as paths.
 */
export const PDFJS_ROOT = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);

export const PDFJS_ASSETS = {
  wasmUrl: `${join(PDFJS_ROOT, "wasm")}/`,
  cMapUrl: `${join(PDFJS_ROOT, "cmaps")}/`,
  cMapPacked: true,
  standardFontDataUrl: `${join(PDFJS_ROOT, "standard_fonts")}/`,
};

export function fontName(page: PDFPageProxy, id: string): string {
  try {
    const font = page.commonObjs.get(id) as { name?: string } | undefined;
    return font?.name ?? id;
  } catch {
    return id;
  }
}

/** pdf.js keeps objects shared across pages (ids starting with "g_") in `commonObjs`. */
export function storeFor(page: PDFPageProxy, id: string) {
  return id.startsWith("g_") ? page.commonObjs : page.objs;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of pdf.js's untyped object store
export function getObject<T>(page: PDFPageProxy, id: string): T | undefined {
  try {
    // Objects pdf.js failed to decode resolve to null.
    return (storeFor(page, id).get(id) as T | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolve once pdf.js has decoded the object, or after `timeoutMs` (reported as missing). */
export function whenResolved(page: PDFPageProxy, id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    storeFor(page, id).get(id, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** How long to wait for pdf.js to decode one image before giving up on it. */
export const IMAGE_DECODE_TIMEOUT_MS = 15_000;

export async function rasterSources(
  page: PDFPageProxy,
  primitives: readonly Primitive[],
  masks: CompositeSources["masks"],
  warnings: string[],
): Promise<CompositeSources> {
  // Make sure every referenced image object is resolved before synchronous compositing.
  const ids = new Set<string>();
  const collect = (list: readonly Primitive[]) => {
    for (const p of list) if (p.kind === "image" && "objId" in p.source) ids.add(p.source.objId);
  };
  collect(primitives);
  for (const mask of masks.values()) collect(mask.primitives);
  const resolved = await Promise.all(
    [...ids].map((id) => whenResolved(page, id, IMAGE_DECODE_TIMEOUT_MS)),
  );
  const missing = resolved.filter((ok) => !ok).length;
  if (missing > 0)
    warnings.push(
      `page ${String(page.pageNumber)}: ${String(missing)} image(s) could not be decoded`,
    );
  return {
    masks,
    image: (source) =>
      "objId" in source
        ? getObject<DecodedImage>(page, source.objId)
        : (source.inline as DecodedImage | undefined),
    shading: (pattern) => getObject<ShadingIR>(page, pattern),
    skipped: (what) => {
      const message = `page ${String(page.pageNumber)}: ${what} was skipped`;
      if (!warnings.includes(message)) warnings.push(message);
    },
  };
}
