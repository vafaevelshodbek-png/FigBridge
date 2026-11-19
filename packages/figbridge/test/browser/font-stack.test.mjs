import assert from "node:assert/strict";
import { chromium } from "playwright";
import { captureDOM } from "../../web/capture-dom.mjs";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(
    `<p style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;font-size:20px">Browser font fallback</p>`,
  );
  const capture = await page.evaluate(captureDOM, { fullPage: false });
  const nodes = [];
  const visit = (n) => {
    nodes.push(n);
    n.children?.forEach(visit);
  };
  visit(capture.slide);
  const text = nodes.find((n) => n.type === "text");
  assert.equal(
    text.runs[0].fontFamily,
    "Arial",
    "unsupported browser UI aliases resolve to the measured fallback",
  );
  console.log("PASS browser UI alias font stack resolves to measured concrete font");
} finally {
  await browser.close();
}
