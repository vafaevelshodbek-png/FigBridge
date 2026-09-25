import { describe, expect, it } from "vitest";
import {
  BridgeError,
  HelloSchema,
  isMethodName,
  METHODS,
  MessageSchema,
  negotiateProtocol,
} from "../src/index.js";

const ID = "01J9Z3K8Q2W5X7Y9A1B3C5D7E9";

describe("envelope", () => {
  it("accepts a well-formed request and routes it by type", () => {
    const parsed = MessageSchema.parse({
      v: 1,
      type: "req",
      id: ID,
      method: "session.info",
      params: {},
    });
    expect(parsed.type).toBe("req");
  });

  it("distinguishes success and error responses by `ok`", () => {
    const ok = MessageSchema.parse({ v: 1, type: "res", id: ID, ok: true, result: { a: 1 } });
    const err = MessageSchema.parse({
      v: 1,
      type: "res",
      id: ID,
      ok: false,
      error: { code: "TIMEOUT", message: "slow", retryable: true },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(err).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("rejects non-ULID ids and unknown protocol versions", () => {
    expect(MessageSchema.safeParse({ v: 1, type: "cancel", id: "abc" }).success).toBe(false);
    expect(MessageSchema.safeParse({ v: 2, type: "cancel", id: ID }).success).toBe(false);
  });

  it("validates the plugin handshake", () => {
    const hello = {
      v: 1,
      type: "hello",
      token: "t",
      protocols: [1],
      plugin: { version: "0.1.0" },
      file: { name: "Deck", editorType: "slides" },
      instance: "inst_12345",
    };
    expect(HelloSchema.parse(hello).file.editorType).toBe("slides");
    expect(HelloSchema.safeParse({ ...hello, protocols: [] }).success).toBe(false);
  });
});

describe("negotiateProtocol", () => {
  it("picks the highest common version or none", () => {
    expect(negotiateProtocol([1, 2])).toBe(1);
    expect(negotiateProtocol([2, 3])).toBeUndefined();
  });
});

describe("BridgeError", () => {
  it("round-trips through the wire without leaking the cause", () => {
    const original = new BridgeError("FONT_MISSING", "Inter Bold is not available", {
      data: { family: "Inter" },
      cause: new Error("secret path C:/x"),
    });
    const wire = original.toWire();
    expect(wire).toEqual({
      code: "FONT_MISSING",
      message: "Inter Bold is not available",
      retryable: false,
      data: { family: "Inter" },
    });
    expect(JSON.stringify(wire)).not.toContain("secret");
    expect(BridgeError.fromWire(wire).code).toBe("FONT_MISSING");
  });

  it("marks transient codes retryable by default", () => {
    expect(new BridgeError("TIMEOUT", "x").retryable).toBe(true);
    expect(new BridgeError("VALIDATION", "x").retryable).toBe(false);
  });

  it("normalizes unknown throwables to INTERNAL", () => {
    expect(BridgeError.from("boom").code).toBe("INTERNAL");
    const known = new BridgeError("NODE_NOT_FOUND", "x");
    expect(BridgeError.from(known)).toBe(known);
  });
});

describe("method catalog", () => {
  it("guards method names", () => {
    expect(isMethodName("node.get")).toBe(true);
    expect(isMethodName("eval")).toBe(false);
    expect(isMethodName("toString")).toBe(false);
  });

  it("declares every mutating method explicitly", () => {
    const mutating = Object.entries(METHODS)
      .filter(([, spec]) => spec.mutates)
      .map(([name]) => name)
      .sort();
    expect(mutating).toEqual([
      "node.clone",
      "node.delete",
      "node.update",
      "nodes.create",
      "scene.render",
    ]);
  });

  it("applies parameter defaults", () => {
    expect(METHODS["document.outline"].params.parse({})).toEqual({ depth: 1, limit: 100 });
    expect(METHODS["node.export"].params.parse({ nodeId: "1:2" })).toEqual({
      nodeId: "1:2",
      format: "png",
      scale: 1,
    });
  });

  it("rejects malformed node ids and empty updates", () => {
    expect(METHODS["node.get"].params.safeParse({ nodeId: "abc" }).success).toBe(false);
    expect(METHODS["node.update"].params.safeParse({ nodeId: "1:2", props: {} }).success).toBe(
      false,
    );
  });
});

describe("access constants", () => {
  it("MUTATING_METHODS is exactly the methods that mutate", async () => {
    const { METHODS, MUTATING_METHODS } = await import("../src/index.js");
    const mutating = Object.entries(METHODS)
      .filter(([, spec]) => spec.mutates)
      .map(([name]) => name)
      .sort();
    expect([...MUTATING_METHODS].sort()).toEqual(mutating);
  });
});
