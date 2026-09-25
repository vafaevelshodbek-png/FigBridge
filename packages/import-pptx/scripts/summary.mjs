// Dev helper: import a PPTX (optionally some slides) and print a summary per slide.
// Usage: node scripts/summary.mjs deck.pptx [1,2,3]
import { readFileSync } from "node:fs";
import { importPptx } from "../dist/index.mjs";

const [file, pages] = process.argv.slice(2);
const t0 = Date.now();
const { scene, blobs, warnings } = await importPptx(
  new Uint8Array(readFileSync(file)),
  file,
  pages ? { pages: pages.split(",").map(Number) } : {},
);
const count = (nodes, acc = {}) => {
  for (const n of nodes) {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    if (n.type === "group") count(n.children, acc);
  }
  return acc;
};
for (const s of scene.slides)
  console.log(s.name, `${s.width}x${s.height}`, JSON.stringify(count(s.children)));
console.log("blobs", blobs.size, "ms", Date.now() - t0, "warnings", warnings.slice(0, 8));
