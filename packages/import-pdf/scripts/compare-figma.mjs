// Dev helper: compare frames already imported into a live Figma file with the source PDF.
// Each frame is matched to the most similar page (imports often take a subset of pages),
// then pairs are ranked by differing pixels.
// Usage: node scripts/compare-figma.mjs <session> <frame-name-prefix> <file.pdf> <out-dir> [order]
// With "order", frame N is page N (needed when a frame came out blank and matches anything).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareImages } from "@figbridge/scene/compare";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { hubPort, loadOrCreateToken, RemoteHubClient } from "../../figbridge/dist/index.mjs";

const WIDTH = 480;
const [session, prefix, file, out, mode] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const client = new RemoteHubClient(`http://127.0.0.1:${String(hubPort())}`, loadOrCreateToken());

const { nodes } = await client.call("document.outline", { depth: 1, limit: 500 }, { session });
const frames = nodes
  .filter((n) => n.type === "FRAME" && n.name.startsWith(`${prefix} · `))
  .sort((a, b) => a.name.localeCompare(b.name));

const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const viewport = page.getViewport({ scale: WIDTH / page.view[2] });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  pages.push({
    number: p,
    png: canvas.toBuffer("image/png"),
    aspect: viewport.height / viewport.width,
  });
}

const results = [];
let cursor = 0;
for (const frame of frames) {
  const exported = await client.call(
    "node.export",
    { nodeId: frame.id, format: "png", scale: WIDTH / frame.box.w },
    { session, timeoutMs: 60_000 },
  );
  let { bytes } = await client.getBlob(exported.blob);
  try {
    if (exported.mimeType === "image/svg+xml") {
      const image = await loadImage(Buffer.from(bytes));
      const canvas = createCanvas(exported.width, exported.height);
      canvas.getContext("2d").drawImage(image, 0, 0, exported.width, exported.height);
      bytes = canvas.toBuffer("image/png");
    }
    await loadImage(Buffer.from(bytes));
  } catch (error) {
    const head = Buffer.from(bytes.slice(0, 16)).toString("hex");
    writeFileSync(join(out, `${frame.name.replace(/[^\w]+/g, "_")}-bad.bin`), bytes);
    results.push({
      frame: frame.name,
      id: frame.id,
      page: 0,
      ratio: 1,
      error: `${String(error)} ${exported.mimeType} ${String(bytes.length)} bytes, head ${head}`,
    });
    process.stdout.write(`${frame.name}: unreadable export (${exported.mimeType}, ${String(bytes.length)} bytes, head ${head})
`);
    continue;
  }
  const aspect = frame.box.h / frame.box.w;
  // Pages keep their order: search forward from the last match, same aspect ratio only.
  let best;
  const number = Number(frame.name.split(" · ").pop());
  const candidates =
    mode === "order" ? pages.filter((p) => p.number === number) : pages.slice(cursor);
  for (const page of candidates) {
    if (mode !== "order" && Math.abs(page.aspect - aspect) / aspect > 0.03) continue;
    const { ratio } = await compareImages(page.png, bytes);
    if (best === undefined || ratio < best.ratio) best = { page, ratio };
  }
  if (best === undefined) {
    results.push({ frame: frame.name, id: frame.id, page: 0, ratio: 1 });
    continue;
  }
  cursor = best.page.number - 1;
  const tag = frame.name.replace(/[^\w]+/g, "_");
  writeFileSync(join(out, `${tag}-ref.png`), best.page.png);
  writeFileSync(join(out, `${tag}-fig.png`), bytes);
  results.push({ frame: frame.name, id: frame.id, page: best.page.number, ratio: best.ratio, tag });
  process.stdout.write(`${frame.name} ↔ p${String(best.page.number)} ${best.ratio.toFixed(3)}\n`);
}
results.sort((a, b) => b.ratio - a.ratio);
writeFileSync(join(out, "ranking.json"), JSON.stringify(results, null, 1));
