// Dev helper: import pages of each PDF, draw them with the reference renderer, compare with
// pdf.js's own render of the page, and rank pages by differing pixels.
// Usage: node scripts/rank.mjs <out-dir> <pages e.g. 1-5> <file.pdf>…
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { importPdf } from "@figbridge/import-pdf";
import { compareImages } from "@figbridge/scene/compare";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const WIDTH = 480;
const [out, range, ...files] = process.argv.slice(2);
const [from, to] = range.split("-").map(Number);
mkdirSync(out, { recursive: true });
const results = [];
for (const [d, file] of files.entries()) {
  const data = new Uint8Array(readFileSync(file));
  // Import first, then open the reference: two pdf.js documents alive at once crash the
  // native canvas while registering fonts (dev-tool only; the importer opens one).
  const count = (await getDocument({ data: data.slice(), verbosity: 0 }).promise).numPages;
  const pages = [];
  for (let p = from; p <= Math.min(to, count); p++) pages.push(p);
  let result;
  try {
    result = await importPdf(data.slice(), basename(file), { pages });
  } catch (error) {
    results.push({ file: basename(file), page: 0, ratio: 1, error: String(error) });
    continue;
  }
  const doc = await getDocument({ data: data.slice(), verbosity: 0 }).promise;
  for (const [i, slide] of result.scene.slides.entries()) {
    const page = await doc.getPage(pages[i]);
    const viewport = page.getViewport({ scale: WIDTH / (page.view[2] - page.view[0]) });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    const ref = canvas.toBuffer("image/png");
    const ours = await renderSlide(slide, (b) => result.blobs.get(b)?.bytes, {
      scale: WIDTH / slide.width,
    });
    const cmp = await compareImages(ref, ours);
    const name = `f${String(d + 1)}-p${String(pages[i])}`;
    writeFileSync(join(out, `${name}-ref.png`), ref);
    writeFileSync(join(out, `${name}-ours.png`), ours);
    results.push({ file: basename(file), tag: name, page: pages[i], ratio: cmp.ratio });
  }
}
results.sort((a, b) => b.ratio - a.ratio);
writeFileSync(join(out, "ranking.json"), JSON.stringify(results, null, 1));
