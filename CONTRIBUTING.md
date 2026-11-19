# Contributing

Use Node.js 22+ and the pnpm version pinned in `package.json`. Start with the package map. [Architecture](docs/ARCHITECTURE.md)

## Verify a change

```sh
pnpm install --frozen-lockfile
pnpm --filter figbridge exec playwright install chromium
pnpm build
pnpm check
pnpm --filter figbridge test:browser
pnpm --filter figbridge smoke
```

| Check | What it exercises |
| --- | --- |
| `pnpm check` | TypeScript, lint, unit tests, golden render comparisons and integration tests |
| `pnpm test:coverage` | Vitest suite with the coverage thresholds used in CI |
| `pnpm --filter figbridge test:browser` | Chromium regressions for browser capture, layout and state exploration |
| `pnpm --filter figbridge smoke` | Tarball installation with npm, the bundled plugin and the CLI and MCP entry points |

On Linux, pass `--with-deps` to Playwright's install command to install the browser's system dependencies. For an import through the actual Figma Plugin API, use a test file and follow the setup guide. [First import](docs/first-import-check.md)

## Make a focused change

- Keep parser and renderer changes in their owning packages. Reuse the Scene schema and wire method catalog at package boundaries.
- Cover importer behavior with a regression fixture or a checked before-and-after render. Keep only redistributable documents in the corpus. [Corpus and licenses](corpus/README.md)
- After an intended visual change, run `UPDATE_GOLDEN=1 pnpm vitest run --project figbridge golden` in a POSIX shell and review the changed images in `corpus/golden/`. In PowerShell, set `$env:UPDATE_GOLDEN = '1'` before running `pnpm vitest run --project figbridge golden`.
- Add a changeset with `pnpm changeset` for user-facing changes. Record changes to shared contracts in an architecture decision record. [Existing decisions](docs/adr)

## Release

The release publishes the `figbridge` package. The private `@figbridge/*` packages are bundled into it.
With an `NPM_TOKEN` secret and permission for GitHub Actions to create pull requests, the release
workflow opens a version PR for pending changesets. Merging that PR publishes to npm with provenance.
