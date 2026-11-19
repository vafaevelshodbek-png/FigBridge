import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { capturePage } from "../../web/browser-capture.mjs";
import { captureDOM } from "../../web/capture-dom.mjs";

let imageRequests = 0;
const server = createServer((_req, res) => {
  imageRequests++;
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const image = `http://127.0.0.1:${server.address().port}/broken.png`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(`<style>body{margin:0} .off{position:absolute;top:4000px;left:0;width:200px;height:100px}</style>
 <div>Visible main</div><div class="off" id="off"><img src="${image}" width="80" height="80"><span>Below fold</span></div>
 <div class="off" id="fixed-parent" style="overflow:hidden"><div id="fixed" style="position:fixed;top:30px;left:10px">Fixed visible</div></div>
 <div class="off" id="overflow-parent"><div id="overflow" style="position:absolute;top:-3900px">Overflow visible</div></div>
 <div style="position:absolute;top:150px;width:100px;height:20px;overflow:hidden"><div style="position:absolute;top:100px">Clipped child</div></div>
 <span style="position:absolute;clip-path:inset(50%);width:1px;height:1px">Screen reader only one</span>
 <span style="position:absolute;clip-path:inset(0px 100% 100% 0px)">Screen reader only two</span>
 <div style="position:absolute;top:250px;clip-path:circle(40%);width:80px;height:60px">Visible unsupported</div>`);
  await page.locator("img").evaluate((img) =>
    img.complete
      ? undefined
      : new Promise((r) => {
          img.onload = r;
          img.onerror = r;
        }),
  );
  const nodes = (data) => {
    const all = [];
    const visit = (n) => {
      all.push(n);
      n.children?.forEach(visit);
    };
    data.slide.children.forEach(visit);
    return all;
  };
  const viewport = await page.evaluate(captureDOM, { fullPage: false });
  const text = nodes(viewport)
    .map((n) => n.characters || "")
    .join(" ");
  assert(!text.includes("Below fold"), "viewport excludes below-fold text");
  assert(!viewport.assets.includes(image), "viewport excludes below-fold asset");
  assert(text.includes("Fixed visible"), "fixed descendant survives offscreen ancestor");
  assert(text.includes("Overflow visible"), "overflow descendant survives offscreen ancestor");
  assert(!text.includes("Clipped child"), "ancestor clipping excludes hidden descendant");
  assert(!text.includes("Screen reader only"), "empty inset excludes accessibility text");
  assert(
    viewport.warnings.some((w) => w.includes("circle(40%)")),
    "visible unsupported clip remains a loss",
  );
  const fixed = nodes(viewport).find((n) => n.characters === "Fixed visible");
  const boxes = nodes(viewport);
  const absolute = (target) => {
    let x = target.x,
      y = target.y;
    let n = target;
    for (;;) {
      const parent = boxes.find((p) => p.children?.includes(n));
      if (!parent) break;
      x += parent.x;
      y += parent.y;
      n = parent;
    }
    return { x, y };
  };
  assert(
    Math.abs(absolute(fixed).y - 30) < 10,
    "fixed geometry stays in original viewport coordinates",
  );
  const full = await page.evaluate(captureDOM, { fullPage: true });
  assert(
    nodes(full).some((n) => n.characters === "Below fold"),
    "full page retains below-fold text",
  );
  assert(full.assets.includes(image), "full page retains below-fold asset");
  const before = imageRequests;
  await capturePage(page, { fullPage: false, captureCdp: false });
  assert.equal(imageRequests, before, "adapter does not refetch excluded image");
  await page.setViewportSize({ width: 400, height: 300 });
  await page.setContent(
    `<style>body{margin:0}#shadow,#pseudo{position:absolute;left:420px;top:30px;width:40px;height:80px}#shadow{box-shadow:-60px 0 0 blue}#pseudo:before{content:'';position:absolute;left:-80px;top:100px;width:40px;height:40px;background:blue}</style><div id="shadow"></div><div id="pseudo"></div>`,
  );
  const overflow = await capturePage(page, { fullPage: false, captureCdp: false });
  assert(
    nodes(overflow).some((n) => n.effects?.some((e) => e.type === "DROP_SHADOW")),
    "offscreen host keeps shadow painting inside viewport",
  );
  assert(
    nodes(overflow).some((n) => n.source?.endsWith("::before")),
    "offscreen host keeps measured pseudo painting inside viewport",
  );
  console.log(
    "PASS viewport culling, fixed/overflow geometry, ancestor clipping, full-page resources and empty inset clips",
  );
} finally {
  await browser.close();
  server.close();
}
