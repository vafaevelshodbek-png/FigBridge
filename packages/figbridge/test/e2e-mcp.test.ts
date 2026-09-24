/**
 * End-to-end: a real MCP client launches the built CLI (`figbridge mcp`) over stdio, a fake
 * plugin connects to the hub it starts, and a tool call travels
 * client → MCP → hub → WebSocket → plugin and back.
 *
 * Requires `pnpm --filter figbridge build` (CI builds before testing).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateToken } from "../src/config.js";
import { FakePlugin } from "./fake-plugin.js";

const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const PORT = 7400 + Math.floor(Math.random() * 400);

const home = mkdtempSync(join(tmpdir(), "figbridge-e2e-"));
let client: Client;
let plugin: FakePlugin;

async function connectWithRetry(fake: FakePlugin, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fake.connect();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe.skipIf(!existsSync(CLI))("MCP end to end", () => {
  beforeAll(async () => {
    const env = {
      ...process.env,
      FIGBRIDGE_HOME: home,
      FIGBRIDGE_PORT: String(PORT),
      FIGBRIDGE_LOG: "silent",
    };
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, "mcp"],
        env: env,
      }),
    );
    const token = loadOrCreateToken(home);
    plugin = new FakePlugin({
      port: PORT,
      token,
      handlers: {
        "session.info": () => ({
          file: "E2E file",
          editorType: "figma",
          page: { id: "0:1", name: "Page 1", current: true },
          selectionCount: 2,
        }),
      },
    });
    // The hub may still be binding its port right after the MCP handshake; retry briefly.
    await connectWithRetry(plugin, 5_000);
  });

  afterAll(async () => {
    await plugin.close();
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("figma_outline");
    expect(names.every((name) => name.startsWith("figma_"))).toBe(true);
    const deleteTool = tools.find((tool) => tool.name === "figma_delete");
    expect(deleteTool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("calls through to the plugin", async () => {
    const result = await client.callTool({ name: "figma_file_info", arguments: {} });
    expect(result.isError).not.toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    expect(JSON.parse(first?.text ?? "{}")).toMatchObject({ file: "E2E file", selectionCount: 2 });
  });

  it("returns actionable errors as tool results", async () => {
    const result = await client.callTool({
      name: "figma_get_node",
      arguments: { nodeId: "not-an-id" },
    });
    expect(result.isError).toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    // The SDK validates arguments against the tool's input schema before our handler runs.
    expect(first?.text).toMatch(/validation/i);
    expect(first?.text).toContain("nodeId");
  });
});
