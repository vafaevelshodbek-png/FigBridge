import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(process.argv[2])),
  verbosity: 0,
}).promise;
const page = await doc.getPage(Number(process.argv[3]));
const ops = await page.getOperatorList();
const OPS = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
// print the op stream structure (skip text details), compact
const depth = 0;
const lines = [];
for (let i = 0; i < ops.fnArray.length; i++) {
  const n = OPS[ops.fnArray[i]];
  const a = ops.argsArray[i];
  if (
    [
      "showText",
      "setCharSpacing",
      "setWordSpacing",
      "moveText",
      "setTextMatrix",
      "setFont",
      "dependency",
      "beginText",
      "endText",
      "setLeading",
    ].includes(n)
  )
    continue;
  let info = "";
  if (n === "setGState") info = JSON.stringify(a[0]);
  if (n === "beginGroup")
    info = JSON.stringify({ smask: a[0].smask, isolated: a[0].isolated, knockout: a[0].knockout });
  if (n === "constructPath") info = String(OPS[a[0]]);
  if (n === "transform") info = JSON.stringify(a.map((x) => +(+x).toFixed(2)));
  if (n === "setFillRGBColor") info = a[0];
  if (n === "paintImageXObject") info = a[0];
  lines.push(`${i} ${n} ${info}`);
}
console.log(lines.slice(Number(process.argv[4] ?? 0), Number(process.argv[5] ?? 80)).join("\n"));
