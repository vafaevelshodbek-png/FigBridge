/**
 * TIFF pictures → PNG. Figma (and the browser canvas the plugin could use) cannot read TIFF,
 * so the importer decodes it here, in plain JavaScript, and writes an RGBA PNG.
 */
import { zlibSync } from "fflate";
import UTIF from "utif";

export interface Converted {
  png: Uint8Array;
  /** More than one page: only the first is kept. */
  pages: number;
}

/** Decode the first page of a TIFF into a PNG; undefined when the file cannot be decoded. */
export function tiffToPng(bytes: Uint8Array): Converted | undefined {
  try {
    const ifds = UTIF.decode(bytes);
    const first = ifds[0];
    if (first === undefined) return undefined;
    UTIF.decodeImage(bytes, first, ifds);
    const { width, height } = first;
    if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
    return { png: encodePng(UTIF.toRGBA8(first), width, height), pages: ifds.length };
  } catch {
    return undefined;
  }
}

/** A minimal PNG writer: 8-bit RGBA, no filtering, one IDAT chunk. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // bit depth 8, colour type RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
