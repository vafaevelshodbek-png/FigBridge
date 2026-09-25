import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@figbridge/source"] },
  test: { name: "import-pptx", include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
