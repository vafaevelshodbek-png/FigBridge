import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@figbridge/source"] },
  test: { name: "scene", include: ["test/**/*.test.ts"] },
});
