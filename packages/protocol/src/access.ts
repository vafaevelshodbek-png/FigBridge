/**
 * Agent access constants, free of zod so the Figma plugin can import them without bundling
 * the schemas (import from "@figbridge/protocol/access").
 */

/**
 * How much the agent may change in a file, chosen by the user in the plugin window:
 * - `read-only`: reads and exports only;
 * - `ask`: every change waits for the user's approval (the default);
 * - `auto`: changes run; destructive ones (large deletions, replacing frames) are asked;
 * - `unrestricted`: everything runs; resets to `ask` when the plugin reopens.
 */
export const ACCESS_MODES = ["read-only", "ask", "auto", "unrestricted"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && (ACCESS_MODES as readonly string[]).includes(value);
}

/**
 * How long the plugin waits for the user to approve a change before declining it. Callers
 * waiting on a mutating method add this to its timeout, so the decision is not cut short.
 */
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Methods that change the document (kept equal to `mutates` in METHODS by a test). */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "scene.render",
  "nodes.create",
  "node.update",
  "node.delete",
  "node.clone",
]);
