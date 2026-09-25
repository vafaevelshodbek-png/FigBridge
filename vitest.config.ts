import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each package is a project; source resolution lives in vitest.project.ts.
  test: {
    projects: ["packages/*"],
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["packages/*/src/**"] },
    restoreMocks: true,
  },
});
