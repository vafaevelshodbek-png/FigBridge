// Bundles the plugin: main thread → dist/code.js, UI → inlined into dist/ui.html.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const define = { __PLUGIN_VERSION__: JSON.stringify(pkg.version), __HUB_PORT__: "7331" };
const common = { bundle: true, minify: true, legalComments: "none", define, logLevel: "warning" };

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
