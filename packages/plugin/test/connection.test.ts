/**
 * The UI's hub connection against the real hub (not a mock): handshake, request/response,
 * refusal without retry, reconnection with backoff after the hub restarts, and stop().
 * Node's built-in WebSocket is the same WHATWG API the plugin iframe uses.
 */
import { BlobStore, Hub, HubServer } from "figbridge";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, type ConnectionState } from "../src/ui/connection.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

let hub: Hub;
let server: HubServer | undefined;
const connections: Connection[] = [];

async function startHub(port = 0): Promise<number> {
  hub = new Hub();
  server = new HubServer({
    hub,
    blobs: new BlobStore(),
    token: TOKEN,
    port,
    logger: pino({ level: "silent" }),
    version: "test",
    heartbeatMs: 60_000,
    helloTimeoutMs: 1_000,
  });
  return server.listen();
}

function connect(
  port: number,
  token = TOKEN,
  onMessage: (message: unknown) => void = () => undefined,
) {
  const states: ConnectionState[] = [];
  const connection = new Connection({
    url: `ws://127.0.0.1:${String(port)}/plugin`,
    hello: () => ({
      v: 1,
      type: "hello",
      token,
      protocols: [1],
      plugin: { version: "test" },
      file: { name: "Deck", editorType: "figma" },
      instance: "instance-connection-test",
    }),
    onMessage,
    onState: (state) => states.push(state),
  });
  connections.push(connection);
  connection.start();
  return { connection, states };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.stop();
  await server?.close();
  server = undefined;
});

describe("Connection", () => {
  it("handshakes and carries requests both ways", async () => {
    const port = await startHub();
    const { connection, states } = connect(port, TOKEN, (message) => {
      const req = message as { type: string; id: string };
      if (req.type === "req") {
        connection.send({
          v: 1,
          type: "res",
          id: req.id,
          ok: true,
          result: {
            file: "Deck",
            editorType: "figma",
            page: { id: "0:1", name: "P", current: true },
            selectionCount: 0,
          },
        });
      }
    });
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe("connected");
    });
    expect(hub.sessions()).toHaveLength(1);
    await expect(hub.call("session.info", {})).resolves.toMatchObject({ file: "Deck" });
  });

  it("stops at a wrong token instead of retrying", async () => {
    const port = await startHub();
    const { states } = connect(port, "f".repeat(32));
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe("unauthorized");
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(states.filter((s) => s.status === "connecting")).toHaveLength(1);
  });

  it("reconnects with backoff after the hub restarts", async () => {
    const port = await startHub();
    const { states } = connect(port);
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe("connected");
    });
    const before = states.length;
    await server?.close();
    // Full-jitter backoff may retry almost at once, so "waiting" need not still be current.
    await vi.waitFor(() => {
      expect(states.slice(before).some((state) => state.status === "waiting")).toBe(true);
    });
    await startHub(port);
    await vi.waitFor(
      () => {
        expect(states.at(-1)?.status).toBe("connected");
      },
      { timeout: 15_000 },
    );
    expect(hub.sessions()).toHaveLength(1);
  });

  it("does not reconnect after stop()", async () => {
    const port = await startHub();
    const { connection, states } = connect(port);
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe("connected");
    });
    connection.stop();
    await vi.waitFor(() => {
      expect(hub.sessions()).toHaveLength(0);
    });
    expect(states.at(-1)?.status).toBe("connected");
    expect(
      connection.send({
        v: 1,
        type: "evt",
        event: "progress",
        data: { id: "x", done: 1 },
      } as never),
    ).toBe(false);
  });
});
