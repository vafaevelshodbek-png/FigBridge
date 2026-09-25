/**
 * Builds small, valid PDF files in memory, so a test can state the drawing operators it is
 * about. Objects are written in order with a correct cross-reference table; streams are
 * uncompressed, which keeps a failing test's input readable.
 */

export interface PageSpec {
  /** The page's content stream (PDF operators). */
  content: string;
  /** Extra entries of the page's /Resources dictionary, e.g. `/ExtGState << /G1 5 0 R >>`. */
  resources?: string;
  width?: number;
  height?: number;
}

/** An extra indirect object: a dictionary, or a stream with its dictionary. */
export type PdfObject = string | { dict: string; stream: string | Uint8Array };

/**
 * Objects 1–3 are the catalog, the page tree and a Helvetica font (`/F1`). Extra objects
 * get numbers from 4 on, in order; pages and their contents follow them.
 */
export function buildPdf(pages: PageSpec[], extra: PdfObject[] = []): Uint8Array {
  const objects: (string | Uint8Array)[] = [];
  const first = 4;
  const pageIds = pages.map((_, i) => first + extra.length + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
  );
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  for (const object of extra)
    objects.push(typeof object === "string" ? object : stream(object.dict, object.stream));
  pages.forEach((page, i) => {
    const contentId = (pageIds[i] ?? 0) + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(page.width ?? 400)} ${String(page.height ?? 300)}] ` +
        `/Resources << /Font << /F1 3 0 R >> ${page.resources ?? ""} >> /Contents ${String(contentId)} 0 R >>`,
    );
    objects.push(stream("<<>>", page.content));
  });

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.7\n%âãÏÓ\n")];
  let length = chunks[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(length);
    const head = encoder.encode(`${String(i + 1)} 0 obj\n`);
    const body = typeof object === "string" ? encoder.encode(object) : object;
    const tail = encoder.encode("\nendobj\n");
    chunks.push(head, body, tail);
    length += head.length + body.length + tail.length;
  });
  const xref =
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`;
  chunks.push(encoder.encode(xref));
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function stream(dict: string, data: string | Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const head = encoder.encode(
    `${dict.replace(/>>\s*$/, "")} /Length ${String(bytes.length)} >>\nstream\n`,
  );
  const tail = encoder.encode("\nendstream");
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}
