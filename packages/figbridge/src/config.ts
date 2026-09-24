/**
 * Runtime configuration: port, per-user state directory and the pairing token.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default hub port. Chosen outside common dev-server ranges (3000, 5173, 8080…). */
export const DEFAULT_PORT = 7331;

/** Per-user state directory: `$FIGBRIDGE_HOME`, else `~/.figbridge`. */
export function stateDir(): string {
  const dir = process.env["FIGBRIDGE_HOME"] ?? join(homedir(), ".figbridge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Hub port: `$FIGBRIDGE_PORT` or {@link DEFAULT_PORT}. */
export function hubPort(): number {
  const raw = process.env["FIGBRIDGE_PORT"];
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`FIGBRIDGE_PORT must be an integer in 1024..65535, got "${raw}"`);
  }
  return port;
}

/**
 * The pairing token, created on first use and stored readable by the current user only.
 * The plugin shows a short code derived from it; the CLI and MCP processes read the file.
 */
export function loadOrCreateToken(dir: string = stateDir()): string {
  const file = join(dir, "token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(token)) return token;
  }
  const token = randomBytes(16).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // mode is ignored when the file already existed
  return token;
}

/** Short human-comparable code shown in the plugin UI during pairing. */
export function pairingCode(token: string): string {
  return token.slice(0, 6).toUpperCase();
}
