/**
 * The plugin's main thread end to end: code.ts is loaded into the strict fake of the Figma
 * API and driven exactly as the UI iframe drives it (postMessage in, postMessage out).
 * Every response is checked against the protocol's result schema for its method, so the
 * plugin and the hub cannot drift apart.
 */
import { METHODS, type MethodName, type MethodParams, type Response } from "@figbridge/protocol";
import type { Slide } from "@figbridge/scene";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainToUi, UiToMain } from "../src/shared/messages.js";
import { type FakeFigma, type FakeNode, installFakeFigma } from "./fake-figma.js";

let fake: FakeFigma;
let nextId = 0;

/** A 1×1 PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function send(message: UiToMain): void {
  const handler = fake.ui.onmessage;
  if (handler === undefined) throw new Error("code.ts did not install figma.ui.onmessage");
  handler(message);
}

function posted(): MainToUi[] {
  return fake.posted as MainToUi[];
}

/** Answer the main thread's blob requests as the UI would. */
function serveBlobs(blobs: Record<string, Uint8Array>): void {
  const seen = new Set<number>();
  const pump = () => {
    for (const message of posted()) {
      if (message.kind === "blob.get" && !seen.has(message.ticket)) {
        seen.add(message.ticket);
        const bytes = blobs[message.blob] ?? null;
        send({
          kind: "blob.got",
          ticket: message.ticket,
          bytes,
          ...(bytes ? {} : { error: "404" }),
        });
      }
      if (message.kind === "blob.put" && !seen.has(message.ticket)) {
        seen.add(message.ticket);
        send({ kind: "blob.put.done", ticket: message.ticket, blob: `sha256:${"a".repeat(64)}` });
      }
    }
  };
  const original = fake.ui.postMessage;
  fake.ui.postMessage = (message: unknown) => {
    original(message);
    queueMicrotask(pump);
  };
}

async function call<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  extra: { idempotencyKey?: string } = {},
): Promise<Response> {
  const id = `01J${String(++nextId).padStart(23, "0")}`;
  const parsed = METHODS[method].params.parse(params);
  send({
    kind: "request",
    request: { v: 1, type: "req", id, method, params: parsed, ...extra } as never,
  });
  await vi.waitFor(() => {
    expect(posted().some((m) => m.kind === "response" && m.response.id === id)).toBe(true);
  });
  const message = posted().find((m) => m.kind === "response" && m.response.id === id);
  if (message?.kind !== "response") throw new Error("no response");
  const response = message.response;
  if (response.ok) METHODS[method].result.parse(response.result);
  return response;
}

function ok(response: Response): Record<string, unknown> {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as Record<string, unknown>;
}

const slide: Slide = {
  name: "Slide",
  width: 400,
  height: 300,
  background: [{ type: "solid", color: "#FFFFFF", opacity: 1 }],
  children: [
    {
      id: "t",
      name: "Title",
      type: "text",
      x: 20,
      y: 20,
      w: 300,
      h: 40,
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      characters: "Hello",
      runs: [
        {
          start: 0,
          end: 5,
          fontFamily: "Brand Sans",
          fontStyle: "Bold",
          fontSize: 24,
          fill: { type: "solid", color: "#111111", opacity: 1 },
          letterSpacing: 0,
          textCase: "original",
          decoration: "none",
        },
      ],
      paragraphs: [],
      align: "left",
      verticalAlign: "top",
      sizing: "fixed",
    },
    {
      id: "p",
      name: "Photo",
      type: "image",
      x: 20,
      y: 80,
      w: 100,
      h: 100,
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      image: { type: "image", blob: `sha256:${"b".repeat(64)}`, scaleMode: "fill", opacity: 1 },
      radii: [0, 0, 0, 0],
      strokes: [],
    },
  ],
};

beforeEach(async () => {
  fake = installFakeFigma();
  Object.assign(globalThis, { __html__: "<html></html>", __PLUGIN_VERSION__: "0.0.0-test" });
  vi.resetModules();
  await import("../src/main/code.js");
});

describe("startup", () => {
  it("shows the UI and introduces the file", () => {
    expect(posted()[0]).toEqual({
      kind: "hello-info",
      file: "Untitled",
      label: "",
      editorType: "figma",
      pluginVersion: "0.0.0-test",
    });
  });

  it("remembers the name the user gives the file and announces it next time", async () => {
    expect(posted()[0]).toMatchObject({ kind: "hello-info", label: "" });
    send({ kind: "label.set", label: "  Quarterly deck  " });
    expect(fake.root.getPluginData("figbridge.label")).toBe("Quarterly deck");
    vi.resetModules();
    fake.posted.length = 0;
    await import("../src/main/code.js");
    expect(posted()[0]).toMatchObject({ kind: "hello-info", label: "Quarterly deck" });
  });

  it("keeps the pairing token in clientStorage for the UI", async () => {
    send({ kind: "storage.set", key: "figbridge.token", value: "abc" });
    send({ kind: "storage.get", ticket: 7, key: "figbridge.token" });
    await vi.waitFor(() => {
      expect(posted()).toContainEqual({ kind: "storage.value", ticket: 7, value: "abc" });
    });
  });
});

describe("read methods", () => {
  it("session.info, page.list and page.set", async () => {
    const second = fake.addPage("Second");
    expect(ok(await call("session.info", {}))).toMatchObject({
      file: "Untitled",
      selectionCount: 0,
    });
    const pages = ok(await call("page.list", {}))["pages"] as { name: string; current: boolean }[];
    expect(pages.map((p) => [p.name, p.current])).toEqual([
      ["Page 1", true],
      ["Second", false],
    ]);
    expect(ok(await call("page.set", { pageId: second.id }))).toMatchObject({ name: "Second" });
    expect(fake.currentPage).toBe(second);
    const missing = await call("page.set", { pageId: "999:1" });
    expect(missing).toMatchObject({ ok: false, error: { code: "NODE_NOT_FOUND" } });
  });

  it("document.outline pages breadth first with a stable cursor", async () => {
    for (let i = 0; i < 3; i++) {
      const frame = fake.createFrame();
      frame.name = `F${String(i)}`;
      fake.currentPage.appendChild(frame);
      const child = fake.createRectangle();
      child.name = `R${String(i)}`;
      frame.appendChild(child);
    }
    const first = ok(await call("document.outline", { depth: 2, limit: 4 }));
    const names = (first["nodes"] as { name: string }[]).map((n) => n.name);
    expect(names).toEqual(["F0", "F1", "F2", "R0"]);
    const rest = ok(
      await call("document.outline", { depth: 2, limit: 4, cursor: first["nextCursor"] as string }),
    );
    expect((rest["nodes"] as { name: string }[]).map((n) => n.name)).toEqual(["R1", "R2"]);
    expect(rest["nextCursor"]).toBeUndefined();
    expect(await call("document.outline", { cursor: "-1" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });

  it("node.find filters by name and type and reports truncation", async () => {
    for (const name of ["Logo", "logo dark", "Title"]) {
      const node = fake.createRectangle();
      node.name = name;
      fake.currentPage.appendChild(node);
    }
    const found = ok(await call("node.find", { name: "LOGO", types: ["RECTANGLE"] }));
    expect((found["nodes"] as { name: string }[]).map((n) => n.name)).toEqual([
      "Logo",
      "logo dark",
    ]);
    expect(ok(await call("node.find", { limit: 1 }))["truncated"]).toBe(true);
  });

  it("node.get describes a node and its children", async () => {
    const frame = fake.createFrame();
    fake.currentPage.appendChild(frame);
    frame.resize(200, 100);
    frame.x = 10;
    frame.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }];
    const rect = fake.createRectangle();
    frame.appendChild(rect);
    rect.x = 5;
    const node = ok(await call("node.get", { nodeId: frame.id, depth: 1 }))["node"] as Record<
      string,
      unknown
    >;
    expect(node).toMatchObject({
      id: frame.id,
      type: "FRAME",
      box: { x: 10, w: 200, h: 100 },
      childCount: 1,
    });
    expect((node["children"] as { box: { x: number } }[])[0]?.box.x).toBe(15);
    expect(await call("node.get", { nodeId: "404:1" })).toMatchObject({
      ok: false,
      error: { code: "NODE_NOT_FOUND" },
    });
  });

  it("node.export uploads the bytes through the UI", async () => {
    serveBlobs({});
    const frame = fake.createFrame();
    fake.currentPage.appendChild(frame);
    frame.resize(100, 50);
    const result = ok(await call("node.export", { nodeId: frame.id, format: "png", scale: 2 }));
    expect(result).toMatchObject({ mimeType: "image/png", width: 200, height: 100 });
  });
});

describe("write methods", () => {
  beforeEach(() => {
    send({ kind: "access.set", mode: "unrestricted" });
  });

  it("scene.render builds the frame, substitutes fonts and commits one undo step", async () => {
    serveBlobs({ [`sha256:${"b".repeat(64)}`]: PNG });
    const result = ok(await call("scene.render", { slide, x: 100, y: 50 }));
    const frame = fake.currentPage.children.at(-1) as FakeNode;
    expect(result["frameId"]).toBe(frame.id);
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([100, 50, 400, 300]);
    expect(frame.children.map((c) => c.type)).toEqual(["TEXT", "RECTANGLE"]);
    expect(result["warnings"]).toEqual(["font Brand Sans Bold replaced by Inter Bold"]);
    expect(fake.undoSteps).toBe(1);
    expect(posted().some((m) => m.kind === "progress")).toBe(true);
  });

  it("scene.render with replaceId swaps the old frame in place", async () => {
    serveBlobs({ [`sha256:${"b".repeat(64)}`]: PNG });
    const first = ok(await call("scene.render", { slide, x: 300, y: 400 }));
    const second = ok(
      await call("scene.render", { slide, x: 0, y: 0, replaceId: first["frameId"] as string }),
    );
    expect(await fake.getNodeByIdAsync(first["frameId"] as string)).toBeNull();
    const frame = (await fake.getNodeByIdAsync(second["frameId"] as string)) as FakeNode;
    expect([frame.x, frame.y]).toEqual([300, 400]);
  });

  it("a missing image becomes a warning, not a failed call", async () => {
    serveBlobs({});
    const result = ok(await call("scene.render", { slide, x: 0, y: 0 }));
    expect(result["warnings"]).toContainEqual(expect.stringContaining("image"));
  });

  it("node.update edits properties and text with its fonts loaded", async () => {
    serveBlobs({ [`sha256:${"b".repeat(64)}`]: PNG });
    ok(await call("scene.render", { slide, x: 0, y: 0 }));
    const text = fake.all().find((n) => n.type === "TEXT") as FakeNode;
    const updated = ok(
      await call("node.update", {
        nodeId: text.id,
        props: { text: "Bye", x: 7, name: "T2", opacity: 0.5 },
      }),
    );
    expect(updated).toMatchObject({ name: "T2", text: "Bye" });
    expect(text.opacity).toBe(0.5);
    const rect = fake.all().find((n) => n.type === "RECTANGLE") as FakeNode;
    ok(
      await call("node.update", {
        nodeId: rect.id,
        props: { fill: "#00FF00", w: 10, h: 20, cornerRadius: 4 },
      }),
    );
    expect(rect.fills).toEqual([{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }]);
    expect(await call("node.update", { nodeId: rect.id, props: { text: "x" } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });

  it("node.clone and node.delete", async () => {
    const rect = fake.createRectangle();
    fake.currentPage.appendChild(rect);
    const copy = ok(await call("node.clone", { nodeId: rect.id, x: 50 }));
    expect(copy["box"]).toMatchObject({ x: 50 });
    const result = ok(
      await call("node.delete", { nodeIds: [rect.id, "404:1", fake.currentPage.id] }),
    );
    expect(result).toEqual({ deleted: [rect.id], missing: ["404:1", fake.currentPage.id] });
  });

  it("nodes.create renders loose nodes into a parent", async () => {
    const frame = fake.createFrame();
    fake.currentPage.appendChild(frame);
    const [text] = slide.children;
    if (text === undefined) throw new Error("fixture");
    const result = ok(await call("nodes.create", { nodes: [text], parentId: frame.id }));
    expect(result["ids"]).toHaveLength(1);
    expect(frame.children[0]?.type).toBe("TEXT");
  });
});

describe("dispatch", () => {
  beforeEach(() => {
    send({ kind: "access.set", mode: "unrestricted" });
  });

  it("answers an idempotent retry from cache without redoing the work", async () => {
    const rect = fake.createRectangle();
    fake.currentPage.appendChild(rect);
    ok(await call("node.clone", { nodeId: rect.id }, { idempotencyKey: "k1" }));
    ok(await call("node.clone", { nodeId: rect.id }, { idempotencyKey: "k1" }));
    expect(fake.currentPage.children).toHaveLength(2);
  });

  it("cancels a render between nodes", async () => {
    serveBlobs({ [`sha256:${"b".repeat(64)}`]: PNG });
    const many: Slide = {
      ...slide,
      children: Array.from(
        { length: 60 },
        (_, i) => ({ ...slide.children[1], id: `p${String(i)}` }) as Slide["children"][number],
      ),
    };
    const id = `01J${String(++nextId).padStart(23, "0")}`;
    send({
      kind: "request",
      request: {
        v: 1,
        type: "req",
        id,
        method: "scene.render",
        params: { slide: many, x: 0, y: 0 },
      } as never,
    });
    send({ kind: "cancel", id });
    await vi.waitFor(() => {
      expect(posted().some((m) => m.kind === "response" && m.response.id === id)).toBe(true);
    });
    const message = posted().find((m) => m.kind === "response" && m.response.id === id);
    expect(message).toMatchObject({ response: { ok: false, error: { code: "CANCELLED" } } });
  });

  it("reports unknown methods", async () => {
    const id = `01J${String(++nextId).padStart(23, "0")}`;
    send({
      kind: "request",
      request: { v: 1, type: "req", id, method: "nope", params: {} } as never,
    });
    await vi.waitFor(() => {
      expect(posted().some((m) => m.kind === "response" && m.response.id === id)).toBe(true);
    });
    expect(posted().find((m) => m.kind === "response" && m.response.id === id)).toMatchObject({
      response: { ok: false, error: { code: "METHOD_NOT_FOUND" } },
    });
  });
});

describe("agent access", () => {
  function frame(): FakeNode {
    const node = fake.createFrame();
    fake.currentPage.appendChild(node);
    return node;
  }

  /** Start a call without waiting; returns a getter for its response. */
  function start<M extends MethodName>(method: M, params: MethodParams<M>) {
    const id = `01J${String(++nextId).padStart(23, "0")}`;
    send({
      kind: "request",
      request: {
        v: 1,
        type: "req",
        id,
        method,
        params: METHODS[method].params.parse(params),
      } as never,
    });
    return {
      id,
      response: () => {
        const message = posted().find((m) => m.kind === "response" && m.response.id === id);
        return message?.kind === "response" ? message.response : undefined;
      },
    };
  }

  async function approvalFor(id: string) {
    await vi.waitFor(() => {
      expect(posted().some((m) => m.kind === "approval.request" && m.id === id)).toBe(true);
    });
    return posted().find((m) => m.kind === "approval.request" && m.id === id);
  }

  it("asks by default, and reports the mode in session.info", async () => {
    expect(ok(await call("session.info", {}))).toMatchObject({ access: "ask", paused: false });
    expect(posted()).toContainEqual({ kind: "access", mode: "ask", paused: false });
  });

  it("ask: a change waits for the user; 'once' lets one through", async () => {
    const node = frame();
    const first = start("node.update", { nodeId: node.id, props: { name: "A" } });
    expect(await approvalFor(first.id)).toMatchObject({
      summary: `Change layer ${node.id}`,
      risk: "write",
    });
    expect(first.response()).toBeUndefined();
    send({ kind: "approval.answer", id: first.id, answer: "once" });
    await vi.waitFor(() => {
      expect(first.response()?.ok).toBe(true);
    });
    expect(node.name).toBe("A");
    const second = start("node.update", { nodeId: node.id, props: { name: "B" } });
    await approvalFor(second.id);
  });

  it("ask: 'session' approves the rest of the session; 'deny' refuses with DENIED", async () => {
    const node = frame();
    const denied = start("node.update", { nodeId: node.id, props: { name: "no" } });
    await approvalFor(denied.id);
    send({ kind: "approval.answer", id: denied.id, answer: "deny" });
    await vi.waitFor(() => {
      expect(denied.response()).toMatchObject({ ok: false, error: { code: "DENIED" } });
    });
    const first = start("node.update", { nodeId: node.id, props: { name: "A" } });
    await approvalFor(first.id);
    send({ kind: "approval.answer", id: first.id, answer: "session" });
    await vi.waitFor(() => {
      expect(first.response()?.ok).toBe(true);
    });
    expect(ok(await call("node.update", { nodeId: node.id, props: { name: "B" } }))).toMatchObject({
      name: "B",
    });
  });

  it("ask: reads never wait, even while a change does", async () => {
    const node = frame();
    const change = start("node.update", { nodeId: node.id, props: { name: "A" } });
    await approvalFor(change.id);
    expect(ok(await call("session.info", {}))).toMatchObject({ file: "Untitled" });
    expect(change.response()).toBeUndefined();
  });

  it("an unanswered approval is declined after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const node = frame();
      const change = start("node.update", { nodeId: node.id, props: { name: "A" } });
      await vi.waitFor(() => {
        expect(posted().some((m) => m.kind === "approval.request" && m.id === change.id)).toBe(
          true,
        );
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => {
        expect(change.response()).toMatchObject({ ok: false, error: { code: "DENIED" } });
      });
      expect(posted()).toContainEqual({ kind: "approval.closed", id: change.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("read-only refuses changes and still reads", async () => {
    send({ kind: "access.set", mode: "read-only" });
    const node = frame();
    expect(await call("node.update", { nodeId: node.id, props: { name: "A" } })).toMatchObject({
      ok: false,
      error: { code: "READ_ONLY" },
    });
    expect(ok(await call("node.get", { nodeId: node.id }))).toBeDefined();
  });

  it("auto runs ordinary changes and asks before destructive ones", async () => {
    send({ kind: "access.set", mode: "auto" });
    const small = frame();
    expect(ok(await call("node.update", { nodeId: small.id, props: { name: "A" } }))).toMatchObject(
      { name: "A" },
    );
    const big = frame();
    for (let i = 0; i < 25; i++) big.appendChild(fake.createRectangle());
    const deletion = start("node.delete", { nodeIds: [big.id] });
    expect(await approvalFor(deletion.id)).toMatchObject({
      risk: "destructive",
      summary: "Delete 1 layer (26 with children)",
    });
    send({ kind: "approval.answer", id: deletion.id, answer: "once" });
    await vi.waitFor(() => {
      expect(deletion.response()?.ok).toBe(true);
    });
  });

  it("the mode is kept in the file, except unrestricted", async () => {
    send({ kind: "access.set", mode: "auto" });
    expect(fake.root.getPluginData("figbridge.access")).toBe("auto");
    send({ kind: "access.set", mode: "unrestricted" });
    expect(fake.root.getPluginData("figbridge.access")).toBe("auto");
    // Reopen the plugin on the same file.
    vi.resetModules();
    fake.posted.length = 0;
    await import("../src/main/code.js");
    expect(ok(await call("session.info", {}))).toMatchObject({ access: "auto" });
  });

  it("pause refuses everything, reads included, until resumed", async () => {
    send({ kind: "pause.set", paused: true });
    expect(await call("session.info", {})).toMatchObject({ ok: false, error: { code: "PAUSED" } });
    send({ kind: "pause.set", paused: false });
    expect(ok(await call("session.info", {}))).toMatchObject({ paused: false });
  });

  it("pausing declines pending approvals and cancels running work", async () => {
    const node = frame();
    const change = start("node.update", { nodeId: node.id, props: { name: "A" } });
    await approvalFor(change.id);
    send({ kind: "pause.set", paused: true });
    await vi.waitFor(() => {
      expect(change.response()).toMatchObject({ ok: false, error: { code: "DENIED" } });
    });
  });

  it("the activity feed follows each call", async () => {
    send({ kind: "access.set", mode: "unrestricted" });
    const node = frame();
    const response = await call("node.update", { nodeId: node.id, props: { name: "A" } });
    const entries = posted().flatMap((m) =>
      m.kind === "activity" && m.entry.id === (response as { id: string }).id
        ? [m.entry.status]
        : [],
    );
    expect(entries).toEqual(["running", "done"]);
  });
});
