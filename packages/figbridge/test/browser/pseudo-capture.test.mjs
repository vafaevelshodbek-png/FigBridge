import assert from "node:assert/strict";
import { chromium } from "playwright";
import { captureDOM } from "../../web/capture-dom.mjs";
import {
  clearPseudoHosts,
  markPseudoHosts,
  pseudoGeometryFromSnapshot,
} from "../../web/pseudo-capture.mjs";

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><clipPath id="cut"><rect width="24" height="24"/></clipPath></defs><path clip-path="url(#cut)" fill="red" d="M0 0h24v24H0z"/></svg>')}`;
  await page.setContent(
    `<style>body{margin:0}.host{margin:40px;display:flex;align-items:flex-start;width:100px;height:40px}.triangle:after{content:'';display:inline-block;position:relative;top:7px;border-top:6px solid black;border-left:6px solid transparent;border-right:6px solid transparent;transform:translateY(-3px)}.icon:before{content:'';display:block;width:24px;height:24px;background:url("${svg}") center/contain no-repeat}.zero:before{content:' ';display:table}.unsupported:after{content:'hello';display:inline;transform:rotate(10deg)}</style><div class="host triangle"></div><div class="host icon"></div><div class="host zero"></div><div class="host unsupported"></div>`,
  );
  const markers = await markPseudoHosts(page);
  const cdp = await page.context().newCDPSession(page);
  const snap = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includeDOMRects: true,
    includePaintOrder: true,
  });
  const geometry = pseudoGeometryFromSnapshot(snap, markers.attribute);
  const data = await page.evaluate(captureDOM, { pseudoGeometry: geometry, fullPage: false });
  const nodes = [];
  const visit = (n) => {
    nodes.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit(data.slide);
  const triangle = nodes.find((n) => n.type === "svg" && n.source?.endsWith("::after"));
  assert(triangle, "border triangle is native SVG");
  assert.equal(triangle.w, 12);
  assert.equal(triangle.h, 6);
  assert.match(triangle.svg, /<path/);
  const triGeometry = Object.entries(geometry).find(
    ([key, v]) => key.endsWith("::after") && v.bounds[2] === 12,
  )[1];
  const host = nodes.find((n) => n.name?.includes(".triangle"));
  assert(Math.abs(triangle.x + host.x - triGeometry.bounds[0]) < 0.01, "triangle translated once");
  const icon = nodes.find((n) => n.type === "svg" && n.source?.endsWith("::before"));
  assert(icon, "background SVG stays native");
  assert.equal(icon.w, 24);
  assert.match(icon.svg, /<path/);
  assert(
    !data.warnings.some((w) => w.includes("root/2::before")),
    "zero paint whitespace does not warn",
  );
  assert(
    data.warnings.some((w) => w.includes("non-decorative pseudo")),
    "unsupported generated text remains explicit",
  );
  await clearPseudoHosts(page, markers.attribute);
  assert.equal(await page.locator(`[${markers.attribute}]`).count(), 0);
  await page.setContent(
    `<style>.a:after{content:'';display:block;width:20px;height:20px;background:url('/dead.svg') no-repeat}.a{position:absolute;top:1000px}.hidden{opacity:0}.hidden:after{content:'';background:url('/hidden.svg')}</style><div class="a"></div><div class="hidden"></div>`,
  );
  const clipped = await markPseudoHosts(page);
  assert.equal(clipped.hosts.length, 1, "hidden hosts do not queue resources");
  assert.deepEqual(clipped.hosts[0].backgroundUrls[0].clip, [0, 0, 800, 600]);
  await clearPseudoHosts(page, clipped.attribute);
  console.log(
    "PASS native pseudo geometry: flow SVG, border triangle, transform position, whitespace omission, unsupported warning, marker cleanup",
  );
} finally {
  await browser.close();
}
