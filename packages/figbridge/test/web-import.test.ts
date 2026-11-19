import { access, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureWebsite, WebCaptureInputSchema } from "../src/web-import.js";

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><style>body{margin:0;font:16px Arial;background:white}</style><main id="card" style="width:240px;height:160px"><h1>Редактируемый экран</h1><button>Меню</button><input id="secret" type="password"></main>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  url = `http://127.0.0.1:${address.port}/`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
});

it("rejects invalid protocols and unbounded browser/exploration inputs", () => {
  for (const input of [
    { url: "javascript:alert(1)", outDir: "out" },
    { url: "https://example.com", outDir: "out", width: -1 },
    { url: "https://example.com", outDir: "out", maxStates: 0 },
  ])
    expect(WebCaptureInputSchema.safeParse(input).success).toBe(false);
});

it("captures a browser-rendered page into an offline native scene and reference PNG", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "figbridge-web-api-"));
  const result = await captureWebsite({ url, outDir, width: 640, height: 480, captureCdp: false });
  expect(result.states).toHaveLength(1);
  const state = result.states[0];
  if (!state) throw new Error("No state captured");
  const raw = await readFile(state.capturePath, "utf8");
  expect(raw).toContain('"characters": "Редактируемый"');
  expect(raw).toContain('"characters": "экран"');
  expect(raw).toContain('"type": "text"');
  const png = await readFile(state.referencePath);
  expect([...png.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  expect(result.coverage.exhaustive).toBe(false);
  expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
    status: "captured",
  });
}, 30_000);

it("keeps subtree reference dimensions equal to the selected scene rather than the whole page", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "figbridge-web-element-"));
  const result = await captureWebsite({
    url,
    outDir,
    selector: "#card",
    width: 640,
    height: 480,
    captureCdp: false,
  });
  const state = result.states[0];
  if (!state) throw new Error("No selected state");
  const png = await readFile(state.referencePath);
  expect([state.width, state.height]).toEqual([240, 160]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([240, 160]);
}, 30_000);

it("honors pre-cancellation before creating artifacts or opening a browser", async () => {
  const parent = await mkdtemp(join(tmpdir(), "figbridge-web-abort-"));
  const outDir = join(parent, "unused");
  const controller = new AbortController();
  controller.abort(new Error("User cancelled capture"));
  await expect(captureWebsite({ url, outDir }, { signal: controller.signal })).rejects.toThrow(
    "User cancelled",
  );
  await expect(access(outDir)).rejects.toThrow();
});

it("redacts recipe fill values from persisted manifests and returned workflow results", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "figbridge-web-private-recipe-"));
  const result = await captureWebsite({
    url,
    outDir,
    captureCdp: false,
    maxDepth: 1,
    maxStates: 2,
    recipes: [
      {
        name: "Password",
        steps: [{ action: "fill", selector: "#secret", value: "private-password-123" }],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("private-password-123");
  expect(await readFile(result.manifestPath, "utf8")).not.toContain("private-password-123");
}, 30_000);
