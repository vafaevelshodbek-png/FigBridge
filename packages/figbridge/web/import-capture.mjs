/** Upload a capture's original image assets and render through the normal validated bridge. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeCapture } from "./normalize-capture.mjs";
import { scaleCapture } from "./scale-capture.mjs";
import { assertCaptureTarget, resolveCaptureSession } from "./target-session.mjs";

export async function importCapture(path, options = {}) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const record = await importCaptureData(data, options);
  record.sourceCapture = path;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    /\.json$/i.test(path) ? path.replace(/\.json$/i, ".figma.json") : `${path}.figma.json`,
    JSON.stringify(record, null, 2),
  );
  return record;
}

/** Import in-memory browser output without rereading credentials or mutating the reference capture. */
export async function importCaptureData(
  capture,
  {
    key,
    pageId,
    x = 0,
    y = 0,
    file,
    session,
    strict = false,
    originalSize = false,
    staticAssetOrigin,
    requireUnrestricted = false,
    client: suppliedClient,
    signal,
  } = {},
) {
  if (!file || typeof file !== "string")
    throw new Error("Supply the expected Figma file name before importing");
  signal?.throwIfAborted();
  const data = structuredClone(capture);
  const sourceWarnings = [
    ...new Set([
      ...(data.warnings || []),
      ...(data.sourceWarnings || []),
      ...(data.preparation?.warnings || []),
    ]),
  ];
  if (strict && sourceWarnings.length)
    throw new Error(`Source capture has losses: ${sourceWarnings.join("; ")}`);
  // Resolve lazily: this helper is also consumed by the bundle that provides the API.
  const { hubPort, loadOrCreateToken, RemoteHubClient, SlideSchema } = await import(
    new URL("../dist/index.mjs", import.meta.url).href
  );
  normalizeCapture(data.slide);
  const client =
    suppliedClient || new RemoteHubClient(`http://127.0.0.1:${hubPort()}`, loadOrCreateToken());
  session = await resolveCaptureSession(client, file, session);
  const info = await client.invoke("session.info", {}, { session, signal });
  assertCaptureTarget(info, file, requireUnrestricted);
  const cache = new Map();
  let remainingBytes = 32 * 1024 * 1024;
  const assetSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  async function visit(node) {
    signal?.throwIfAborted();
    if (node?.fontFamily?.endsWith(" Variable"))
      node.fontFamily = node.fontFamily.replace(/ Variable$/, "");
    if (node?.type === "image" && node.url) {
      if (
        data.browser &&
        !node.url.startsWith("data:") &&
        !data.assetCache?.[node.url]?.startsWith("data:")
      )
        throw new Error(`Browser asset was not materialized: ${node.url}`);
      let url = data.assetCache?.[node.url] || node.url;
      if (staticAssetOrigin && /^https?:/.test(url)) {
        const parsed = new URL(url);
        if (/^\/(art|assets)\//.test(parsed.pathname))
          url = new URL(parsed.pathname, staticAssetOrigin).href;
      }
      if (!cache.has(url))
        cache.set(
          url,
          (async () => {
            const response = await fetch(url, { signal: assetSignal, redirect: "error" }).catch(
              (e) => {
                throw new Error(`Cannot fetch asset ${url}: ${e.message}`);
              },
            );
            if (!response.ok) throw new Error(`Asset ${response.status}: ${url}`);
            const reader = response.body?.getReader();
            if (!reader) throw new Error(`Empty asset body: ${url}`);
            const chunks = [];
            let size = 0;
            try {
              for (;;) {
                assetSignal.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                remainingBytes -= value.byteLength;
                if (size > 8 * 1024 * 1024 || remainingBytes < 0)
                  throw new Error(`Asset byte budget exceeded: ${url}`);
                chunks.push(value);
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            let bytes = Buffer.concat(chunks);
            let mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
            // Figma accepts PNG/JPEG, not WebP. Decode original losslessly, preserving dimensions and alpha.
            if (!["image/png", "image/jpeg"].includes(mime)) {
              const { createCanvas, loadImage } = await import("@napi-rs/canvas");
              const image = await loadImage(bytes);
              const canvas = createCanvas(image.width, image.height);
              canvas.getContext("2d").drawImage(image, 0, 0);
              bytes = canvas.toBuffer("image/png");
              mime = "image/png";
            }
            return client.putBlob(bytes, mime);
          })(),
        );
      node.blob = await cache.get(url);
      delete node.url;
    }
    if (Array.isArray(node)) for (const n of node) await visit(n);
    else if (node && typeof node === "object")
      for (const value of Object.values(node)) await visit(value);
  }
  await visit(data.slide);
  signal?.throwIfAborted();
  const slide = SlideSchema.parse(
    originalSize && data.originalSize
      ? scaleCapture(data.slide, data.originalSize.width / data.slide.width)
      : data.slide,
  );
  const result = await client.invoke(
    "scene.render",
    { slide, x, y, parentId: pageId, sourceKey: key || slide.name, strict },
    { session, signal, timeoutMs: 300000 },
  );
  const record = {
    ...result,
    sourceWarnings,
    key: key || slide.name,
    pageId,
    session,
  };
  return record;
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/import-capture.mjs")) {
  const [path, key, pageId, x, y, file] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await importCapture(path, { key, pageId, x: Number(x) || 0, y: Number(y) || 0, file }),
      null,
      2,
    ),
  );
}
