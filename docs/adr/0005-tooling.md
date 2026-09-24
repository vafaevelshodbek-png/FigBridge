# 0005. Tooling and engineering conventions

- Status: accepted
- Date: 2026-09-24

## Decision

| Area | Choice |
|---|---|
| Workspace | pnpm workspaces, catalogs; TS project references |
| TypeScript | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax, NodeNext, ESM only |
| Build | tsdown for packages and CLI; esbuild for the plugin |
| Lint/format | Biome; typescript-eslint strictTypeChecked for type-aware rules |
| Tests | Vitest (projects, coverage-v8); golden snapshots; property tests with fast-check where invariants exist |
| Validation | zod v4 (single source of truth for protocol and Scene) |
| Logging | pino to stderr |
| CLI | commander |
| Release | Changesets, npm trusted publishing with provenance |
| Node | engines >= 22; CI on 22 and 24 |
| CI | GitHub Actions on ubuntu/macos/windows, SHA-pinned actions, license check; visual tests on Linux with pinned fonts |
| Commits | Conventional Commits |
| Docs | README, ARCHITECTURE, protocol spec, MADR ADRs, CONTRIBUTING, SECURITY, Code of Conduct |

Conventions: one concept per module (~300 lines soft cap); pure core, I/O at the edges; TSDoc on every export; one `BridgeError` with a closed `code` union — never throw strings; discriminated unions with exhaustive switches; named constants for every heuristic threshold with the evidence in a comment.
