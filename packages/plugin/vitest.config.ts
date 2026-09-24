import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@figbridge/source"] },
  test: { name: "plugin", include: ["test/**/*.test.ts"] },
});
