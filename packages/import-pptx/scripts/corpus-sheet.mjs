// Dev helper: (reference | reconstructed) contact sheet for PPTX files.
// Reference = LibreOffice → PDF → pdf.js. Usage: node scripts/corpus-sheet.mjs out.png 1,5,9 deck.pptx …
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPptx } from "../dist/index.mjs";

const SOFFICE = process.env.SOFFICE ?? "C:/Program Files/LibreOffice/program/soffice.exe";
const [out, pageSpec, ...files] = process.argv.slice(2);
const W = 320;
const rows = [];
for (const file of files) {
  const pages = pageSpec.split(",").map(Number);
  const dir = mkdtempSync(join(tmpdir(), "figbridge-ref-"));
  execFileSync(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", dir, file], {
    stdio: "ignore",
  });
  const pdf = new Uint8Array(readFileSync(join(dir, basename(file).replace(/\.pptx$/i, ".pdf"))));
  const doc = await pdfjs.getDocument({ data: pdf, verbosity: 0 }).promise;
  const valid = pages.filter((n) => n <= doc.numPages);
  const result = await importPptx(new Uint8Array(readFileSync(file)), file, { pages: valid });
  console.log(basename(file), result.warnings.slice(0, 5).join("; "));
  for (const [i, slide] of result.scene.slides.entries()) {
    const page = await doc.getPage(valid[i]);
    const vp = page.getViewport({ scale: W / page.view[2] });
    const { canvas: ref } = doc.canvasFactory.create(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvas: ref, viewport: vp }).promise;
    const ours = await loadImage(
      await renderSlide(slide, (b) => result.blobs.get(b)?.bytes, { scale: W / slide.width }),
    );
    rows.push({ label: `${basename(file).slice(0, 30)} s${valid[i]}`, ref, ours });
  }
}
const rowH = Math.max(...rows.map((r) => r.ref.height)) + 16;
const sheet = createCanvas(W * 2 + 12, rows.length * rowH);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, sheet.width, sheet.height);
rows.forEach((r, i) => {
  ctx.fillStyle = "#c00";
  ctx.font = "11px sans-serif";
  ctx.fillText(r.label, 2, i * rowH + 11);
  ctx.drawImage(r.ref, 0, i * rowH + 14);
  ctx.drawImage(r.ours, W + 12, i * rowH + 14);
});
writeFileSync(out, sheet.toBuffer("image/png"));
console.log("sheet", out, rows.length);
