import { SlideSchema } from "@figbridge/scene";
import { expect, it, vi } from "vitest";
import { FontLoader } from "../src/main/render/fonts.js";
import { SceneRenderer } from "../src/main/render/scene-renderer.js";
import { UiBridge } from "../src/main/ui-bridge.js";
import { installFakeFigma } from "./fake-figma.js";

it("yields through a UI message reply without scheduling a timer", async () => {
  const fake = installFakeFigma(),
    bridge = new UiBridge();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = bridge.yieldControl();
    const message = fake.posted.at(-1) as { kind: string; ticket: number };
    expect(message.kind).toBe("yield");
    expect(vi.getTimerCount()).toBe(0);
    expect(bridge.handleReply({ kind: "yield.done", ticket: message.ticket })).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
it("uses the injected cooperative scheduler for long renders", async () => {
  const fake = installFakeFigma(),
    yieldControl = vi.fn(() => Promise.resolve());
  const r = new SceneRenderer({
    fonts: new FontLoader((f) => fake.loadFontAsync(f)),
    images: () => Promise.resolve("unused"),
    warnings: [],
    checkCancelled: () => undefined,
    yieldControl,
  });
  const slide = SlideSchema.parse({
    name: "Long",
    width: 100,
    height: 100,
    children: Array.from({ length: 51 }, (_, i) => ({
      type: "rect",
      id: String(i),
      name: String(i),
      x: 0,
      y: i,
      w: 1,
      h: 1,
    })),
  });
  await r.renderSlide(slide, fake.currentPage as never, 0, 0);
  expect(yieldControl).toHaveBeenCalledTimes(2);
});
