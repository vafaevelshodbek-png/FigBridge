import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "plugin", include: ["test/**/*.test.ts"] } });
