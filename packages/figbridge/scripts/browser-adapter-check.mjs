import assert from "node:assert/strict";
import { chromium } from "playwright";
import { captureDOM, prepareDOM } from "../web/capture-dom.mjs";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
});
try {
  const page = await browser.newPage();
  await page.setContent(
    '<div id="host">Slotted<b slot="unused">Hidden</b></div><div style="clip-path:circle(40%)">Clipped</div>',
  );
  await page.evaluate(
    () =>
      (document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML =
        '<p>Shadow</p><slot style="color:rgb(0, 128, 0)"></slot>'),
  );
  const data = await page.evaluate(captureDOM);
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    n.children?.forEach(walk);
  };
  data.slide.children.forEach(walk);
  assert(
    nodes.some((n) => n.characters === "Shadow"),
    "open shadow text must be captured",
  );
  assert.equal(nodes.filter((n) => n.characters === "Slotted").length, 1);
  assert.equal(
    nodes.find((n) => n.characters === "Slotted").runs[0].fill.color,
    "#008000",
    "slot inherited text color",
  );
  assert(!nodes.some((n) => n.characters === "Hidden"));
  assert(data.warnings.some((w) => w.includes("clip-path")));
  console.log("PASS composed DOM and clip-path losses");
} finally {
  await browser.close();
}

// Adapter tests deliberately use real browser state, cookies and blob URLs.
const { capturePage } = await import("../web/browser-capture.mjs").catch(() => ({
  capturePage: null,
}));
assert.equal(typeof capturePage, "function", "browser adapter must exist");
const b2 = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
});
try {
  const p = await b2.newPage();
  await p.setContent('<div id="closed-host"></div>');
  await p.evaluate(
    () =>
      (document.querySelector("#closed-host").attachShadow({ mode: "closed" }).innerHTML =
        "<p>Closed native content</p>"),
  );
  const closedCapture = await capturePage(p);
  assert(!JSON.stringify(closedCapture.slide).includes("Closed native content"));
  assert(
    closedCapture.sourceWarnings.some((w) => w.includes("closed shadow")),
    "closed shadow source loss must be explicit",
  );

  for (const key of [
    "maxAssets",
    "maxAssetBytes",
    "maxTotalAssetBytes",
    "timeoutMs",
    "maxScrollSteps",
  ]) {
    for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])
      await assert.rejects(
        capturePage(p, { [key]: value }),
        new RegExp(key),
        `${key} must reject ${value}`,
      );
  }
  await p.setContent("<style>body{height:12000px}</style>");
  for (const maxScrollSteps of [-1, NaN, Infinity])
    await assert.rejects(p.evaluate(prepareDOM, { maxScrollSteps }), /maxScrollSteps/);
  await p.evaluate(() => {
    window.__scrollVisits = 0;
    addEventListener("scroll", () => window.__scrollVisits++);
  });
  await capturePage(p, { fullPage: true, maxScrollSteps: 0, captureCdp: false });
  assert.equal(
    await p.evaluate(() => window.__scrollVisits),
    0,
    "zero scroll budget must not visit lazy regions",
  );

  await p.route("**/*", async (route) => {
    if (route.request().url().startsWith("http://other.test/"))
      return route.fulfill({ contentType: "text/html", body: "<p>Cross origin text</p>" });
    if (route.request().url().endsWith("/asset")) {
      assert(route.request().headers().cookie?.includes("auth=yes"));
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<style>body{margin:0}iframe{position:absolute;left:40px;top:50px;width:120px;height:70px;border:4px solid black}</style><iframe srcdoc="<style>body{margin:0}</style><div>Frame text</div>"></iframe><img src="/asset">',
    });
  });
  await p.context().addCookies([{ name: "auth", value: "yes", url: "http://fixture.test" }]);
  await p.goto("http://fixture.test");
  await p.evaluate(async () => {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'], {
        type: "image/svg+xml",
      }),
    );
    document.body.append(img);
    await img.decode();
  });
  await p.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.src = "http://other.test/frame";
        frame.onload = resolve;
        document.body.append(frame);
      }),
  );
  await p.evaluate(() => {
    const input = document.createElement("input");
    input.type = "password";
    input.value = "PRIVATE_PASSWORD_7921";
    document.body.append(input);
  });
  const d = await capturePage(p);
  assert(!JSON.stringify(d).includes("PRIVATE_PASSWORD_7921"), "password never serialized");
  const nodes = [];
  const walk = (n, x = 0, y = 0) => {
    nodes.push({ ...n, absoluteX: x + n.x, absoluteY: y + n.y });
    n.children?.forEach((c) => {
      walk(c, x + n.x, y + n.y);
    });
  };
  d.slide.children.forEach((n) => {
    walk(n);
  });
  assert(
    nodes.some((n) => n.characters === "Frame text"),
    "iframe text",
  );
  assert(
    nodes
      .filter((n) => n.type === "text")
      .map((n) => n.characters)
      .join(" ")
      .includes("Cross origin text"),
    "accessible cross-origin frame",
  );
  const viewport = nodes.find((n) => n.name === "iframe viewport");
  assert.deepEqual(
    [viewport.absoluteX, viewport.absoluteY, viewport.w, viewport.h, viewport.clip],
    [44, 54, 120, 70, true],
  );
  assert(Object.keys(d.assetCache).some((k) => k.startsWith("blob:")));
  assert(d.assetCache["http://fixture.test/asset"].startsWith("data:image/svg+xml;base64,"));
  assert(d.cdpSnapshot?.documents?.length >= 2);
  const ids = nodes.map((n) => n.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "frame native source IDs must be unique");
  const limited = await capturePage(p, { maxAssetBytes: 2 });
  assert(limited.warnings.some((w) => w.includes("asset") && w.includes("budget")));
  const during = new AbortController();
  const pending = capturePage(p, { signal: during.signal });
  setTimeout(() => during.abort(), 5);
  await assert.rejects(pending, /abort/i);
  await assert.rejects(capturePage(p, { timeoutMs: 1 }), /timeout/i);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(capturePage(p, { signal: ac.signal }), /abort/i);
  console.log(
    "PASS iframe clipping/coordinates, authenticated/blob assets, budgets, CDP and abort",
  );
} finally {
  await b2.close();
}

// Two real HTTP origins, with no CORS opt-in on the public image server.
const { createServer } = await import("node:http");
const nodeHeaders = [];
const assetServer = createServer((request, response) => {
  if (request.headers["user-agent"] === "node") nodeHeaders.push(request.headers);
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: "/redirect2" });
    response.end();
    return;
  }
  const redirect =
    request.url === "/redirect2"
      ? "/public"
      : request.url === "/redirect-large"
        ? "/large"
        : request.url === "/loop"
          ? "/loop"
          : request.url === "/bad-redirect"
            ? "file:///forbidden"
            : request.url.startsWith("/hops/")
              ? `/hops/${Number(request.url.split("/").at(-1)) + 1}`
              : null;
  if (redirect) {
    response.writeHead(302, { Location: redirect });
    response.end();
    return;
  }
  if (request.url === "/declared") response.setHeader("Content-Length", "9000");
  response.setHeader("Content-Type", "image/svg+xml");
  response.write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/>',
  );
  if (request.url === "/large" || request.url === "/declared") response.write(" ".repeat(8192));
  response.end("</svg>");
});
await new Promise((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
const assetBase = `http://127.0.0.1:${assetServer.address().port}`;
const documentServer = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<img src="${assetBase}/public"><div style="width:8px;height:8px;background-image:url(${assetBase}/large),url(${assetBase}/declared),url(${assetBase}/redirect),url(${assetBase}/redirect2),url(${assetBase}/redirect-large),url(${assetBase}/loop),url(${assetBase}/hops/0),url(${assetBase}/bad-redirect)"></div>`,
  );
});
await new Promise((resolve) => documentServer.listen(0, "127.0.0.1", resolve));
const b3 = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
});
try {
  const page = await b3.newPage();
  await page.context().addCookies([{ name: "private", value: "do-not-copy", url: assetBase }]);
  await page.goto(`http://127.0.0.1:${documentServer.address().port}`);
  assert.equal(
    await page.locator("img").evaluate((el) => el.naturalWidth),
    8,
    "real cross-origin image renders",
  );
  const capture = await capturePage(page, { maxAssetBytes: 1024 });
  assert(
    capture.assetCache[`${assetBase}/public`]?.startsWith("data:image/svg+xml;base64,"),
    "public CORS image materializes",
  );
  assert(
    !capture.warnings.some((w) => w.includes(`${assetBase}/public`)),
    "successful fallback has no loss",
  );
  assert(
    capture.warnings.some((w) => w.includes("/large") && w.includes("budget")),
    "streamed bytes remain bounded",
  );
  assert(
    capture.warnings.some((w) => w.includes("/declared") && w.includes("budget")),
    "declared bytes bounded",
  );
  assert(
    capture.assetCache[`${assetBase}/redirect`]?.startsWith("data:image/svg+xml;base64,"),
    "two-hop public redirect materializes",
  );
  assert(capture.warnings.some((w) => w.includes("/loop") && w.includes("redirect loop")));
  assert(capture.warnings.some((w) => w.includes("/hops/0") && w.includes("redirect limit")));
  assert(capture.warnings.some((w) => w.includes("/redirect-large") && w.includes("budget")));
  assert(capture.warnings.some((w) => w.includes("/bad-redirect") && w.includes("HTTP(S)")));
  assert(capture.assetCache[`${assetBase}/redirect2`], "one-hop public redirect materializes");
  const totalLimited = await capturePage(page, { maxTotalAssetBytes: 128, maxAssetBytes: 1024 });
  assert.equal(
    Object.keys(totalLimited.assetCache).length,
    1,
    "total budget shared across redirected assets",
  );
  assert(totalLimited.assetCache[`${assetBase}/public`]);
  assert(nodeHeaders.length >= 4);
  assert(
    nodeHeaders.every((h) => !h.cookie && !h.authorization && !h.referer),
    "fallback sends no browser secrets",
  );
  console.log("PASS anonymous public CDN fallback and streamed byte limit");
} finally {
  await b3.close();
  assetServer.closeAllConnections();
  documentServer.closeAllConnections();
  await Promise.all([
    new Promise((r) => assetServer.close(r)),
    new Promise((r) => documentServer.close(r)),
  ]);
}
