// Dev helper: import pages of a PDF and print a compact summary of the Scene.
import { readFileSync, writeFileSync } from "node:fs";
import { importPdf } from "../dist/index.mjs";

const [file, pages = "1"] = process.argv.slice(2);
const t0 = Date.now();
const { scene, blobs, warnings } = await importPdf(new Uint8Array(readFileSync(file)), file, {
  pages: pages.split(",").map(Number),
});
const count = (nodes, acc = {}) => {
  for (const n of nodes) {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    if (n.type === "group") count(n.children, acc);
  }
  return acc;
};
for (const slide of scene.slides) {
  console.log(
    slide.name,
    slide.width + "x" + slide.height,
    slide.background[0]?.color,
    JSON.stringify(count(slide.children)),
  );
}
console.log(
  "blobs",
  blobs.size,
  "bytes",
  [...blobs.values()].reduce((s, b) => s + b.bytes.length, 0),
  "warnings",
  warnings,
  "ms",
  Date.now() - t0,
);
writeFileSync("C:/dev/tmp-scene.json", JSON.stringify(scene, null, 1));
