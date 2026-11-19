# Contributing

Thanks for helping! A few conventions keep the codebase easy to review.

## Setup

```bash
pnpm install
pnpm build
pnpm check        # typecheck + Biome + typescript-eslint (strictTypeChecked) + Vitest
```

To try the plugin: Figma Desktop → *Plugins → Development → Import plugin from manifest…* → `packages/plugin/manifest.json`, then `node packages/figbridge/dist/cli.mjs start`.

## Layout

| Package | Purpose |
|---|---|
| `protocol` | wire envelope, method catalog, error codes |
| `scene` | Scene IR (editable layer tree) + reference rasterizer |
| `import-pdf` | PDF → Scene |
| `plugin` | Figma plugin (UI transport + Scene renderer) |
| `figbridge` | hub, MCP server, CLI |

## Conventions

- TypeScript strict; no `any`, no non-null assertions, exhaustive switches.
- Throw `BridgeError` with a code — never strings.
- Heuristic thresholds are named constants with a comment explaining the evidence.
- Every importer change needs a test; for visual changes attach before/after from `packages/import-pdf/scripts/corpus-sheet.mjs`.
- Protocol or Scene schema changes need an ADR in `docs/adr/`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Test documents

Only permissively licensed documents go into `corpus/` (see its README).

## Changes and releases

A pull request that changes what users get (CLI, MCP tools, plugin, import results) adds a
changeset: `pnpm changeset`, pick `figbridge`, choose patch / minor / major and write a sentence
for the changelog. See `.changeset/README.md`.

The release publishes the `figbridge` package. The private `@figbridge/*` packages are bundled into it.
With an `NPM_TOKEN` secret and permission for GitHub Actions to create pull requests, the release
workflow opens a version PR for pending changesets. Merging that PR publishes to npm with provenance.

Before a release, `pnpm build && pnpm -F figbridge smoke` installs the packed package into an
empty directory with plain npm and checks the CLI, the bundled plugin and the MCP server — CI
runs it on every push.
