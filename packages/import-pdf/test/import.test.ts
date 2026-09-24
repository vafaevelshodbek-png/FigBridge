import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type SceneNode, SceneSchema } from "@figbridge/scene";
import { describe, expect, it } from "vitest";
import { importPdf } from "../src/index.js";

const corpus = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../corpus/${name}`, import.meta.url))));

function flatten(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((n) => (n.type === "group" ? [n, ...flatten(n.children)] : [n]));
}

describe("importPdf", () => {
  it("produces a valid scene with editable text and vectors (beamer)", async () => {
    const { scene, blobs, warnings } = await importPdf(
      corpus("beamer_metropolis_demo.pdf"),
      "demo.pdf",
      { pages: [1, 3] },
    );
    expect(() => SceneSchema.parse(scene)).not.toThrow();
    expect(warnings).toEqual([]);
    expect(blobs.size).toBe(0);
    const [title] = scene.slides;
    expect(title?.width).toBe(1920);
    const texts = flatten(title?.children ?? []).flatMap((n) =>
      n.type === "text" ? [n.characters] : [],
    );
    expect(texts).toContain("A modern beamer theme");
  });

  it("extracts photos as image layers referencing returned blobs (NASA)", async () => {
    const { scene, blobs } = await importPdf(corpus("nasa_aiaa_template_2014.pdf"), "nasa.pdf", {
      pages: [1],
    });
    const refs = flatten(scene.slides[0]?.children ?? []).flatMap((n) =>
      n.type === "image" ? [n.image.blob] : [],
    );
    for (const ref of refs) expect(blobs.has(ref)).toBe(true);
    for (const blob of blobs.values())
      expect([...blob.bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  });

  it("is deterministic", async () => {
    const a = await importPdf(corpus("beamer_metropolis_demo.pdf"), "d.pdf", { pages: [2] });
    const b = await importPdf(corpus("beamer_metropolis_demo.pdf"), "d.pdf", { pages: [2] });
    expect(JSON.stringify(a.scene)).toBe(JSON.stringify(b.scene));
  });

  it("rejects pages that do not exist", async () => {
    await expect(
      importPdf(corpus("beamer_metropolis_demo.pdf"), "d.pdf", { pages: [999] }),
    ).rejects.toThrow(RangeError);
  });
});
