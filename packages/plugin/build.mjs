// Bundles the plugin: main thread → dist/code.js, UI → inlined into dist/ui.html.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const fingerprint = createHash("sha256");
async function hashSource(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await hashSource(path);
    else
      fingerprint
        .update(path.replaceAll("\\", "/"))
        .update("\0")
        .update(await readFile(path));
  }
}
for (const dir of ["src", "../scene/src", "../protocol/src"]) await hashSource(dir);
const define = {
  __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  __PLUGIN_BUILD__: JSON.stringify(`src-${fingerprint.digest("hex").slice(0, 16)}`),
  __HUB_PORT__: "7331",
};
// Bundle workspace packages from their TypeScript sources (no dependency on their builds).
const common = {
  bundle: true,
  minify: true,
  legalComments: "none",
  define,
  logLevel: "warning",
  conditions: ["@figbridge/source"],
};

await mkdir("dist", { recursive: true });
// The Figma sandbox is ES2017-level; esbuild lowers newer syntax (classes with # fields, ??, ?.).
await build({
  ...common,
  entryPoints: ["src/main/code.ts"],
  outfile: "dist/code.js",
  target: "es2017",
  format: "iife",
});

const ui = await build({
  ...common,
  entryPoints: ["src/ui/main.ts"],
  write: false,
  target: "es2020",
  format: "iife",
});
const script = ui.outputFiles[0].text.replaceAll("</script", "</script");
const html = (await readFile("src/ui/ui.html", "utf8")).replace("/*__UI_SCRIPT__*/", () => script);
await writeFile("dist/ui.html", html);
