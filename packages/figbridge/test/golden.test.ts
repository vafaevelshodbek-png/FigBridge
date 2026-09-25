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
import { compareImages } from "@figbridge/scene/compare";
import { renderSlide } from "@figbridge/scene/render";
import { GlobalFonts } from "@napi-rs/canvas";
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
      const compared = await compareImages(readFileSync(goldenPath), actual, {
        tolerance: CHANNEL_TOLERANCE,
      });
      const resized = compared.resizedFrom;
      if (resized !== undefined || compared.ratio > MAX_DIFF_RATIO) {
        mkdirSync(OUTPUT, { recursive: true });
        writeFileSync(join(OUTPUT, name), actual);
        writeFileSync(join(OUTPUT, name.replace(/\.png$/, ".diff.png")), compared.diff);
        failures.push(
          resized === undefined
            ? `${name}: ${(compared.ratio * 100).toFixed(2)} % of pixels differ (see ${OUTPUT})`
            : `${name}: size changed to ${String(resized.width)}×${String(resized.height)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
