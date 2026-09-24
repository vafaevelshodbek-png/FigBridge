import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@figbridge/source"] },
  test: { name: "figbridge", include: ["test/**/*.test.ts"] },
});
