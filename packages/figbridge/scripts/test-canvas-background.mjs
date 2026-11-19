import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { chromium } from "playwright";
import { captureDOM } from "../web/capture-dom.mjs";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  for (const [css, expected] of [
    ["", [255, 255, 255]],
    ["html{background:rgb(20,40,60)}", [20, 40, 60]],
    ["body{background:rgb(12,24,36)}", [12, 24, 36]],
    ["body{background:rgba(0,0,0,.5)}", [127, 127, 127]],
  ]) {
    await page.setContent(
      `<style>body{margin:0;height:30px}${css}</style><main id="selected" style="height:20px">Text</main>`,
    );
    for (const fullPage of [false, true]) {
      const capture = await page.evaluate(captureDOM, { fullPage });
      const image = await loadImage(await page.screenshot({ fullPage }));
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext("2d").drawImage(image, 0, 0);
      const pixel = [...canvas.getContext("2d").getImageData(200, 200, 1, 1).data];
      assert.equal(pixel[3], 255, "reference canvas is opaque");
      const background = capture.slide.background;
      assert.equal(background.length, 1, "native canvas has one opaque color");
      assert.equal(background[0].opacity, 1, "native canvas opacity matches reference");
      const rgb = background[0].color.match(/[a-f\d]{2}/gi).map((v) => parseInt(v, 16));
      assert.deepEqual(rgb, pixel.slice(0, 3), "native canvas matches browser below body");
      assert(
        rgb.every((v, i) => Math.abs(v - expected[i]) <= 1),
        "fixture expected canvas color",
      );
      if (css.includes("rgba"))
        assert.equal(
          capture.slide.children[0].fills.length,
          0,
          "propagated translucent body is not painted twice",
        );
    }
    const selected = await page.evaluate(captureDOM, { selector: "#selected" });
    assert.deepEqual(
      selected.slide.background,
      [],
      "selector keeps its transparent canvas semantics",
    );
  }
  console.log(
    "PASS opaque browser canvas, html/body propagation, translucent body and selector transparency",
  );
} finally {
  await browser.close();
}
