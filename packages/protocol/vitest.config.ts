import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@figbridge/source"] },
  test: { name: "protocol", include: ["test/**/*.test.ts"] },
});
