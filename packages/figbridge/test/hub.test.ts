import { request } from "node:http";
import { BridgeError } from "@figbridge/protocol";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/hub/blob-store.js";
import { Hub } from "../src/hub/hub.js";
import { HubServer } from "../src/hub/server.js";
import { FakePlugin } from "./fake-plugin.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SESSION_INFO = {
  file: "Test file",
  editorType: "figma",
  page: { id: "0:1", name: "Page 1", current: true },
  selectionCount: 0,
};

let hub: Hub;
let server: HubServer;
let port: number;
const plugins: FakePlugin[] = [];

async function start(options: { readOnly?: boolean } = {}) {
  hub = new Hub(options);
  server = new HubServer({
    hub,
    blobs: new BlobStore(),
    token: TOKEN,
    port: 0,
    logger: pino({ level: "silent" }),
    version: "test",
    heartbeatMs: 60_000,
    helloTimeoutMs: 500,
  });
  port = await server.listen();
}

async function plugin(options: Partial<ConstructorParameters<typeof FakePlugin>[0]> = {}) {
  const fake = new FakePlugin({ port, token: TOKEN, ...options });
  plugins.push(fake);
  await fake.connect();
  return fake;
}

/** GET with a raw Host header (fetch() silently overrides Host, so it cannot test rebinding). */
function getWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((p) => p.close()));
  await server.close();
});

describe("handshake", () => {
  it("accepts a plugin with the right token and assigns a session", async () => {
    const fake = await plugin();
    expect(fake.session).toMatch(/^s_/);
    expect(hub.sessions()).toHaveLength(1);
  });

  it("rejects a wrong token", async () => {
    await expect(new FakePlugin({ port, token: "nope" }).connect()).rejects.toThrow(/4401/);
  });

  it("rejects an unsupported protocol version", async () => {
    await expect(new FakePlugin({ port, token: TOKEN, protocols: [99] }).connect()).rejects.toThrow(
      /4426/,
    );
  });

  it("refuses browser origins before the handshake", async () => {
    await expect(
      new FakePlugin({ port, token: TOKEN }).connect("https://evil.example"),
    ).rejects.toThrow(/403/);
  });

  it("reuses the session when the same instance reconnects", async () => {
    const first = await plugin({ instance: "same-instance-1" });
    const second = await plugin({ instance: "same-instance-1" });
    expect(second.session).toBe(first.session);
    expect(hub.sessions()).toHaveLength(1);
  });
});

describe("calls", () => {
  it("round-trips a request and validates the result", async () => {
    await plugin({ handlers: { "session.info": () => SESSION_INFO } });
    await expect(hub.call("session.info", {})).resolves.toEqual(SESSION_INFO);
  });

  it("rejects a malformed plugin result as INTERNAL", async () => {
    await plugin({ handlers: { "session.info": () => ({ wrong: true }) } });
    await expect(hub.call("session.info", {})).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("propagates plugin errors with their code", async () => {
    await plugin({
      handlers: {
        "node.get": () => {
          throw new Error("gone");
        },
      },
    });
    await expect(hub.call("node.get", { nodeId: "1:2" })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
  });

  it("times out and sends cancel to the plugin", async () => {
    const fake = await plugin(); // no handlers: never answers
    await expect(hub.call("session.info", {}, { timeoutMs: 50 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await expect.poll(() => fake.received.some((m) => m.type === "cancel")).toBe(true);
  });

  it("cancels through an AbortSignal", async () => {
    await plugin();
    const abort = new AbortController();
    const call = hub.call("session.info", {}, { signal: abort.signal, timeoutMs: 5_000 });
    abort.abort();
    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("validates parameters before touching the plugin", async () => {
    const fake = await plugin();
    await expect(hub.call("node.get", { nodeId: "not-an-id" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fake.received).toHaveLength(0);
  });

  it("fails pending calls as retryable when the plugin disconnects", async () => {
    const fake = await plugin();
    // Attach the handler up front: the rejection can land while close() is still awaited.
    const call = hub.call("session.info", {}, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await expect.poll(() => fake.received.length).toBe(1);
    await fake.close();
    const error = await call;
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "SESSION_NOT_FOUND", retryable: true });
  });
});

describe("session names", () => {
  it("a reconnect with the same instance takes the file's new name", async () => {
    const first = await plugin({ instance: "instance-rename-1", file: "Untitled" });
    await first.close();
    await plugin({ instance: "instance-rename-1", file: "Quarterly deck" });
    await expect.poll(() => hub.sessions().map((s) => s.file)).toEqual(["Quarterly deck"]);
  });
});

describe("session routing", () => {
  it("errors with NO_SESSION when nothing is connected", async () => {
    await expect(hub.call("session.info", {})).rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("refuses to guess between several files", async () => {
    const a = await plugin({
      instance: "instance-a-1",
      file: "A",
      handlers: { "session.info": () => ({ ...SESSION_INFO, file: "A" }) },
    });
    await plugin({ instance: "instance-b-1", file: "B" });
    await expect(hub.call("session.info", {})).rejects.toMatchObject({ code: "AMBIGUOUS_SESSION" });
    await expect(hub.call("session.info", {}, { session: a.session })).resolves.toMatchObject({
      file: "A",
    });
  });
});

describe("read-only mode", () => {
  it("blocks mutating methods and allows reads", async () => {
    await server.close();
    await start({ readOnly: true });
    await plugin({ handlers: { "session.info": () => SESSION_INFO } });
    await expect(hub.call("node.delete", { nodeIds: ["1:2"] })).rejects.toMatchObject({
      code: "READ_ONLY",
    });
    await expect(hub.call("session.info", {})).resolves.toBeDefined();
  });
});

describe("HTTP API", () => {
  it("serves /health without a token and nothing else", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toMatchObject({ service: "figbridge" });
    const sessions = await fetch(`http://127.0.0.1:${port}/sessions`);
    expect(sessions.status).toBe(401);
  });

  it("rejects DNS-rebinding hosts and browser origins", async () => {
    expect(await getWithHost("/health", `evil.example:${port}`)).toBe(403);
    expect(await getWithHost("/health", `localhost:${port}`)).toBe(200);
    const browser = await rpc({ method: "session.info" }, { origin: "https://evil.example" });
    expect(browser.status).toBe(403);
  });

  it("forwards /rpc calls and reports unknown methods", async () => {
    await plugin({ handlers: { "session.info": () => SESSION_INFO } });
    const ok = (await (await rpc({ method: "session.info" })).json()) as { ok: boolean };
    expect(ok).toEqual({ ok: true, result: SESSION_INFO });
    const unknown = await rpc({ method: "eval", params: { code: "1" } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "METHOD_NOT_FOUND" } });
  });

  it("stores and serves blobs by content address", async () => {
    const put = async () =>
      (await (
        await fetch(`http://127.0.0.1:${port}/blob`, {
          method: "PUT",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
          body: new Uint8Array([1, 2, 3]),
        })
      ).json()) as { blob: string };
    const first = await put();
    const second = await put();
    expect(first.blob).toBe(second.blob);
    const get = await fetch(`http://127.0.0.1:${port}/blob/${first.blob}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
