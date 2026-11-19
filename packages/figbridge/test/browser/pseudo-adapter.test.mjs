import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { capturePage } from "../../web/browser-capture.mjs";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="red"/></svg>';
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.end(svg);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/icon.svg`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.setContent(
    `<style>body{margin:0}#host{position:absolute;left:20px;top:30px;width:120px;height:60px}#host::before{content:'Label';position:absolute;left:7px;top:9px;width:60px;height:20px;font:16px Arial;color:blue}#host::after{content:'';position:absolute;left:90px;top:2px;width:16px;height:16px;background:url('${url}') center/contain no-repeat}#offscreen{position:absolute;top:1000px}#offscreen::after{content:'';display:block;width:16px;height:16px;background:url('${url}?offscreen') center/contain no-repeat}</style><div id="host"></div><div id="offscreen"></div>`,
  );
  const data = await capturePage(page, { fullPage: false });
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    n.children?.forEach(walk);
  };
  data.slide.children.forEach(walk);
  assert(
    nodes.some((n) => n.type === "text" && n.characters === "Label"),
    "generated text stays native",
  );
  assert(
    nodes.some((n) => n.type === "svg" && n.svg.includes("<circle")),
    "external pseudo SVG stays native",
  );
  assert(data.assetCache[url]);
  assert.equal(
    data.assetCache[`${url}?offscreen`],
    undefined,
    "offscreen pseudo assets are not materialized",
  );
  assert(!data.warnings.some((w) => w.includes("non-decorative pseudo")));
  assert.equal(
    await page
      .locator("*")
      .evaluateAll(
        (es) =>
          es
            .flatMap((e) => [...e.attributes])
            .filter((a) => a.name.startsWith("data-figbridge-pseudo-")).length,
      ),
    0,
    "temporary pseudo markers cleaned",
  );
  await page.setContent(
    `<iframe style="position:absolute;left:60px;top:80px;width:150px;height:100px" srcdoc="<style>body{margin:0}div::before{content:'';display:block;width:16px;height:16px;background:url('${url}?frame') center/contain no-repeat}</style><div></div>"></iframe>`,
  );
  const framed = await capturePage(page, { fullPage: false });
  const frameNodes = [];
  const visit = (n) => {
    frameNodes.push(n);
    n.children?.forEach(visit);
  };
  visit(framed.slide);
  assert(
    frameNodes.some((n) => n.type === "svg" && n.svg.includes("<circle")),
    "iframe pseudo SVG stays native",
  );
  assert(
    !framed.warnings.some(
      (w) => w.includes("pseudo geometry unavailable") || w.includes("non-decorative pseudo"),
    ),
    framed.warnings.join("; "),
  );
  assert(framed.assetCache[`${url}?frame`]);
  console.log(
    "PASS measured pseudo text/external SVG, iframe, viewport resources and marker cleanup",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
