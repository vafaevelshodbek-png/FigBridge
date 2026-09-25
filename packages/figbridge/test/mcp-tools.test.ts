/**
 * Every MCP tool through a real MCP client and server (in-memory transport), a real hub and
 * a scripted plugin — once with the in-process client, once over the hub's HTTP API as a
 * second figbridge process would. Checks what the agent sees: tool list and annotations,
 * results, inline images, files written, and errors that say what to do next.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCanvas } from "@napi-rs/canvas";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type HubClient, LocalHubClient, RemoteHubClient } from "../src/client.js";
import { BlobStore } from "../src/hub/blob-store.js";
import { Hub } from "../src/hub/hub.js";
import { HubServer } from "../src/hub/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { FakePlugin } from "./fake-plugin.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const CORPUS = fileURLToPath(new URL("../../../corpus/", import.meta.url));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A real w×h PNG, blue, with an optional red square in the top-left corner. */
function png(w: number, h: number, redCorner = 0): Uint8Array {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0000FF";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#FF0000";
  ctx.fillRect(0, 0, redCorner, redCorner);
  return new Uint8Array(canvas.toBuffer("image/png"));
}
/** What the fake plugin exports for layer 2:1 (a 40×20 frame). */
const FRAME = png(40, 20);

let hub: Hub;
let blobs: BlobStore;
let server: HubServer;
let port: number;
let plugin: FakePlugin | undefined;
let mcp: Client;
let dir: string;
const calls: { method: string; params: unknown }[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "figbridge-mcp-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAGE = { id: "0:1", name: "Page 1", current: true };
const handlers = {
  "session.info": () => ({ file: "Deck", editorType: "figma", page: PAGE, selectionCount: 1 }),
  "page.list": () => ({ pages: [PAGE] }),
  "page.set": () => PAGE,
  "selection.get": () => ({ nodes: [{ id: "1:2", name: "Card", type: "FRAME" }] }),
  "document.outline": () => ({ nodes: [{ id: "1:2", name: "Card", type: "FRAME", depth: 0 }] }),
  "node.get": (params: unknown) =>
    (params as { nodeId: string }).nodeId === "2:1"
      ? { node: { id: "2:1", name: "Frame", type: "FRAME", box: { x: 0, y: 0, w: 40, h: 20 } } }
      : { node: { id: "1:2", name: "Card", type: "FRAME" } },
  "node.find": () => ({ nodes: [], truncated: false }),
  "node.export": (params: unknown) => {
    const { format, nodeId } = params as { format: string; nodeId: string };
    if (nodeId === "2:1")
      return { blob: blobs.put(FRAME, "image/png"), mimeType: "image/png", width: 40, height: 20 };
    const bytes = format === "svg" ? new TextEncoder().encode("<svg/>") : PNG;
    const mimeType = format === "svg" ? "image/svg+xml" : "image/png";
    return { blob: blobs.put(bytes, mimeType), mimeType, width: 10, height: 5 };
  },
  "scene.render": () => ({ frameId: "9:1", created: 3, warnings: [] }),
  "nodes.create": () => ({ ids: ["9:2"], warnings: [] }),
  "node.update": () => ({ id: "1:2", name: "Renamed", type: "FRAME" }),
  "node.clone": () => ({ id: "1:3", name: "Card", type: "FRAME" }),
  "node.delete": () => ({ deleted: ["1:2"], missing: [] }),
};

async function connectPlugin() {
  plugin = new FakePlugin({
    port,
    token: TOKEN,
    handlers: Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        (params: unknown) => {
          calls.push({ method, params });
          return handler(params);
        },
      ]),
    ),
  });
  await plugin.connect();
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = (await mcp.callTool({ name, arguments: args })) as {
    content: Content[];
    isError?: boolean;
  };
  return result;
}

function json(result: { content: Content[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
}

describe.each([
  ["in-process", () => new LocalHubClient(hub, blobs)],
  ["over HTTP", () => new RemoteHubClient(`http://127.0.0.1:${String(port)}`, TOKEN)],
] as [string, () => HubClient][])("MCP tools (%s client)", (_, makeClient) => {
  beforeEach(async () => {
    calls.length = 0;
    hub = new Hub();
    blobs = new BlobStore();
    server = new HubServer({
      hub,
      blobs,
      token: TOKEN,
      port: 0,
      logger: pino({ level: "silent" }),
      version: "test",
      heartbeatMs: 60_000,
    });
    port = await server.listen();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(makeClient()).connect(serverSide);
    mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientSide);
  });

  afterEach(async () => {
    await mcp.close();
    await plugin?.close();
    plugin = undefined;
    await server.close();
  });

  it("lists 14 figma_ tools with honest annotations", async () => {
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(14);
    for (const t of tools) expect(t.name).toMatch(/^figma_/);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName["figma_outline"]).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName["figma_delete"]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("tells the agent to open the plugin when no file is connected", async () => {
    const result = await tool("figma_file_info");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^NO_SESSION: /);
  });

  it("reads through every read tool", async () => {
    await connectPlugin();
    expect(json(await tool("figma_sessions"))["sessions"]).toHaveLength(1);
    expect(json(await tool("figma_file_info"))).toMatchObject({ file: "Deck", selectionCount: 1 });
    expect(json(await tool("figma_pages"))).toMatchObject({ pages: [PAGE] });
    expect(json(await tool("figma_pages", { pageId: "0:1" }))).toMatchObject(PAGE);
    expect(json(await tool("figma_selection"))["nodes"]).toHaveLength(1);
    expect(json(await tool("figma_outline", { depth: 2 }))["nodes"]).toHaveLength(1);
    expect(json(await tool("figma_get_node", { nodeId: "1:2" }))).toMatchObject({
      node: { name: "Card" },
    });
    expect(json(await tool("figma_find", { name: "card" }))).toMatchObject({ truncated: false });
    // Tool arguments reach the plugin with protocol defaults applied, minus MCP-only fields.
    expect(calls.find((c) => c.method === "document.outline")?.params).toMatchObject({
      depth: 2,
      limit: expect.any(Number) as number,
    });
    expect(calls.find((c) => c.method === "node.find")?.params).not.toHaveProperty("session");
  });

  it("returns exports inline, as SVG text, or saved to a file", async () => {
    await connectPlugin();
    const inline = await tool("figma_export", { nodeId: "1:2" });
    expect(inline.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(inline.content[1]?.data ?? "", "base64")).toEqual(Buffer.from(PNG));
    const svg = await tool("figma_export", { nodeId: "1:2", format: "svg" });
    expect(svg.content[1]).toEqual({ type: "text", text: "<svg/>" });
    const path = join(dir, "card.png");
    expect(json(await tool("figma_export", { nodeId: "1:2", saveTo: path }))).toMatchObject({
      savedTo: path,
      bytes: PNG.length,
    });
    expect(readFileSync(path)).toEqual(Buffer.from(PNG));
    const relative = await tool("figma_export", { nodeId: "1:2", saveTo: "card.png" });
    expect(relative.isError).toBe(true);
    expect(relative.content[0]?.text).toContain("absolute");
  });

  it("compares a layer with an image and shows where they differ", async () => {
    await connectPlugin();
    const same = join(dir, "same.png");
    const changed = join(dir, "changed.png");
    const bigger = join(dir, "bigger.png");
    writeFileSync(same, png(40, 20));
    writeFileSync(changed, png(40, 20, 10));
    writeFileSync(bigger, png(80, 40));
    expect(json(await tool("figma_compare", { nodeId: "2:1", imagePath: same }))).toMatchObject({
      verdict: "identical",
      differingPixels: 0,
    });
    const diff = await tool("figma_compare", { nodeId: "2:1", imagePath: changed });
    expect(json(diff)).toMatchObject({
      verdict: "different",
      differingPixels: 100,
      differingPercent: 12.5,
    });
    expect(diff.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    // A 2× screenshot: the layer is exported at 2×, compared at the image's size.
    expect(json(await tool("figma_compare", { nodeId: "2:1", imagePath: bigger }))).toMatchObject({
      width: 80,
      height: 40,
    });
    const saved = join(dir, "diff.png");
    expect(
      json(await tool("figma_compare", { nodeId: "2:1", imagePath: changed, saveDiffTo: saved })),
    ).toMatchObject({ diffSavedTo: saved });
    expect(readFileSync(saved).subarray(1, 4).toString()).toBe("PNG");
    const notImage = join(dir, "notes.txt");
    writeFileSync(notImage, "hello");
    expect(
      (await tool("figma_compare", { nodeId: "2:1", imagePath: notImage })).content[0]?.text,
    ).toMatch(/^IMAGE_INVALID/);
  });

  it("imports a deck: converts locally, renders every slide in the plugin", async () => {
    await connectPlugin();
    const result = json(
      await tool("figma_import_deck", { path: join(CORPUS, "poi_shapes.pptx"), pages: [1, 2] }),
    );
    expect(result["frames"]).toHaveLength(2);
    const renders = calls.filter((c) => c.method === "scene.render");
    expect(renders).toHaveLength(2);
    expect(renders[1]?.params).toMatchObject({ x: expect.any(Number) as number, y: 0 });
    const missing = await tool("figma_import_deck", { path: join(dir, "nope.pptx") });
    expect(missing.isError).toBe(true);
    expect((await tool("figma_import_deck", { path: "deck.pptx" })).content[0]?.text).toContain(
      "absolute",
    );
  });

  it("writes through create, update, clone and delete", async () => {
    await connectPlugin();
    const rect = {
      id: "r",
      name: "R",
      type: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      fills: [],
      strokes: [],
      radii: [0, 0, 0, 0],
    };
    expect(json(await tool("figma_create", { nodes: [rect] }))).toMatchObject({ ids: ["9:2"] });
    expect(
      json(await tool("figma_update", { nodeId: "1:2", props: { name: "Renamed" } })),
    ).toMatchObject({ name: "Renamed" });
    expect(json(await tool("figma_clone", { nodeId: "1:2" }))).toMatchObject({ id: "1:3" });
    expect(json(await tool("figma_delete", { nodeIds: ["1:2"] }))).toMatchObject({
      deleted: ["1:2"],
    });
    const invalid = await tool("figma_create", { nodes: [] });
    expect(invalid.isError).toBe(true);
  });
});
