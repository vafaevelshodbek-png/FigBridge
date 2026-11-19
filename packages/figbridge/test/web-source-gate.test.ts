import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importCapture } from "../web/import-capture.mjs";

it.each([
  { warnings: ["clip-path: unsupported polygon"] },
  { preparation: { warnings: ["fonts: timed out"] } },
])("refuses source losses before opening a target or fetching assets", async (loss) => {
  const dir = await mkdtemp(join(tmpdir(), "figbridge-source-gate-"));
  const path = join(dir, "capture.json");
  await writeFile(
    path,
    JSON.stringify({
      ...loss,
      slide: {
        name: "Lossy",
        width: 100,
        height: 100,
        children: [
          {
            type: "image",
            id: "img",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            url: "http://127.0.0.1:9/private",
          },
        ],
      },
    }),
  );
  await expect(
    importCapture(path, { file: "Test file that is never opened", strict: true }),
  ).rejects.toThrow(/Source capture.*(clip-path|fonts)/);
});
