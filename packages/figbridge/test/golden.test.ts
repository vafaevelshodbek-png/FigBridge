/**
 * Golden tests: every corpus document is imported, drawn by the reference renderer and
 * compared with a checked-in image (corpus/golden/). A change that moves, recolours or
 * drops anything on a slide fails here, with the actual image and a diff map written to
 * test-output/golden/ (uploaded by CI).
 *
 * Text is drawn in Liberation Sans (bundled with pdf.js, SIL OFL) so the images do not
 * depend on the fonts installed on the machine.
 *
 * After an intended change: UPDATE_GOLDEN=1 pnpm vitest run --project figbridge golden
 * then look at the changed images before committing them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPdf } from "@figbridge/import-pdf";
import { importPptx } from "@figbridge/import-pptx";
import { renderSlide } from "@figbridge/scene/render";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CORPUS = join(REPO, "corpus");
const GOLDEN = join(CORPUS, "golden");
const OUTPUT = join(REPO, "test-output", "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] !== undefined;

/** Render at half size: enough to see any layout change, small enough to keep in git. */
const SCALE = 0.5;
/** A pixel differs when any channel moves by more than this (absorbs antialiasing noise). */
const CHANNEL_TOLERANCE = 40;
/** A slide fails when more than this share of its pixels differ. */
const MAX_DIFF_RATIO = 0.003;
/** PDF pages per document. */
const PDF_PAGES = [1, 2, 3];
const FONT = "Liberation Sans";

beforeAll(() => {
  const pdfjs = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  for (const face of ["Regular", "Bold", "Italic", "BoldItalic"]) {
    GlobalFonts.registerFromPath(join(pdfjs, "standard_fonts", `LiberationSans-${face}.ttf`), FONT);
  }
});

async function pixels(png: Uint8Array) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

/** Share of differing pixels, and a diff map (red = differs, faded original elsewhere). */
async function compare(actual: Uint8Array, expected: Uint8Array) {
  const a = await pixels(actual);
  const e = await pixels(expected);
  if (a.width !== e.width || a.height !== e.height) return { ratio: 1, map: undefined };
  const map = createCanvas(a.width, a.height);
  const out = map.getContext("2d").createImageData(a.width, a.height);
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++)
      delta = Math.max(delta, Math.abs((a.data[i + c] ?? 0) - (e.data[i + c] ?? 0)));
    const differs = delta > CHANNEL_TOLERANCE;
    if (differs) differing++;
    const grey = 255 - ((255 - (e.data[i] ?? 255)) >> 2);
    out.data.set(differs ? [255, 0, 0, 255] : [grey, grey, grey, 255], i);
  }
  map.getContext("2d").putImageData(out, 0, 0);
  return { ratio: differing / (a.width * a.height), map: map.toBuffer("image/png") };
}

const documents = readdirSync(CORPUS).filter((f) => /\.(pdf|pptx)$/i.test(f));

describe.each(documents)("%s matches its golden images", (file) => {
  it("every slide", async () => {
    const data = new Uint8Array(readFileSync(join(CORPUS, file)));
    const result = file.endsWith(".pdf")
      ? await importPdf(data, file, { pages: PDF_PAGES })
      : await importPptx(data, file);
    const failures: string[] = [];
    for (const [index, slide] of result.scene.slides.entries()) {
      const name = `${file}.p${String(index + 1)}.png`;
      const actual = await renderSlide(slide, (blob) => result.blobs.get(blob)?.bytes, {
        scale: SCALE,
        fontFamily: FONT,
      });
      const goldenPath = join(GOLDEN, name);
      if (UPDATE || !existsSync(goldenPath)) {
        if (!UPDATE) failures.push(`${name}: no golden image (run with UPDATE_GOLDEN=1)`);
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(goldenPath, actual);
        continue;
      }
      const { ratio, map } = await compare(actual, readFileSync(goldenPath));
      if (ratio > MAX_DIFF_RATIO) {
        mkdirSync(OUTPUT, { recursive: true });
        writeFileSync(join(OUTPUT, name), actual);
        if (map !== undefined)
          writeFileSync(join(OUTPUT, name.replace(/\.png$/, ".diff.png")), map);
        failures.push(`${name}: ${(ratio * 100).toFixed(2)} % of pixels differ (see ${OUTPUT})`);
      }
    }
    expect(failures).toEqual([]);
  });
});
