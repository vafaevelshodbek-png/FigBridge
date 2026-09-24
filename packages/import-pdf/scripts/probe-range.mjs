import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const [file, p, from, to] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 })
  .promise;
const page = await doc.getPage(Number(p));
const ops = await page.getOperatorList();
const OPS = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
for (let i = Number(from); i <= Number(to); i++)
  console.log(
    i,
    OPS[ops.fnArray[i]],
    JSON.stringify(ops.argsArray[i], (k, v) =>
      ArrayBuffer.isView(v)
        ? Array.from(v)
            .slice(0, 8)
            .map((n) => +(+n).toFixed(2))
        : v && v.unicode !== undefined
          ? v.unicode
          : v,
    )?.slice(0, 160),
  );
