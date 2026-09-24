// Dev helper: for several PDFs, import a few pages and build contact sheets of
// (original | reconstructed) pairs. Usage: node corpus-sheet.mjs out.png pages file1 file2 …
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdf } from "../dist/index.mjs";

const [out, pageSpec, ...files] = process.argv.slice(2);
const W = 320;
const rows = [];
for (const file of files) {
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data.slice(), verbosity: 0 }).promise;
  const pages = pageSpec
    .split(",")
    .map(Number)
    .filter((n) => n <= doc.numPages);
  const t0 = Date.now();
  let result;
  try {
    result = await importPdf(data.slice(), file, { pages });
  } catch (error) {
    console.log(basename(file), "FAILED", error.message);
    continue;
  }
  console.log(basename(file), `${String(Date.now() - t0)} ms`, result.warnings.join("; "));
  for (const [i, slide] of result.scene.slides.entries()) {
    const page = await doc.getPage(pages[i]);
    const scale = W / page.view[2];
    const vp = page.getViewport({ scale });
    const { canvas: ref } = doc.canvasFactory.create(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvas: ref, viewport: vp }).promise;
    const ours = await loadImage(
      await renderSlide(slide, (b) => result.blobs.get(b)?.bytes, { scale: W / slide.width }),
    );
    rows.push({ label: `${basename(file).slice(0, 28)} p${pages[i]}`, ref, ours });
  }
}
const rowH = Math.max(...rows.map((r) => r.ref.height)) + 16;
const sheet = createCanvas(W * 2 + 12, rows.length * rowH);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, sheet.width, sheet.height);
rows.forEach((r, i) => {
  ctx.fillStyle = "#c00";
  ctx.font = "11px sans-serif";
  ctx.fillText(r.label, 2, i * rowH + 11);
  ctx.drawImage(r.ref, 0, i * rowH + 14);
  ctx.drawImage(r.ours, W + 12, i * rowH + 14);
});
writeFileSync(out, sheet.toBuffer("image/png"));
console.log("sheet", out, rows.length, "rows");
