// Dev helper: import each deck, draw every slide with the reference renderer, compare with
// LibreOffice's render of the same deck, and rank slides by differing pixels.
// Usage: node scripts/rank.mjs <out-dir> <deck.pptx>…   (writes ranking.json and PNGs)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { importPptx } from "@figbridge/import-pptx";
import { compareImages } from "@figbridge/scene/compare";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.exe";
const WIDTH = 480;
const [out, ...decks] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const results = [];
for (const [d, deck] of decks.entries()) {
  const tag = `d${String(d + 1)}`;
  const copy = join(out, `${tag}.pptx`);
  copyFileSync(deck, copy);
  const pdf = join(out, `${tag}.pdf`);
  if (!existsSync(pdf)) {
    try {
      execFileSync(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", out, copy], {
        stdio: "ignore",
        timeout: 300_000,
      });
    } catch {
      process.stdout.write(`skip ${basename(deck)}: LibreOffice failed\n`);
      continue;
    }
  }
  let result;
  try {
    result = await importPptx(new Uint8Array(readFileSync(deck)), basename(deck));
  } catch (error) {
    process.stdout.write(`FAIL ${basename(deck)}: ${String(error)}\n`);
    results.push({ deck: basename(deck), slide: 0, ratio: 1, error: String(error) });
    continue;
  }
  const doc = await getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
  for (const [i, slide] of result.scene.slides.entries()) {
    if (i >= doc.numPages) break;
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: WIDTH / page.view[2] });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    const ref = canvas.toBuffer("image/png");
    const ours = await renderSlide(slide, (b) => result.blobs.get(b)?.bytes, {
      scale: WIDTH / slide.width,
    });
    const cmp = await compareImages(ref, ours);
    const name = `${tag}-s${String(i + 1)}`;
    writeFileSync(join(out, `${name}-ref.png`), ref);
    writeFileSync(join(out, `${name}-ours.png`), ours);
    results.push({
      deck: basename(deck),
      tag,
      slide: i + 1,
      ratio: cmp.ratio,
      warnings: result.warnings.filter((w) => w.startsWith(`slide ${String(i + 1)}:`)).length,
    });
  }
  process.stdout.write(`${basename(deck)}: ${String(result.scene.slides.length)} slides\n`);
}
results.sort((a, b) => b.ratio - a.ratio);
writeFileSync(join(out, "ranking.json"), JSON.stringify(results, null, 1));
