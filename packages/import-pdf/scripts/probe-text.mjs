import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(process.argv[2])),
  verbosity: 0,
}).promise;
const page = await doc.getPage(Number(process.argv[3]));
const ops = await page.getOperatorList();
let n = 0;
for (let i = 0; i < ops.fnArray.length; i++) {
  if (ops.fnArray[i] !== pdfjs.OPS.showText) continue;
  const g = ops.argsArray[i][0].filter((x) => typeof x !== "number");
  const s = g.map((x) => x.unicode).join("");
  if (new RegExp(process.argv[4]).test(s)) {
    console.log(
      i,
      JSON.stringify(s),
      g
        .filter((x) => x.unicode.length !== 1 || x.unicode.charCodeAt(0) > 0x2000)
        .map((x) => [
          x.unicode,
          x.unicode.split("").map((c) => c.charCodeAt(0).toString(16)),
          x.width,
        ]),
    );
    if (++n > 6) break;
  }
}
