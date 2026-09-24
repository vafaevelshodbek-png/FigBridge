import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHubClient } from "../src/client.js";
import { BlobStore } from "../src/hub/blob-store.js";
import { Hub } from "../src/hub/hub.js";
import { HubServer } from "../src/hub/server.js";
import { importDeck } from "../src/import-deck.js";
import { FakePlugin } from "./fake-plugin.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const DECK = fileURLToPath(new URL("../../../corpus/beamer_metropolis_demo.pdf", import.meta.url));

let server: HubServer;
let plugin: FakePlugin;
let client: LocalHubClient;
const rendered: { slide: { name: string }; x: number; y: number }[] = [];

beforeEach(async () => {
  const hub = new Hub();
  const blobs = new BlobStore();
  server = new HubServer({
    hub,
    blobs,
    token: TOKEN,
    port: 0,
    logger: pino({ level: "silent" }),
    version: "t",
  });
  const port = await server.listen();
  client = new LocalHubClient(hub, blobs);
  rendered.length = 0;
  let frame = 100;
  plugin = new FakePlugin({
    port,
    token: TOKEN,
    handlers: {
      "scene.render": (params) => {
        rendered.push(params as (typeof rendered)[number]);
        return { frameId: `1:${String(++frame)}`, created: 10, warnings: [] };
      },
    },
  });
  await plugin.connect();
});

afterEach(async () => {
  await plugin.close();
  await server.close();
});

describe("importDeck", () => {
  it("renders each page as a frame laid out in a grid", async () => {
    const progress: number[] = [];
    const result = await importDeck(client, {
      path: DECK,
      pages: [1, 2, 3],
      x: 100,
      y: 2000,
      columns: 2,
      onProgress: (done) => progress.push(done),
    });
    expect(result.frames.map((f) => f.page)).toEqual(["01", "02", "03"]);
    const [first, second, third] = rendered.map((r) => [r.x, r.y]);
    expect(first).toEqual([100, 2000]);
    expect(second).toEqual([100 + 1920 + 200, 2000]); // next column: width + gap
    expect(third?.[0]).toBe(100); // wraps to the next row
    expect(third?.[1]).toBeGreaterThan(2000);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("rejects unsupported files with a clear error", async () => {
    await expect(importDeck(client, { path: "C:/deck.key" })).rejects.toMatchObject({
      code: "DOCUMENT_INVALID",
    });
  });
});
