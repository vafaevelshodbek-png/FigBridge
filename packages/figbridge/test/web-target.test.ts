import { expect, it } from "vitest";
import { assertCaptureTarget, resolveCaptureSession } from "../web/target-session.mjs";

it("selects only the expected file among concurrent editor sessions", async () => {
  const client = {
    sessions: () =>
      Promise.resolve([
        { id: "a", file: "Other project" },
        { id: "b", file: "Target" },
      ]),
  };
  expect(await resolveCaptureSession(client, "Target")).toBe("b");
});
it("checks file identity and stops batch writes when access resets", () => {
  expect(() => {
    assertCaptureTarget({ file: "Other", access: "unrestricted" }, "Target", true);
  }).toThrow("Expected Target");
  expect(() => {
    assertCaptureTarget({ file: "Target", access: "ask" }, "Target", true);
  }).toThrow("Batch import stopped");
  expect(() => {
    assertCaptureTarget({ file: "Target", access: "unrestricted", paused: true }, "Target", true);
  }).toThrow("Batch import stopped");
  expect(() => {
    assertCaptureTarget({ file: "Target", access: "unrestricted", paused: false }, "Target", true);
  }).not.toThrow();
  expect(() => {
    assertCaptureTarget({ file: "Target", access: "ask" }, "Target");
  }).not.toThrow();
});
it("refuses missing and ambiguous files without invoking a document operation", async () => {
  const client = {
    sessions: () =>
      Promise.resolve([
        { id: "a", file: "Target" },
        { id: "b", file: "Target" },
      ]),
  };
  await expect(resolveCaptureSession(client, "Missing")).rejects.toThrow("found 0");
  await expect(resolveCaptureSession(client, "Target")).rejects.toThrow("found 2");
  expect(await resolveCaptureSession(client, "Target", "b")).toBe("b");
});
