// Type-aware rules only; formatting and basic lint are Biome's job.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.tsbuild/**",
      "**/coverage/**",
      "out/**",
      "eslint.config.js",
      "**/*.config.ts",
      "vitest.project.ts",
      "**/build.mjs",
      "**/scripts/**",
      "packages/figbridge/web/**/*.mjs",
      "packages/figbridge/web/**/*.d.mts",
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
);
