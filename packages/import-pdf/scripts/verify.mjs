// Dev helper: import PDF pages, render the Scene with the reference rasterizer and put it
// next to pdf.js's render of the original. Writes C:/dev/tmp-verify/<page>.png
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdf } from "../dist/index.mjs";

const [file, pages = "1"] = process.argv.slice(2);
const numbers = pages.split(",").map(Number);
const data = new Uint8Array(readFileSync(file));
const { scene, blobs } = await importPdf(data.slice(), file, { pages: numbers });
const doc = await pdfjs.getDocument({ data: data.slice(), verbosity: 0 }).promise;
mkdirSync("C:/dev/tmp-verify", { recursive: true });
const S = 0.5;
for (const [i, slide] of scene.slides.entries()) {
  const page = await doc.getPage(numbers[i]);
  const vp = page.getViewport({ scale: (slide.width / page.view[2]) * S });
  const { canvas: ref } = doc.canvasFactory.create(Math.round(vp.width), Math.round(vp.height));
  await page.render({ canvas: ref, viewport: vp }).promise;
  const ours = await loadImage(await renderSlide(slide, (b) => blobs.get(b)?.bytes, { scale: S }));
  const out = createCanvas(ref.width, ref.height * 2 + 8);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(ref, 0, 0);
  ctx.drawImage(ours, 0, ref.height + 8);
  writeFileSync(`C:/dev/tmp-verify/${slide.name}.png`, out.toBuffer("image/png"));
  console.log("wrote", slide.name);
}
