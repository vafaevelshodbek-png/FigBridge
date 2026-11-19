import assert from "node:assert/strict";
import { chromium } from "playwright";
import { captureDOM } from "../web/capture-dom.mjs";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent("<style>body{margin:0}img{display:block;width:600px;height:456px}</style>");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1320;
    canvas.height = 456;
    const context = canvas.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 720, 456);
    context.fillStyle = "blue";
    context.fillRect(720, 0, 600, 456);
    for (const [id, fit, position] of [
      ["none", "none", "100% 0%"],
      ["fill", "fill", "50% 50%"],
      ["cover", "cover", "50% 50%"],
      ["scale", "scale-down", "50% 50%"],
      ["offset", "none", "10px 0px"],
    ]) {
      const img = new Image();
      img.id = id;
      img.style.objectFit = fit;
      img.style.objectPosition = position;
      img.src = canvas.toDataURL();
      document.body.append(img);
      await img.decode();
    }
    const small = new Image();
    small.id = "small";
    small.style.objectFit = "none";
    canvas.width = 30;
    canvas.height = 20;
    small.src = canvas.toDataURL();
    document.body.append(small);
    await small.decode();
  });
  const data = await page.evaluate(captureDOM, { fullPage: true });
  const nodes = [];
  const visit = (n) => {
    nodes.push(n);
    n.children?.forEach(visit);
  };
  data.slide.children.forEach(visit);
  const paint = (id) =>
    nodes.find((n) => n.name === id).children.find((n) => n.type === "image").image;
  const none = paint("none");
  assert.equal(none.scaleMode, "crop", "none uses explicit source crop");
  for (const [key, expected] of Object.entries({ x: 720 / 1320, y: 0, w: 600 / 1320, h: 1 }))
    assert(Math.abs(none.crop[key] - expected) < 1e-9, `none ${key}`);
  assert.deepEqual(
    paint("fill").crop,
    { x: 0, y: 0, w: 1, h: 1 },
    "CSS fill stretches complete source",
  );
  assert(Math.abs(paint("cover").crop.x - (1 - 600 / 1320) / 2) < 1e-9, "cover remains centered");
  assert.equal(paint("scale").scaleMode, "fit", "scale-down uses contain when source must shrink");
  assert(
    data.warnings.some((w) => w.includes("object-position")),
    "pixel-position fallback is explicit",
  );
  assert(
    data.warnings.some((w) => w.includes("object-fit: none")),
    "unrepresentable none letterboxing is explicit",
  );
  console.log(
    "PASS native object-fit none/fill/cover/scale-down source geometry and explicit fallback losses",
  );
} finally {
  await browser.close();
}
