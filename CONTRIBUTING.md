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
