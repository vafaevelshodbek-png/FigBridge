import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { captureWebsite } from "../src/web-import.js";
import { explorePage } from "../web/explore.mjs";
import { importCaptureData } from "../web/import-capture.mjs";

const slide = {
  name: "Test",
  width: 100,
  height: 100,
  children: [{ type: "image", id: "i", x: 0, y: 0, w: 100, h: 100, url: "" }],
};
const client = {
  sessions: () => Promise.resolve([{ id: "s", file: "Test" }]),
  invoke: () => Promise.resolve({ file: "Test" }),
  putBlob: () => Promise.reject(Error("unexpected upload")),
};
it("continues equivalent recipe prefixes through their different terminal clicks", async () => {
  const server = createServer((_q, r) =>
    r.end(
      `<button id="a" type="button" onclick="document.body.append('alpha')">A</button><button id="b" type="button" onclick="document.body.append('beta')">B</button>`,
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const texts: string[] = [];
    const result = await explorePage(page, {
      url: `http://127.0.0.1:${address.port}`,
      maxDepth: 3,
      recipes: [
        {
          name: "Alpha",
          steps: [
            { action: "wait", ms: 10 },
            { action: "click", selector: "#a" },
          ],
        },
        {
          name: "Beta",
          steps: [
            { action: "wait", ms: 20 },
            { action: "click", selector: "#b" },
          ],
        },
      ],
      capture: async (p) => ({
        warnings: [],
        slide: {
          name: "Fixture",
          width: 100,
          height: 100,
          children: [await p.locator("body").innerText()],
        },
      }),
      onState: (data) => {
        texts.push(String(data.slide.children[0]));
        return Promise.resolve();
      },
    });
    expect(texts.some((t) => t.includes("alpha"))).toBe(true);
    expect(texts.some((t) => t.includes("beta"))).toBe(true);
    expect(result.coverage.actions).toBe(4);
  } finally {
    await browser.close();
    server.close();
  }
}, 30000);
it("refuses an unmaterialized browser asset without making a network request", async () => {
  let requests = 0;
  const server = createServer((_q, r) => {
    requests++;
    r.end("not an image");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  try {
    const data = structuredClone(slide);
    if (!data.children[0]) throw Error("Missing image");
    data.children[0].url = `http://127.0.0.1:${address.port}/image`;
    await expect(
      importCaptureData(
        { slide: data, browser: {}, assetCache: {}, warnings: ["asset byte budget exceeded"] },
        { file: "Test", client },
      ),
    ).rejects.toThrow(/materialized/);
    expect(requests).toBe(0);
  } finally {
    server.close();
  }
});
it("bounds chunked legacy asset downloads", async () => {
  const server = createServer((_q, r) => {
    r.setHeader("content-type", "image/png");
    r.write(Buffer.alloc(8 * 1024 * 1024));
    r.end(Buffer.alloc(1024));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  try {
    const data = structuredClone(slide);
    if (!data.children[0]) throw Error("Missing image");
    data.children[0].url = `http://127.0.0.1:${address.port}/image`;
    await expect(importCaptureData({ slide: data }, { file: "Test", client })).rejects.toThrow(
      /byte budget/,
    );
  } finally {
    server.close();
  }
});
it("preserves nonempty destinations even without a manifest", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "web-collision-"));
  const sentinel = join(outDir, "001.capture.json");
  await writeFile(sentinel, "keep me");
  await expect(captureWebsite({ url: "http://127.0.0.1:9/", outDir })).rejects.toThrow(
    /empty|use|contains/,
  );
  expect(await readFile(sentinel, "utf8")).toBe("keep me");
});
it("atomically admits only one concurrent job into an empty directory", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "web-concurrent-"));
  const server = createServer((_q, r) => r.end("<h1>Concurrent fixture</h1>"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  try {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        captureWebsite({ url: `http://127.0.0.1:${address.port}`, outDir, captureCdp: false }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/empty|use|contains/);
  } finally {
    server.close();
  }
}, 30000);
it("imports already materialized inline browser PNG without an asset-cache entry", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const data = {
    name: "Test",
    width: 100,
    height: 100,
    children: [
      {
        type: "image",
        id: "inline",
        name: "Inline PNG",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        image: { type: "image", url: `data:image/png;base64,${png.toString("base64")}` },
      },
    ],
  };
  const uploads: { bytes: Uint8Array; mime: string }[] = [];
  const renders: unknown[] = [];
  const inlineClient = {
    sessions: client.sessions,
    invoke: (method: string, params: unknown) => {
      if (method === "scene.render") renders.push(params);
      return Promise.resolve(
        method === "session.info"
          ? { file: "Test" }
          : { frameId: "frame", created: 1, warnings: [] },
      );
    },
    putBlob: (bytes: Uint8Array, mime: string) => {
      uploads.push({ bytes, mime });
      return Promise.resolve("image:inline_png");
    },
  };
  await importCaptureData(
    { slide: data, browser: {}, assetCache: {} },
    { file: "Test", client: inlineClient },
  );
  expect(uploads).toHaveLength(1);
  expect(Buffer.from(uploads[0]?.bytes ?? [])).toEqual(png);
  expect(uploads[0]?.mime).toBe("image/png");
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({
    slide: { children: [{ image: { blob: "image:inline_png" } }] },
  });
});
