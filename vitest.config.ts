import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each package is a project; source resolution lives in vitest.project.ts.
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["packages/*/src/**"],
      // A floor, not a goal: raise it when coverage grows, never lower it to merge.
      thresholds: { lines: 85, statements: 82, branches: 70, functions: 80 },
    },
    restoreMocks: true,
  },
});
