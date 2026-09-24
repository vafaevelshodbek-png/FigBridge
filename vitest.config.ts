import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources in tests (see package.json exports).
  resolve: { conditions: ["@figbridge/source"] },
  test: {
    projects: ["packages/*"],
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["packages/*/src/**"] },
    restoreMocks: true,
  },
});
