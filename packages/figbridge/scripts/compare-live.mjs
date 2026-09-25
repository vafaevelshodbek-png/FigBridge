// Dev helper: compare frames imported into the connected Figma file with a reference PDF
// (e.g. LibreOffice's render of the source deck), page by page, and list the worst slides.
// Usage: node scripts/compare-live.mjs <reference.pdf> <frame-ids.json> <out-dir> [width]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareImages } from "@figbridge/scene/compare";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [reference, framesFile, out, widthArg] = process.argv.slice(2);
const width = Number(widthArg ?? 480);
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const frames = JSON.parse(readFileSync(framesFile, "utf8"));
mkdirSync(out, { recursive: true });

const doc = await getDocument({ data: new Uint8Array(readFileSync(reference)), verbosity: 0 })
  .promise;
const results = [];
for (const [i, frameId] of frames.entries()) {
  const page = await doc.getPage(i + 1);
  const viewport = page.getViewport({ scale: width / page.view[2] });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  const ref = canvas.toBuffer("image/png");
  const refPath = join(out, `ref-${String(i + 1)}.png`);
  writeFileSync(refPath, ref);
  const figPath = join(out, `fig-${String(i + 1)}.png`);
  execFileSync(
    process.execPath,
    [cli, "export", frameId, "-o", figPath, "--scale", String(width / 1920)],
    { stdio: "ignore" },
  );
  const compared = await compareImages(ref, readFileSync(figPath));
  results.push({ slide: i + 1, frameId, ratio: compared.ratio });
  writeFileSync(join(out, `diff-${String(i + 1)}.png`), compared.diff);
  process.stdout.write(`${String(i + 1)} ${(compared.ratio * 100).toFixed(1)}%\n`);
}
results.sort((a, b) => b.ratio - a.ratio);
writeFileSync(join(out, "ranking.json"), JSON.stringify(results, null, 1));
