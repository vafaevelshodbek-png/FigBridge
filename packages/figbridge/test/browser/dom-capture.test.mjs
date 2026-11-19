import assert from "node:assert/strict";
import { chromium } from "playwright";
import { captureDOM, prepareDOM } from "../../web/capture-dom.mjs";
import { normalizeCapture } from "../../web/normalize-capture.mjs";

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(
    `<style>body{margin:0;font-family:Arial}#scroll{position:absolute;left:10px;top:20px;width:300px;height:200px;overflow:auto}#far{position:absolute;left:3px;top:3500px;width:80px;height:50px;background:rgb(20,40,60)}#mask{width:100px;height:100px;mask-image:linear-gradient(black 0%,black 58%,transparent 100%);box-shadow:0 0 0 transparent;background:radial-gradient(circle at 50% 50%,red,transparent)}#pseudo{position:relative;width:100px;height:40px}#pseudo::before{content:'';position:absolute;top:0;left:5px;right:5px;height:1px;background:#123456}</style><div id="scroll"><div id="far">Editable</div></div><div id="mask"></div><div id="pseudo"></div><svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="red"/></svg>`,
  );
  const data = await page.evaluate(captureDOM, { name: "Regression fixture" });
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    n.children?.forEach(walk);
  };
  data.slide.children.forEach(walk);
  assert.equal(nodes.find((n) => n.name === "scroll").overflow, "BOTH");
  assert.deepEqual(
    ["x", "y", "w", "h"].map((k) => nodes.find((n) => n.name === "far")[k]),
    [3, 3500, 80, 50],
  );
  assert.equal(nodes.find((n) => n.name === "mask").mask[0].stops.at(-1).opacity, 0);
  assert.equal(nodes.find((n) => n.name === "mask").fills[0].type, "radial-gradient");
  assert.equal(nodes.find((n) => n.name === "mask").effects.length, 0);
  assert(nodes.some((n) => n.type === "svg" && n.svg.includes("<path")));
  assert(nodes.some((n) => n.type === "text" && n.characters === "Editable"));
  assert.equal(nodes.find((n) => n.type === "text" && n.characters === "Editable").sizing, "width");
  assert(nodes.some((n) => n.name === "::before" && n.x === 5 && n.w === 90 && n.h === 1));
  assert.equal(data.warnings.length, 0);
  await page.setContent(
    '<div id="mirror" style="position:relative;width:100px;height:40px;transform:scaleX(-1)"><div id="child" style="position:absolute;left:10px;top:0;width:30px;height:20px"></div></div>',
  );
  const mirrored = await page.evaluate(captureDOM, { selector: "#mirror" });
  assert.equal(mirrored.slide.children[0].flipX, true);
  assert.equal(mirrored.slide.children[0].children[0].x, 10);
  await page.setContent(
    '<div id="isolate" style="width:100px;height:100px;mask-image:linear-gradient(black,transparent);background:linear-gradient(red,transparent)"></div>',
  );
  const isolated = await page.evaluate(captureDOM, { selector: "#isolate" });
  assert.equal(isolated.slide.children[0].blendMode, "NORMAL");
  assert.equal(isolated.slide.children[0].fills[0].stops.at(-1).color, "#ff0000");
  await page.setContent(
    '<style>body{margin:0;height:2000px}</style><div style="position:fixed;top:20px;width:10px;height:10px"></div>',
  );
  await page.evaluate(() => scrollTo(0, 500));
  const scrolled = await page.evaluate(captureDOM, { fullPage: true });
  assert.equal(scrolled.slide.children[0].y, 0);
  assert.equal(scrolled.slide.children[0].children[0].y, 520);
  await page.setContent(
    '<style>body{margin:0}@keyframes enter{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}</style><div id="animated" style="width:30px;height:30px;animation:enter 10s both"></div>',
  );
  const animated = await page.evaluate(captureDOM, { selector: "#animated" });
  assert.equal(animated.slide.children[0].opacity, 1);
  assert.equal(
    await page.locator("#animated").evaluate((el) => getComputedStyle(el).transform),
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  await page.setContent('<video id="v" muted playsinline style="width:32px;height:24px"></video>');
  const emptyVideo = await page.evaluate(captureDOM);
  assert(emptyVideo.warnings.some((w) => w.includes("video has no decoded frame")));
  await page.setContent(
    '<base href="https://example.com/page"><video poster="" style="width:32px;height:24px"></video>',
  );
  const emptyPoster = await page.evaluate(captureDOM);
  assert.equal(
    emptyPoster.assets.length,
    0,
    "empty poster must not request the current HTML document",
  );
  await page.setContent('<video id="v" muted playsinline style="width:32px;height:24px"></video>');
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 24;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 32, 24);
    const v = document.getElementById("v");
    const stream = c.captureStream(0);
    v.srcObject = stream;
    const ready = new Promise((resolve) =>
      v.addEventListener("loadeddata", resolve, { once: true }),
    );
    const play = v.play();
    stream.getVideoTracks()[0].requestFrame();
    await ready;
    await play;
    v.pause();
  });
  const video = await page.evaluate(captureDOM);
  const videoImage = video.slide.children[0].children
    .find((n) => n.name === "v")
    .children.find((n) => n.type === "image");
  assert.equal(videoImage.name, "Original video frame");
  assert(videoImage.image.url.startsWith("data:image/png;base64,"));
  assert(video.warnings.some((w) => w.includes("video preserved as its original decoded frame")));
  await page.setContent(
    '<div id="repeat" style="width:300px;height:60px;background:repeating-linear-gradient(90deg,rgba(255,246,205,0) 0px,rgba(255,246,205,.32) 13.65px,rgba(255,246,205,0) 30.333px)"></div>',
  );
  const repeat = await page.evaluate(captureDOM, { selector: "#repeat" });
  assert.equal(repeat.slide.children[0].fills[0]?.type, "linear-gradient");
  assert(repeat.slide.children[0].fills[0].stops.length > 5);
  await page.setContent(
    '<input id="otp" placeholder="000000" style="text-align:center;letter-spacing:8px;font-size:24px">',
  );
  const otp = await page.evaluate(captureDOM, { selector: "#otp" });
  assert.equal(otp.slide.children[0].children[0].align, "center");
  assert.equal(otp.slide.children[0].children[0].runs[0].letterSpacing, 8);
  await page.setContent(
    '<style>body{margin:0}#app{position:relative;left:10px;top:20px}#guide{position:fixed;left:0;top:100px;width:100px;height:30px;z-index:55;background:green}#portal{position:fixed;inset:0;z-index:50;background:red}</style><div id="app"><div id="guide">Guide</div></div><div id="portal">Modal</div>',
  );
  const stacking = await page.evaluate(captureDOM, {});
  const body = normalizeCapture(stacking.slide).children[0];
  assert.equal(body.children.at(-1).name, "guide");
  assert.deepEqual([body.children.at(-1).x, body.children.at(-1).y], [0, 100]);
  assert.equal(await page.evaluate(() => document.elementFromPoint(5, 105).id), "guide");
  await page.setContent(
    '<style>body{margin:0}</style><img id="lazy" loading="lazy" style="position:absolute;top:5000px;width:100px;height:100px;object-fit:cover;object-position:100% 0%">',
  );
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 100;
    canvas.getContext("2d").fillRect(0, 0, 300, 100);
    document.querySelector("#lazy").src = canvas.toDataURL();
  });
  const prepared = await page.evaluate(prepareDOM, { fullPage: true });
  assert.deepEqual(prepared.scrollRestored, { x: 0, y: 0 });
  assert.equal(await page.evaluate(() => document.querySelector("#lazy").naturalWidth), 300);
  const lazyCapture = await page.evaluate(captureDOM, { selector: "#lazy" });
  const crop = lazyCapture.slide.children[0].children[0].image.crop;
  assert(Math.abs(crop.x - 2 / 3) < 1e-9 && crop.y === 0 && crop.w === 1 / 3 && crop.h === 1);
  await page.setContent(
    '<video id="poster" style="width:100px;height:100px" poster="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="></video>',
  );
  const poster = await page.evaluate(captureDOM, { selector: "#poster" });
  assert.equal(poster.slide.children[0].children[0].name, "Original video poster");
  await page.setContent(
    '<style>body{margin:0}</style><div style="width:1250px;height:100px"></div>',
  );
  assert.equal((await page.evaluate(captureDOM, { fullPage: true })).slide.width, 1250);
  assert.equal((await page.evaluate(captureDOM, {})).slide.width, 390);
  console.log("PASS: browser capture, media, input and stacking regressions");
} finally {
  await browser.close();
}
