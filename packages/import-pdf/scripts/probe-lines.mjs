import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdf } from "../dist/index.mjs";

const file = process.argv[2],
  pageNo = Number(process.argv[3]);
const { scene } = await importPdf(new Uint8Array(readFileSync(file)), file, { pages: [pageNo] });
const walk = (nodes, out = []) => {
  for (const n of nodes) {
    if (n.type === "group") walk(n.children, out);
    else out.push(n);
  }
  return out;
};
for (const n of walk(scene.slides[0].children))
  if (n.type === "vector")
    console.log(
      n.name,
      Math.round(n.x),
      Math.round(n.y),
      Math.round(n.w),
      Math.round(n.h),
      JSON.stringify(n.strokes).slice(0, 120),
      n.paths[0].d.slice(0, 60),
    );
