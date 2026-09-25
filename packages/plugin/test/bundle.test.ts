/**
 * Checks on what Figma actually loads: the manifest and the built bundles. Each rule here
 * comes from a failure in real Figma that unit tests of the sources could not see.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(root("manifest.json"), "utf8")) as {
  main: string;
  ui: string;
  networkAccess: { allowedDomains: string[]; devAllowedDomains?: string[]; reasoning?: string };
};

describe("manifest", () => {
  const domains = [
    ...manifest.networkAccess.allowedDomains,
    ...(manifest.networkAccess.devAllowedDomains ?? []),
  ];

  it("names hosts, never IP addresses (Figma: 'must be a valid URL')", () => {
    for (const domain of domains)
      expect(domain).not.toMatch(/\/\/\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]/i);
  });

  it("only reaches the local hub, over http and ws", () => {
    for (const domain of domains) expect(domain).toMatch(/^(http|ws):\/\/localhost:\d+$/);
    expect(manifest.networkAccess.reasoning).toBeTruthy();
  });
});

// Needs `pnpm build`: skipped locally before a build, mandatory in CI.
const built = existsSync(root(manifest.ui)) && existsSync(root(manifest.main));
describe.skipIf(!built && process.env["CI"] === undefined)("built bundles", () => {
  const ui = () => readFileSync(root(manifest.ui), "utf8");
  const main = () => readFileSync(root(manifest.main), "utf8");

  it("the UI uses no secure-context-only APIs (it runs from a data: URL)", () => {
    // crypto.randomUUID left the plugin window blank in real Figma.
    for (const api of [
      "crypto.randomUUID",
      "crypto.subtle",
      "navigator.clipboard",
      "navigator.serviceWorker",
    ]) {
      expect(ui()).not.toContain(api);
    }
  });

  it("the UI installs its error display before the bundle runs", () => {
    const html = ui();
    const handler = html.indexOf('addEventListener("error"');
    const bundle = html.indexOf('"use strict"');
    expect(handler).toBeGreaterThan(0);
    expect(handler).toBeLessThan(bundle);
  });

  it("the UI is a single self-contained page", () => {
    expect(ui()).not.toMatch(/<script[^>]+src=|<link[^>]+href=/i);
    expect(ui().match(/<script>/g)).toHaveLength(1);
  });

  it("the main thread bundles no schemas or Node modules (the sandbox has neither)", () => {
    expect(main()).not.toMatch(/node:crypto|ZodError|\$ZodType/);
    // A regression that pulls zod and the schemas in shows up as a jump in size.
    expect(main().length).toBeLessThan(60_000);
  });

  it("the main thread touches no browser globals (the sandbox has none)", () => {
    // A global reference, not a substring of a string such as the "document.outline" method.
    expect(main()).not.toMatch(/(?<![\w$."'])(document|window|localStorage|crypto)\b(?!["'])/);
  });
});
