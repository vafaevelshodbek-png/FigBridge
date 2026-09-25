/**
 * The access decision table and risk assessment, without Figma.
 */
import { ACCESS_MODES } from "@figbridge/protocol";
import { describe, expect, it } from "vitest";
import { assess, decide, LARGE_CHANGE, LARGE_DELETE, type Risk } from "../src/main/access.js";

const sizes: Record<string, { type: string; size: number }> = {
  "1:1": { type: "RECTANGLE", size: 1 },
  "1:2": { type: "FRAME", size: LARGE_DELETE + 5 },
  "0:1": { type: "PAGE", size: 3 },
};
const sizer = (id: string) => Promise.resolve(sizes[id]);
const rect = { type: "rect" };

describe("assess", () => {
  it("reads are reads", async () => {
    expect((await assess("node.get", { nodeId: "1:1" }, sizer)).risk).toBe("read");
    expect((await assess("unknown.method", {}, sizer)).risk).toBe("read");
  });

  it.each([
    ["a small deletion", { nodeIds: ["1:1"] }, "write"],
    ["deleting a large frame", { nodeIds: ["1:2"] }, "destructive"],
    ["deleting a page", { nodeIds: ["0:1"] }, "destructive"],
    ["deleting missing nodes", { nodeIds: ["9:9"] }, "write"],
  ] as const)("%s", async (_, params, risk) => {
    expect((await assess("node.delete", params, sizer)).risk).toBe(risk);
  });

  it("rendering: a new slide is a write, replacing a frame or a huge slide is destructive", async () => {
    const slide = (n: number) => ({ name: "S", children: Array.from({ length: n }, () => rect) });
    expect((await assess("scene.render", { slide: slide(5) }, sizer)).risk).toBe("write");
    expect((await assess("scene.render", { slide: slide(5), replaceId: "1:2" }, sizer)).risk).toBe(
      "destructive",
    );
    expect((await assess("scene.render", { slide: slide(LARGE_CHANGE + 1) }, sizer)).risk).toBe(
      "destructive",
    );
  });

  it("counts group members when judging size", async () => {
    const group = { type: "group", children: Array.from({ length: LARGE_CHANGE }, () => rect) };
    expect((await assess("nodes.create", { nodes: [group] }, sizer)).risk).toBe("destructive");
  });

  it("summaries say what will happen", async () => {
    expect((await assess("node.delete", { nodeIds: ["1:1", "1:2"] }, sizer)).summary).toBe(
      `Delete 2 layers (${String(1 + LARGE_DELETE + 5)} with children)`,
    );
  });
});

describe("decide", () => {
  const table: Record<(typeof ACCESS_MODES)[number], Record<Risk, string>> = {
    "read-only": { read: "allow", write: "deny", destructive: "deny" },
    ask: { read: "allow", write: "ask", destructive: "ask" },
    auto: { read: "allow", write: "allow", destructive: "ask" },
    unrestricted: { read: "allow", write: "allow", destructive: "allow" },
  };
  for (const mode of ACCESS_MODES) {
    for (const risk of ["read", "write", "destructive"] as const) {
      it(`${mode} × ${risk} → ${table[mode][risk]}`, () => {
        expect(decide(mode, risk, false)).toBe(table[mode][risk]);
      });
    }
  }

  it("a session approval covers Ask and Auto, never Read only", () => {
    expect(decide("ask", "destructive", true)).toBe("allow");
    expect(decide("auto", "destructive", true)).toBe("allow");
    expect(decide("read-only", "write", true)).toBe("deny");
  });
});
