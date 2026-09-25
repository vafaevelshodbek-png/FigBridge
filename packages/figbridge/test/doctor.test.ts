/**
 * `figbridge doctor` against real servers: each failure it can report, and its fix.
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { type Check, formatChecks, runDoctor } from "../src/doctor.js";
import { BlobStore } from "../src/hub/blob-store.js";
import { Hub } from "../src/hub/hub.js";
import { HubServer } from "../src/hub/server.js";
import { FakePlugin } from "./fake-plugin.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function hub(): Promise<number> {
  const server = new HubServer({
    hub: new Hub(),
    blobs: new BlobStore(),
    token: TOKEN,
    port: 0,
    logger: pino({ level: "silent" }),
    version: "0.0.0",
  });
  const port = await server.listen();
  closers.push(() => server.close());
  return port;
}

async function foreign(): Promise<number> {
  const server: Server = createServer((_req, res) => {
    res.end('{"hello":"world"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function doctor(port: number, overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return runDoctor({
    port,
    stateDir: "/state",
    token: () => TOKEN,
    manifest: fileURLToPath(import.meta.url),
    ...overrides,
  });
}

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe("figbridge doctor", () => {
  it("all green with a hub and a connected file", async () => {
    const port = await hub();
    const plugin = new FakePlugin({ port, token: TOKEN, file: "Deck" });
    await plugin.connect();
    closers.push(() => plugin.close());
    const checks = await doctor(port);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byName(checks, "Figma files connected")?.detail).toContain("Deck");
  });

  it("no hub: says how to start it and stops there", async () => {
    // A port that was just free: take one, then release it.
    const port = await foreign();
    await closers.pop()?.();
    const checks = await doctor(port);
    expect(checks.at(-1)).toMatchObject({
      name: "Hub",
      ok: false,
      fix: expect.stringContaining("figbridge start") as string,
    });
  });

  it("a different program on the port", async () => {
    const checks = await doctor(await foreign());
    expect(byName(checks, "Hub")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("another program") as string,
    });
  });

  it("a hub with another token", async () => {
    const checks = await doctor(await hub(), { token: () => "f".repeat(32) });
    expect(byName(checks, "Token matches the hub")).toMatchObject({ ok: false });
  });

  it("no file connected: points at the plugin", async () => {
    const checks = await doctor(await hub());
    expect(byName(checks, "Figma files connected")).toMatchObject({
      ok: false,
      fix: expect.stringContaining("Plugins") as string,
    });
  });

  it("old Node, unreadable token, missing plugin", async () => {
    const checks = await doctor(await hub(), {
      nodeVersion: "20.11.0",
      token: () => {
        throw new Error("EACCES: permission denied");
      },
      manifest: "/nowhere/manifest.json",
    });
    expect(byName(checks, "Node.js")?.ok).toBe(false);
    expect(byName(checks, "Pairing token")).toMatchObject({
      ok: false,
      detail: "EACCES: permission denied",
    });
    expect(byName(checks, "Figma plugin")?.ok).toBe(false);
    expect(byName(checks, "Token matches the hub")).toBeUndefined();
  });

  it("formats one line per check and the fix under failures", () => {
    const text = formatChecks([
      { name: "A", ok: true, detail: "fine" },
      { name: "B", ok: false, detail: "broken", fix: "do this" },
    ]);
    expect(text).toBe("✓ A: fine\n✗ B: broken\n    → do this");
  });
});
