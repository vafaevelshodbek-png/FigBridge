// Ships the Figma plugin inside the figbridge package: builds it from source and copies the
// manifest and bundles to dist/plugin/, where `figbridge plugin` points users.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../../plugin/", import.meta.url));
const target = fileURLToPath(new URL("../dist/plugin/", import.meta.url));

execFileSync(process.execPath, ["build.mjs"], { cwd: plugin, stdio: "inherit" });
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(`${plugin}manifest.json`, `${target}manifest.json`);
cpSync(`${plugin}dist`, `${target}dist`, { recursive: true });
