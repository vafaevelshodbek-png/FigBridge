/**
 * `figbridge doctor`: checks the things that usually stand between a user and a working
 * setup, in the order they depend on each other, and says what to do about each failure.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "./hub/hub.js";
import { SERVICE_NAME } from "./hub/server.js";
import { VERSION } from "./version.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when the check fails. */
  fix?: string;
}

export interface DoctorOptions {
  port: number;
  stateDir: string;
  /** Reads the pairing token; throws when it cannot be read or created. */
  token: () => string;
  nodeVersion?: string;
  /** Path of the bundled plugin manifest (undefined: look next to this build). */
  manifest?: string;
  fetch?: typeof globalThis.fetch;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const fetch = options.fetch ?? globalThis.fetch;
  const base = `http://127.0.0.1:${String(options.port)}`;

  const node = options.nodeVersion ?? process.versions.node;
  const major = Number(node.split(".")[0]);
  checks.push({
    name: "Node.js",
    ok: major >= MIN_NODE_MAJOR,
    detail: `v${node}`,
    fix: `Install Node.js ${String(MIN_NODE_MAJOR)} or newer.`,
  });

  let token: string | undefined;
  try {
    token = options.token();
    checks.push({ name: "Pairing token", ok: true, detail: join(options.stateDir, "token") });
  } catch (error) {
    checks.push({
      name: "Pairing token",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: `Make ${options.stateDir} writable, or set FIGBRIDGE_HOME to a folder you own.`,
    });
  }

  const manifest =
    options.manifest ?? fileURLToPath(new URL("./plugin/manifest.json", import.meta.url));
  checks.push({
    name: "Figma plugin",
    ok: existsSync(manifest),
    detail: manifest,
    fix: "Reinstall figbridge; from a source checkout run `pnpm build`.",
  });

  let health: { service?: string; version?: string } | undefined;
  try {
    const response = await fetch(`${base}/health`);
    health = (await response.json()) as { service?: string; version?: string };
  } catch {
    health = undefined;
  }
  if (health === undefined) {
    checks.push({
      name: "Hub",
      ok: false,
      detail: `nothing answers on 127.0.0.1:${String(options.port)}`,
      fix: "Start it with `figbridge start`, or let your AI client start `figbridge mcp`.",
    });
    return checks;
  }
  if (health.service !== SERVICE_NAME) {
    checks.push({
      name: "Hub",
      ok: false,
      detail: `port ${String(options.port)} is taken by another program`,
      fix: "Stop that program, or run figbridge on another port with FIGBRIDGE_PORT.",
    });
    return checks;
  }
  checks.push({
    name: "Hub",
    ok: health.version === VERSION,
    detail: `figbridge ${health.version ?? "?"} on 127.0.0.1:${String(options.port)}`,
    fix: `This CLI is ${VERSION}: restart the hub so both are the same version.`,
  });

  if (token === undefined) return checks;
  const response = await fetch(`${base}/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    checks.push({
      name: "Token matches the hub",
      ok: false,
      detail: "the running hub uses a different token",
      fix: "The hub was started with another FIGBRIDGE_HOME: restart it from this shell.",
    });
    return checks;
  }
  const { sessions } = (await response.json()) as { sessions: SessionSummary[] };
  checks.push({ name: "Token matches the hub", ok: true, detail: "yes" });
  checks.push({
    name: "Figma files connected",
    ok: sessions.length > 0,
    detail:
      sessions.length === 0
        ? "none"
        : sessions.map((s) => `${s.file} (plugin ${s.pluginVersion})`).join(", "),
    fix: "Open the figbridge plugin in Figma Desktop (Plugins → Development → figbridge); if it asks for a token, run `figbridge pair`.",
  });
  return checks;
}

/** Plain-text report; one line per check, the fix under each failure. */
export function formatChecks(checks: readonly Check[]): string {
  return checks
    .map(
      (c) =>
        `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.ok || c.fix === undefined ? "" : `\n    → ${c.fix}`}`,
    )
    .join("\n");
}
