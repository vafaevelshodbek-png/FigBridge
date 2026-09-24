/**
 * Request admission rules for the local hub.
 *
 * The hub listens on loopback only, but a browser on the same machine can still reach it.
 * Three checks close that gap:
 *  1. Host header must be a loopback name — defeats DNS rebinding.
 *  2. Origin must be absent (CLI, other local processes) or "null" (the Figma plugin iframe).
 *     Web pages send their real origin and are rejected.
 *  3. A pairing token — because "null" can be forged by a sandboxed iframe on a hostile page.
 */
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when `host` (as sent in the Host header) points at this machine on `port`. */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const separator = host.lastIndexOf(":");
  if (separator <= 0) return false;
  const name = host.slice(0, separator).toLowerCase();
  return LOOPBACK_HOSTNAMES.has(name) && host.slice(separator + 1) === String(port);
}

/** Origins allowed to talk to the hub: none (non-browser clients) or the plugin's opaque origin. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "null";
}

/** Constant-time token comparison (does not leak the matching prefix length through timing). */
export function tokensEqual(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
