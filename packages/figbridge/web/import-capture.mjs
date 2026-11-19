/** Upload a capture's original image assets and render through the normal validated bridge. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hubPort, loadOrCreateToken, RemoteHubClient, SlideSchema } from "../dist/index.mjs";
import { normalizeCapture } from "./normalize-capture.mjs";
import { scaleCapture } from "./scale-capture.mjs";
import { assertCaptureTarget, resolveCaptureSession } from "./target-session.mjs";

export async function importCapture(
  path,
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
  } = {},
) {
  if (!file || typeof file !== "string")
    throw new Error("Supply the expected Figma file name before importing");
  const data = JSON.parse(await readFile(path, "utf8"));
  normalizeCapture(data.slide);
  const client = new RemoteHubClient(`http://127.0.0.1:${hubPort()}`, loadOrCreateToken());
  session = await resolveCaptureSession(client, file, session);
  const info = await client.invoke("session.info", {}, { session });
  assertCaptureTarget(info, file, requireUnrestricted);
  if (pageId) await client.invoke("page.set", { pageId }, { session });
  const cache = new Map();
  async function visit(node) {
    if (node?.fontFamily?.endsWith(" Variable"))
      node.fontFamily = node.fontFamily.replace(/ Variable$/, "");
    if (node?.type === "image" && node.url) {
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
            const response = await fetch(url).catch((e) => {
              throw new Error(`Cannot fetch asset ${url}: ${e.message}`);
            });
            if (!response.ok) throw new Error(`Asset ${response.status}: ${url}`);
            let bytes = Buffer.from(await response.arrayBuffer());
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
  const slide = SlideSchema.parse(
    originalSize && data.originalSize
      ? scaleCapture(data.slide, data.originalSize.width / data.slide.width)
      : data.slide,
  );
  const result = await client.invoke(
    "scene.render",
    { slide, x, y, parentId: pageId, sourceKey: key || slide.name, strict },
    { session, timeoutMs: 300000 },
  );
  const record = {
    ...result,
    sourceWarnings: data.warnings || [],
    sourceCapture: path,
    key: key || slide.name,
    pageId,
    session,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path.replace(/\.json$/, ".figma.json"), JSON.stringify(record, null, 2));
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
