import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize } from "@figbridge/scene/compare";
import { describe, expect, it } from "vitest";
import { convertMetafiles, findSoffice } from "../src/libreoffice.js";

/** A placeable WMF: a red 100 × 100 rectangle. */
function redSquareWmf(): Uint8Array {
  const words: number[] = [];
  const u16 = (...values: number[]) => words.push(...values.map((v) => v & 0xffff));
  const u32 = (v: number) => u16(v & 0xffff, v >>> 16);
  // Placeable header: key, hmf, bbox, units per inch, reserved, checksum.
  const header = [0xcdd7, 0x9ac6, 0, 0, 0, 100, 100, 96, 0, 0];
  u16(
    ...header,
    header.reduce((a, b) => a ^ b, 0),
  );
  const records: number[][] = [
    [0x020b, 0, 0], // SetWindowOrg
    [0x020c, 100, 100], // SetWindowExt
    [0x02fc, 0, 0x00ff, 0x0000, 0], // CreateBrushIndirect: solid, RGB(255,0,0)
    [0x012d, 0], // SelectObject 0
    [0x041b, 100, 100, 0, 0], // Rectangle
  ];
  const body = records.reduce((n, r) => n + 3 + r.length - 1, 0) + 3;
  u16(1, 9, 0x0300);
  u32(9 + body);
  u16(1);
  u32(8);
  u16(0);
  for (const [fn, ...params] of records) {
    u32(3 + params.length);
    u16(fn ?? 0, ...params);
  }
  u32(3);
  u16(0);
  const out = new Uint8Array(words.length * 2);
  words.forEach((w, i) => {
    out[i * 2] = w & 0xff;
    out[i * 2 + 1] = w >>> 8;
  });
  return out;
}

const soffice = findSoffice();

describe("LibreOffice metafile conversion", () => {
  it("finds soffice through $SOFFICE first", () => {
    const fake = join(tmpdir(), "figbridge-fake-soffice");
    writeFileSync(fake, "");
    expect(findSoffice({ SOFFICE: fake, PATH: "" })).toBe(fake);
  });

  it("returns nothing, without throwing, when LibreOffice fails", async () => {
    const out = await convertMetafiles(process.execPath, [
      { part: "ppt/media/image1.wmf", format: "WMF", bytes: redSquareWmf() },
    ]);
    expect(out.size).toBe(0);
  });

  it.skipIf(soffice === undefined)(
    "converts a WMF to PNG in one run",
    async () => {
      const out = await convertMetafiles(soffice ?? "", [
        { part: "ppt/media/image1.wmf", format: "WMF", bytes: redSquareWmf() },
      ]);
      const png = out.get("ppt/media/image1.wmf");
      expect(png).toBeDefined();
      const size = await imageSize(png ?? new Uint8Array());
      expect(size.width).toBeGreaterThan(10);
    },
    60_000,
  );
});
