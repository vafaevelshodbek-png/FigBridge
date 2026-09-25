import { defineProject, type TestProjectInlineConfiguration } from "vitest/config";

const SOURCE = ["@figbridge/source"];

/**
 * Per-package Vitest project. Tests run against sibling packages' TypeScript sources, never
 * their builds: workspace packages are inlined (otherwise Node resolves them to dist/) and
 * resolved with the `@figbridge/source` export condition.
 */
export function workspaceProject(name: string, test: TestProjectInlineConfiguration["test"] = {}) {
  return defineProject({
    resolve: { conditions: SOURCE },
    ssr: { resolve: { conditions: SOURCE } },
    test: {
      name,
      include: ["test/**/*.test.ts"],
      server: { deps: { inline: [/@figbridge\//] } },
      ...test,
    },
  });
}
