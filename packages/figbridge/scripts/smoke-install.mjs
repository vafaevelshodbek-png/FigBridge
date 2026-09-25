// Installs figbridge the way a user would — `npm pack`, then `npm install <tarball>` in an
// empty directory, no workspace — and checks the installed package works: the CLI runs, the
// bundled plugin is there, the library imports, and `figbridge mcp` serves its tools over
// stdio to a real MCP client. Run after `pnpm build`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "figbridge-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// pnpm, not npm, packs: only pnpm rewrites catalog: and workspace: versions (as it will when
// publishing); the install then uses plain npm, like a user.
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd shims need a shell on Windows; node itself must not go through one (spaces in its path).
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", shell: cmd.endsWith(".cmd") });

function check(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
  process.stdout.write(`ok  ${message}\n`);
}

try {
  const tarball = run(pnpm, ["pack", "--pack-destination", dir], pkg).trim().split("\n").pop();
  check(tarball?.endsWith(".tgz"), `packed ${tarball}`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }),
  );
  run(
    npm,
    ["install", "--no-audit", "--no-fund", tarball.includes(dir) ? tarball : join(dir, tarball)],
    dir,
  );

  const installed = join(dir, "node_modules", "figbridge");
  const cli = join(installed, "dist", "cli.mjs");
  const version = run(process.execPath, [cli, "--version"], dir).trim();
  check(/^\d+\.\d+\.\d+/.test(version), `figbridge --version → ${version}`);

  const manifest = run(process.execPath, [cli, "plugin"], dir).trim();
  check(existsSync(manifest), "figbridge plugin → manifest exists");
  check(
    existsSync(join(installed, "dist", "plugin", "dist", "code.js")),
    "plugin bundle is shipped",
  );
  check(existsSync(join(installed, "README.md")), "README is shipped");
  check(
    !readdirSync(join(dir, "node_modules")).includes("@figbridge"),
    "no private workspace packages leaked",
  );

  writeFileSync(
    join(dir, "api.mjs"),
    `import { VERSION, TOOLS } from "figbridge"; process.stdout.write(JSON.stringify([VERSION, TOOLS.length]));`,
  );
  const api = run(process.execPath, ["api.mjs"], dir).trim();
  check(api === JSON.stringify([version, 13]), `library import → ${api}`);

  // A private state dir and port, so a hub the developer is running is not touched.
  const env = {
    ...process.env,
    FIGBRIDGE_HOME: join(dir, "state"),
    FIGBRIDGE_PORT: "47331",
    FIGBRIDGE_LOG: "silent",
  };
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd: dir }),
  );
  const { tools } = await client.listTools();
  check(
    tools.length === 13 && tools.every((t) => t.name.startsWith("figma_")),
    `figbridge mcp serves ${tools.length} tools`,
  );
  const noSession = await client.callTool({ name: "figma_file_info", arguments: {} });
  check(
    noSession.isError === true && /NO_SESSION/.test(noSession.content[0]?.text ?? ""),
    "tools answer with actionable errors",
  );
  await client.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
