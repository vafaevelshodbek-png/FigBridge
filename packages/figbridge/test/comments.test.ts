import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "@figbridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FigmaCommentsClient, parseFileKey } from "../src/comments.js";
import { loadFigmaToken } from "../src/figma-rest.js";

const root = {
  id: "1",
  parent_id: "",
  message: "Переделать заголовок",
  created_at: "2026-10-20T10:00:00Z",
  resolved_at: null,
  user: { id: "u1", handle: "Author" },
  client_meta: { node_id: "12:34", node_offset: { x: 4, y: 5 } },
};
const reply = { ...root, id: "2", parent_id: "1", message: "Ответ", client_meta: null };
const resolved = { ...root, id: "3", resolved_at: "2026-10-20T11:00:00Z" };

function setup(comments: unknown[] = [root, reply, resolved]) {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ comments })));
  return {
    transport,
    client: new FigmaCommentsClient({ token: () => "secret", fetch: transport }),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("native comments", () => {
  it("accepts null order_id on replies as returned by the live Figma endpoint", async () => {
    const nativeReply = { ...reply, order_id: null };
    const { client } = setup([root, nativeReply]);
    const result = await client.list({ file: "key", nodeId: "12:34", status: "open" });
    expect(result.comments).toEqual([root, nativeReply]);
    expect(result.total).toBe(2);
  });
  it("loads credentials from the environment before the local file, without caching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "figbridge-credential-"));
    vi.stubEnv("FIGBRIDGE_HOME", dir);
    vi.stubEnv("FIGMA_ACCESS_TOKEN", undefined);
    try {
      expect(await loadFigmaToken()).toBe("");
      writeFileSync(join(dir, "figma-token"), "file-token\n");
      expect(await loadFigmaToken()).toBe("file-token");
      writeFileSync(join(dir, "figma-token"), "rotated-token\n");
      expect(await loadFigmaToken()).toBe("rotated-token");
      vi.stubEnv("FIGMA_ACCESS_TOKEN", "env-token\n");
      expect(await loadFigmaToken()).toBe("env-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps replies to resolved roots in the resolved filter", async () => {
    const resolvedReply = { ...reply, parent_id: "3" };
    const { client } = setup([resolvedReply, resolved]);
    expect(
      (await client.list({ file: "key", status: "resolved", nodeId: "12:34" })).comments,
    ).toEqual([resolvedReply, resolved]);
    expect((await client.list({ file: "key", status: "open" })).comments).toEqual([]);
  });
  it("accepts keys and official file/branch URLs, rejects arbitrary hosts and paths", () => {
    expect(parseFileKey("Abc123")).toBe("Abc123");
    expect(parseFileKey("https://www.figma.com/design/Abc123/Deck?node-id=12-34")).toBe("Abc123");
    expect(parseFileKey("https://www.figma.com/design/Abc123/branch/Branch456/Deck")).toBe(
      "Branch456",
    );
    for (const file of [
      "https://evil.test/design/key/a",
      "https://figma.com.evil.test/design/key/a",
      "https://user:secret@figma.com/design/key/a",
      "http://figma.com/design/key/a",
      "https://figma.com:444/design/key/a",
      "https://figma.com/settings/key",
      "../key",
    ]) {
      expect(() => parseFileKey(file)).toThrow(BridgeError);
    }
  });

  it("reads the fixed REST endpoint and keeps native authors, messages, replies and anchors", async () => {
    const { client, transport } = setup();
    const result = await client.list({ file: "Abc123" });
    expect(result.comments).toEqual([root, reply, resolved]);
    expect(result.total).toBe(3);
    expect(transport.mock.calls[0]?.[0]).toBe("https://api.figma.com/v1/files/Abc123/comments");
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      headers: { "X-Figma-Token": "secret" },
      redirect: "error",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("inherits root resolution and exact anchor for replies even if returned before the root", async () => {
    const { client } = setup([reply, root, resolved]);
    expect((await client.list({ file: "key", nodeId: "12-34", status: "open" })).comments).toEqual([
      root,
      reply,
    ]);
    expect((await client.list({ file: "key", status: "resolved" })).comments).toEqual([resolved]);
    expect((await client.list({ file: "key", nodeId: "12:35" })).comments).toEqual([]);
  });

  it("paginates without losing comments and rejects invalid cursors", async () => {
    const { client } = setup();
    const first = await client.list({ file: "key", limit: 2 });
    expect(first.comments).toEqual([root, reply]);
    expect(first.nextCursor).toBe("2");
    const last = await client.list({ file: "key", cursor: first.nextCursor, limit: 2 });
    expect(last.comments).toEqual([resolved]);
    expect(last.nextCursor).toBeUndefined();
    await expect(client.list({ file: "key", cursor: "nan" })).rejects.toThrow();
  });

  it("keeps pagination order deterministic when Figma changes response order", async () => {
    const { client, transport } = setup([resolved, reply, root]);
    const first = await client.list({ file: "key", limit: 1 });
    transport.mockImplementation(() =>
      Promise.resolve(Response.json({ comments: [root, reply, resolved] })),
    );
    const second = await client.list({ file: "key", limit: 1, cursor: first.nextCursor });
    expect(first.comments[0]?.id).toBe("1");
    expect(second.comments[0]?.id).toBe("2");
  });

  it("bounds message and page size and exposes truncation", async () => {
    const { client } = setup(
      Array.from({ length: 100 }, (_, i) => ({
        ...root,
        id: String(i),
        message: "a".repeat(20_000),
      })),
    );
    const result = await client.list({ file: "key", limit: 100 });
    expect(JSON.stringify(result).length).toBeLessThan(60_000);
    expect(result.comments[0]).toMatchObject({ messageTruncated: true });
    expect(result.nextCursor).toBeDefined();
    expect(result.total).toBe(100);
  });

  it("does not guess page membership for absolute canvas pins or missing root replies", async () => {
    const absolute = { ...root, client_meta: { x: 12, y: 34 } };
    const { client } = setup([absolute, { ...reply, parent_id: "missing" }]);
    expect((await client.list({ file: "key" })).comments).toHaveLength(2);
    expect((await client.list({ file: "key", nodeId: "12:34" })).comments).toEqual([]);
  });

  it("fails before network access when no credential is configured", async () => {
    const transport = vi.fn<typeof fetch>();
    const client = new FigmaCommentsClient({ token: () => "", fetch: transport });
    await expect(client.list({ file: "key" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])(
    "returns a sanitized actionable error for HTTP %s",
    async (status) => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("secret error", {
          status,
          headers: { "retry-after": "30" },
        }),
      );
      const client = new FigmaCommentsClient({ token: () => "secret", fetch: transport });
      try {
        await client.list({ file: "key" });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(BridgeError);
        const wire = (error as BridgeError).toWire();
        expect(JSON.stringify(wire)).not.toContain("secret");
        if (status === 429) expect(wire).toMatchObject({ data: { status: 429, retryAfter: "30" } });
      }
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["not JSON", '{"comments":[{}]}'])("rejects invalid upstream data", async (body) => {
    const client = new FigmaCommentsClient({
      token: () => "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    });
    await expect(client.list({ file: "key" })).rejects.toMatchObject({ code: "DOCUMENT_INVALID" });
  });

  it("rejects oversized upstream data", async () => {
    const client = new FigmaCommentsClient({
      token: () => "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(8_388_609))),
    });
    await expect(client.list({ file: "key" })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("propagates cancellation and distinguishes timeout from transport failures", async () => {
    const abort = new AbortController();
    abort.abort();
    const client = new FigmaCommentsClient({
      token: () => "secret",
      fetch: (_url, init) => {
        init?.signal?.throwIfAborted();
        return Promise.reject(new TypeError("secret transport details"));
      },
    });
    await expect(client.list({ file: "key" }, abort.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(client.list({ file: "key" })).rejects.toMatchObject({ code: "INTERNAL" });
    const timed = new FigmaCommentsClient({
      token: () => "secret",
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("secret"));
            },
            { once: true },
          );
        }),
    });
    await expect(timed.list({ file: "key" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
