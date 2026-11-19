import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { explorePage } from "../../web/explore.mjs";

let submissions = 0;
const server = createServer((req, res) => {
  if (req.url === "/scroll")
    return res.end(
      `<!doctype html><style>#nested{height:100px;width:200px;overflow:auto}#horizontal{height:60px;width:200px;overflow:auto}</style><div id="nested" role="list" aria-label="Items" onscroll="this.firstElementChild.textContent=this.scrollTop>0?'Virtual row 2':'Items'"><div style="height:1000px">Items</div></div><div id="horizontal"><div style="width:1500px">Wide items</div></div>`,
    );
  if (req.url === "/submitted") {
    submissions++;
    return res.end("received");
  }
  if (req.url === "/unsafe")
    return res.end(
      `<!doctype html><form onsubmit="event.preventDefault();fetch('/submitted',{method:'POST'})"><button id="continue">Continue</button></form><button id="destroy" onclick="fetch('/submitted',{method:'POST'})">Delete account</button>`,
    );
  if (req.url === "/query") return res.end("Read only loaded");
  res.end(
    `<style>#hint{display:none}#hover:hover #hint{display:block}</style><body><details><summary>Menu</summary>Opened menu</details><button role="tab" onclick="document.querySelector('#panel').textContent='Second'">Second tab</button><div id="panel">First</div><div id="hover" tabindex="0">Hover<span id="hint">Hint</span></div><a href="/next">Next</a><a href="https://example.org/">External</a><form><button>Submit</button></form><button onclick="document.body.textContent='BAD'">Delete account</button></body>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();
const capture = async (page) => ({
  slide: {
    name: crypto.randomUUID(),
    children: [{ text: await page.locator("body").innerText() }],
  },
});
try {
  const scrollCapture = async (p) => {
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    return {
      slide: await p.evaluate(() => ({
        windowY: scrollY,
        nested: document.querySelector("#nested").scrollTop,
        horizontal: document.querySelector("#horizontal").scrollLeft,
        text: document.querySelector("#nested").innerText,
      })),
    };
  };
  const scrollUrl = new URL("/scroll", url).href;
  const scrollGraph = await explorePage(page, {
    url: scrollUrl,
    capture: scrollCapture,
    maxDepth: 1,
    maxScrollSteps: 1,
    onState: async (data) => data.slide,
  });
  assert(
    scrollGraph.states.some((s) => s.result.nested > 0 && s.result.windowY === 0),
    "discover nested scrolling without moving window",
  );
  assert(scrollGraph.states.some((s) => s.result.text === "Virtual row 2"));
  assert(
    scrollGraph.states.some((s) => s.result.horizontal > 0),
    "discover horizontal scrolling",
  );
  for (const action of [
    { action: "scroll", role: "list", name: "Items", y: 60 },
    { action: "scroll", selector: "#horizontal", x: 80, y: 0 },
  ]) {
    const graph = await explorePage(page, {
      url: scrollUrl,
      capture: scrollCapture,
      maxDepth: 1,
      maxScrollSteps: 1,
      recipes: [{ steps: [action] }],
      onState: async (data) => data.slide,
    });
    assert.equal(graph.states.length, 2);
    assert.equal(graph.states[1].result.windowY, 0);
  }
  const noScroll = await explorePage(page, {
    url: scrollUrl,
    capture: scrollCapture,
    maxScrollSteps: 0,
  });
  assert.equal(noScroll.states.length, 1);
  assert(!noScroll.edges.some((e) => e.action.action === "scroll"));
  const boundedScroll = await explorePage(page, {
    url: scrollUrl,
    capture: scrollCapture,
    maxDepth: 2,
    maxScrollSteps: 1,
    recipes: [
      {
        steps: [
          { action: "scroll", selector: "#nested", y: 60 },
          { action: "scroll", selector: "#horizontal", x: 80, y: 0 },
        ],
      },
    ],
  });
  assert.equal(boundedScroll.states.length, 2);
  assert(
    boundedScroll.edges.some((e) => e.status === "blocked" && e.reason === "Scroll step limit"),
  );
  for (const action of [
    { action: "click", role: "button", name: "Continue" },
    { action: "press", role: "button", name: "Continue", key: "Space" },
    { action: "press", selector: "#destroy", key: "Space" },
  ]) {
    const unsafeGraph = await explorePage(page, {
      url: new URL("/unsafe", url).href,
      capture,
      maxDepth: 1,
      recipes: [{ steps: [action] }],
    });
    assert.equal(
      submissions,
      0,
      "blocked activation must never execute submission or click handler",
    );
    assert.equal(unsafeGraph.edges[0].status, "blocked");
  }
  await page.goto(url);
  const query = await page.evaluate(async () => (await fetch("/query", { method: "POST" })).text());
  assert.equal(query, "Read only loaded");
  await explorePage(page, {
    url,
    maxDepth: 0,
    capture: async (p) => {
      assert.equal(
        await p.evaluate(async () => (await fetch("/query", { method: "POST" })).text()),
        "Read only loaded",
      );
      return capture(p);
    },
  });
  const result = await explorePage(page, {
    url,
    maxStates: 15,
    maxActions: 35,
    maxDepth: 2,
    maxScrollSteps: 1,
    capture,
    onState: async (data) => ({ text: data.slide.children[0].text }),
  });
  assert(result.states.some((s) => s.result.text.includes("Opened menu")));
  assert(result.states.some((s) => s.result.text.includes("Hint")));
  const tab = result.states.find((s) => s.recipe.length === 1 && s.recipe[0].name === "Second tab");
  assert(tab.result.text.includes("Second"));
  assert(!tab.result.text.includes("Opened menu"), "branch replay must close prior menu");
  assert(result.edges.some((e) => e.status === "blocked" && /External/.test(e.action.name)));
  assert(result.edges.some((e) => e.status === "blocked" && /Submit|Delete/.test(e.action.name)));
  assert(result.edges.some((e) => e.status === "duplicate"));
  assert(result.states.every((s) => s.recipe.length <= 2));
  assert(result.coverage.actions <= 35);
  const limited = await explorePage(page, {
    url,
    maxStates: 1,
    maxActions: 1,
    maxDepth: 2,
    capture,
  });
  assert.equal(limited.states.length, 1);
  assert(limited.edges.some((e) => e.status === "pending"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(explorePage(page, { url, capture, signal: controller.signal }), /abort/i);
  await assert.rejects(
    explorePage(page, {
      url,
      capture: async () => {
        throw Error("capture lost");
      },
    }),
    /capture lost/,
  );
  const recipe = await explorePage(page, {
    url,
    capture,
    maxDepth: 1,
    maxActions: 1,
    recipes: [{ name: "tab", steps: [{ action: "click", selector: "[role=tab]" }] }],
  });
  assert.equal(recipe.states.length, 2);
  await assert.rejects(explorePage(page, { url, capture, maxActions: 0 }), /maxActions/);
  console.log(
    "PASS browser explorer: state graph, scope, unsafe controls, dedup, budgets, replay, cancellation, capture failure, explicit recipe",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
