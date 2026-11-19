import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { compareImages } from "../src/compare.js";

it("can include alpha without changing the existing RGB default", async () => {
  const opaque = createCanvas(2, 2);
  opaque.getContext("2d").fillRect(0, 0, 2, 2);
  const transparent = createCanvas(2, 2);
  const expected = opaque.toBuffer("image/png"),
    actual = transparent.toBuffer("image/png");
  expect((await compareImages(expected, actual)).ratio).toBe(0);
  expect((await compareImages(expected, actual, { includeAlpha: true })).ratio).toBe(1);
});
