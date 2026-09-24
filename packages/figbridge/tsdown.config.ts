import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  // Workspace packages are private; bundle them so `figbridge` installs as one package.
  noExternal: [/^@figbridge\//],
});
