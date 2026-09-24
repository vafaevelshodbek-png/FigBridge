import { readFileSync } from "node:fs";
import { importPdf } from "../dist/index.mjs";

const file = process.argv[2],
  pageNo = Number(process.argv[3]);
const [x0, y0, x1, y1] = process.argv[4].split(",").map(Number);
const { scene } = await importPdf(new Uint8Array(readFileSync(file)), file, { pages: [pageNo] });
let i = 0;
const walk = (nodes, depth) => {
  for (const n of nodes) {
    i++;
    if (n.type === "group") {
      console.log(" ".repeat(depth) + "group", n.name);
      walk(n.children, depth + 1);
      continue;
    }
    const hit = n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0;
    if (hit)
      console.log(
        " ".repeat(depth) + i,
        n.type,
        n.name,
        Math.round(n.x),
        Math.round(n.y),
        Math.round(n.w),
        Math.round(n.h),
        n.type === "vector"
          ? JSON.stringify(n.fills)
          : n.type === "rect"
            ? JSON.stringify(n.fills).slice(0, 60)
            : "",
      );
  }
};
walk(scene.slides[0].children, 0);
