import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../../../.changeset");

describe("changesets", () => {
  // Only the published package can be bumped; changesets refuses to version private ones
  // mixed with it, and the release job fails on main.
  it("bump only the published figbridge package", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md")) {
      const front = readFileSync(join(DIR, file), "utf8").split("---")[1] ?? "";
      const packages = [...front.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
      expect(packages, file).toEqual(["figbridge"]);
    }
  });
});
