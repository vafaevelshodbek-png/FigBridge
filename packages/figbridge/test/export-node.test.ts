import { imageSize } from "@figbridge/scene/compare";
import { describe, expect, it } from "vitest";
import type { HubClient } from "../src/client.js";
import { exportNode, rasterizeSvg } from "../src/export-node.js";

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#ff0000"/></svg>',
);

/** A client whose plugin answers node.export with the given bytes and MIME type. */
function clientReturning(bytes: Uint8Array, mimeType: string): HubClient {
  return {
    call: () => Promise.resolve({ blob: "img:x", mimeType, width: 200, height: 100 }),
    getBlob: () => Promise.resolve({ bytes, mimeType }),
  } as unknown as HubClient;
}

describe("exportNode", () => {
  it("rasterizes the SVG the plugin sends when Figma's raster export was stuck", async () => {
    const out = await exportNode(clientReturning(SVG, "image/svg+xml"), {
      nodeId: "1:2",
      format: "png",
      scale: 2,
    });
    expect(out.mimeType).toBe("image/png");
    expect(await imageSize(out.bytes)).toEqual({ width: 200, height: 100 });
  });

  it("passes a real raster export and an asked-for SVG through unchanged", async () => {
    const png = await rasterizeSvg(SVG, "png", { width: 10, height: 5 });
    const raster = await exportNode(clientReturning(png.bytes, "image/png"), {
      nodeId: "1:2",
      format: "png",
      scale: 1,
    });
    expect(raster.bytes).toBe(png.bytes);
    const svg = await exportNode(clientReturning(SVG, "image/svg+xml"), {
      nodeId: "1:2",
      format: "svg",
      scale: 1,
    });
    expect(svg).toMatchObject({ bytes: SVG, mimeType: "image/svg+xml" });
  });

  it("puts JPEG on white and keeps the size", async () => {
    const jpg = await rasterizeSvg(SVG, "jpg", { width: 40, height: 20 });
    expect(jpg.mimeType).toBe("image/jpeg");
    expect([jpg.bytes[0], jpg.bytes[1]]).toEqual([0xff, 0xd8]);
  });
});
