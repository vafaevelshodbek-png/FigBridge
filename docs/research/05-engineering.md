# 05 — Engineering setup (2026 best practice)

Scope: TypeScript monorepo (local Node server, MCP server, CLI, Figma plugin) and a Python package (pptx/PDF to Figma layer-tree converter with golden tests). Primary dev machine is Windows 11. Everything must also work on macOS and Linux.

Rule of thumb: choose boring, widely adopted defaults. Add a new tool only when it removes a whole class of bugs or a whole config file.

---

## 1. TypeScript side

### 1.1 Monorepo: pnpm workspaces, no Turborepo at first
- **pnpm workspaces** are the default for serious OSS TS monorepos (Vite, Vitest, Vue, tRPC, Nuxt). The strict `node_modules` layout catches phantom dependencies, and `workspace:*` protocol plus `catalog:` ([pnpm catalogs](https://pnpm.io/catalogs)) keep versions in sync across packages. See [pnpm workspaces](https://pnpm.io/workspaces).
- npm workspaces work but hoist everything, which hides missing deps. Bun workspaces are fast, but Bun on Windows is still less mature, and contributors expect Node.
- **Turborepo/Nx: skip for now.** With about 5 packages, `pnpm -r --filter` and TypeScript project references are enough. Add Turborepo later if CI time becomes a problem ([Turborepo docs](https://turbo.build/repo/docs)).
- Pin the package manager with `"packageManager": "pnpm@10.x"` and enable it through Corepack, or use `pnpm/action-setup` in CI.

Layout:
```
figma-bridge/
  packages/
    core/        # shared types, zod schemas, errors (no I/O)
    server/      # local HTTP/WebSocket bridge (Node)
    mcp/         # MCP server (@modelcontextprotocol/sdk)
    cli/         # `figma-bridge` bin
    plugin/      # Figma plugin (code.ts + ui), built with esbuild
  python/        # uv project: figma_bridge_convert
  schema/        # generated JSON Schema (committed, CI checks for drift)
  docs/ adr/ research/
```

### 1.2 tsconfig strictness
Use `strict` plus these extra flags. Their cost is small, and each one prevents real bugs:
- `noUncheckedIndexedAccess`: `arr[i]` has type `T | undefined`. This matters a lot for layer-tree code.
- `exactOptionalPropertyTypes`: separates "missing" from "explicitly undefined". It matches JSON Schema semantics.
- `verbatimModuleSyntax`: forces `import type` and gives predictable ESM output ([TS docs](https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax)).
- `module: "NodeNext"` for Node packages. The Figma plugin is bundled, so it uses `module: "Preserve"` with `moduleResolution: "Bundler"` ([TS modules guide](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)).
- `isolatedDeclarations` is optional. It speeds up .d.ts emit in tsdown, but it adds friction, so leave it off until the API stabilizes.
- ESM only (`"type": "module"`). Node 22+ supports `require(esm)`, so a CJS build is not needed.

### 1.3 Build
- Libraries and CLI: **tsdown** (Rolldown-based, the successor to tsup; tsup is effectively unmaintained). tsdown is about 2x faster and up to 8x faster for .d.ts ([tsdown benchmark](https://tsdown.dev/advanced/benchmark), [comparison](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026), [migration notes](https://alan.norbauer.com/articles/tsdown-bundler/)). If tsdown causes trouble, the fallback is plain `tsc -b`, which works for internal packages.
- Figma plugin: **esbuild** directly. The plugin sandbox needs one IIFE `code.js` and an inlined `ui.html`, and esbuild is Figma's documented path. Use a conservative target (ES2017) for the sandbox, and check which syntax and globals it supports against the [Plugin API docs](https://www.figma.com/plugin-docs/) (not verified in this research).
- Type-check separately with `tsc -b --noEmit` (project references) in CI.

### 1.4 Lint and format
Two credible options in 2026:

| Option | Pros | Cons |
|---|---|---|
| **typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` + Prettier** | Deepest type-aware rules (`no-floating-promises`, `no-unsafe-*`, `switch-exhaustiveness-check`). Industry reference ([configs](https://typescript-eslint.io/users/configs/#strict-type-checked)) | Slower. Two tools |
| **Biome 2** | One binary, fast, lint and format together. Has type-aware rules without tsc since v2 ([biomejs.dev](https://biomejs.dev/)) | Narrower type-aware coverage than typescript-eslint |
| oxlint | Very fast | Type-aware rules still maturing. Best as a pre-pass |

**Choice: Biome for formatting and fast lint, plus typescript-eslint `strictTypeChecked` limited to type-aware rules.** In the typescript-eslint config, turn off the rules Biome already covers, or use `eslint-config-biome`. If one tool must be dropped, drop Biome's linter and keep typescript-eslint and Prettier. Type-aware rules matter more than speed for async bridge code, where floating promises are the main bug class.

### 1.5 Tests: Vitest
- Vitest 3 with `projects` (workspace) config for all packages ([vitest.dev](https://vitest.dev/guide/projects)). Use `@vitest/coverage-v8`.
- MCP server: test through the SDK's in-memory transport. Do not spawn processes for unit tests.
- Server: use real sockets on port 0 (ephemeral port), not mocks.

### 1.6 Runtime validation: zod v4
- **zod v4** has first-party `z.toJSONSchema()`, which makes zod the single source of truth for the TS side and the generated schema ([zod JSON Schema](https://zod.dev/json-schema), [v4 release notes](https://zod.dev/v4)). `zod-to-json-schema` is no longer maintained.
- The MCP TypeScript SDK accepts zod schemas for tool inputs natively, which is another reason to choose zod ([MCP TS SDK](https://github.com/modelcontextprotocol/typescript-sdk)).
- Valibot is smaller, which matters for the Figma plugin UI bundle. Use `zod/mini` there if size matters. TypeBox is JSON-Schema-first and fine, but it adds a second idiom.

### 1.7 Logging: pino
- **pino** writes JSON logs to stderr. For MCP stdio transport, stdout is the protocol channel, so any stdout log corrupts it ([MCP transports spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)). Use `pino-pretty` only in dev ([pino](https://github.com/pinojs/pino)).
- Redact tokens with `redact: ['*.token', 'headers.authorization']`.

### 1.8 CLI framework
- **commander** (v14): zero deps, typed via `@commander-js/extra-typings`, the most familiar choice ([commander](https://github.com/tj/commander.js)). citty is lighter and UnJS-style. clipanion is best for large class-based CLIs (Yarn), which is overkill here.
- `package.json`: `"bin": { "figma-bridge": "./dist/cli.js" }`, with `#!/usr/bin/env node` in the entry. `npx figma-bridge@latest ...` then works everywhere. On Windows, npm generates `.cmd` shims automatically.
- Use `node:util.styleText` for colors. It is built in, so chalk is not needed.

### 1.9 Publishing and Node policy
- **Changesets** for versioning and changelogs in a monorepo ([changesets](https://github.com/changesets/changesets)), released by `changesets/action`.
- **npm trusted publishing (OIDC)** from GitHub Actions. There are no long-lived npm tokens, and provenance is attached automatically ([npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [provenance](https://docs.npmjs.com/generating-provenance-statements)).
- Node policy: `"engines": { "node": ">=22" }` (22 is Maintenance LTS and 24 is Active LTS as of late 2026; see [Node release schedule](https://nodejs.org/en/about/previous-releases)). `.nvmrc` = `24`. The CI matrix covers 22 and 24.
- Use `publint` and `@arethetypeswrong/cli` in CI to validate `exports` ([publint](https://publint.dev/)).

---

## 2. Python side

### 2.1 uv, src layout
- **uv** handles everything: Python install, venv, lock, build, and publish ([uv docs](https://docs.astral.sh/uv/)). Commit `uv.lock` and `.python-version`.
- Create the project with `uv init --package` (src layout by default). The build backend is `uv_build` ([uv build backend](https://docs.astral.sh/uv/concepts/build-backend/)), or hatchling if you need plugins.
- `requires-python = ">=3.11"`. python-pptx and pypdfium2/pdfplumber support it, and it gives `Self` and TOML parsing in the stdlib.

### 2.2 Ruff
Ruff handles both lint and format and replaces flake8, isort, black, and pyupgrade ([Ruff rules](https://docs.astral.sh/ruff/rules/)). Start from `select = ["ALL"]` and ignore a small list with reasons, the way admired projects do, or use a curated set (see the config below).

### 2.3 Type checking: pyright strict
- **pyright `strict`** (basedpyright is also fine). It is faster and stricter by default than mypy, and it shares the checker with the VS Code Pylance experience ([pyright config](https://microsoft.github.io/pyright/#/configuration)).
- Astral's `ty` is promising but still beta in 2026. Watch it, but do not gate CI on it ([ty](https://github.com/astral-sh/ty)).
- python-pptx has partial types. Use a local `typings/` stub folder and `reportMissingTypeStubs = false` only for that package.

### 2.4 Tests
- **pytest** with **syrupy** for golden snapshots of the layer-tree JSON ([syrupy](https://github.com/syrupy-project/syrupy)). Use `JSONSnapshotExtension` so goldens are reviewable `.json` files. Update them with `pytest --snapshot-update`.
- Golden inputs: small hand-made pptx/pdf fixtures in `tests/fixtures/`, one feature per file (text runs, groups, rotation, images, tables, gradients). Generate fixtures from a script where possible so they can be reproduced.
- **hypothesis** for invariants such as: coordinates are finite, children stay within parent bounds after the transform, serialize→parse round-trips, and the output validates against the JSON Schema ([hypothesis](https://hypothesis.readthedocs.io/)).
- Normalize floats (round to 2 decimals) before snapshotting, so goldens do not flake across platforms.

### 2.5 Layer-tree model
- **pydantic v2** at the boundary. It validates, serializes (`model_dump(mode="json")`), and can emit JSON Schema. Internally, frozen `@dataclass(slots=True)` also works, but pydantic makes generated models from the shared schema easy.
- The models are generated from `schema/layer-tree.schema.json` with **datamodel-code-generator** (`--output-model-type pydantic_v2.BaseModel`) ([datamodel-code-generator](https://koxudaxi.github.io/datamodel-code-generator/)).

### 2.6 Packaging and versioning
- Build with `uv build` and publish with **PyPI Trusted Publishing** (OIDC) through `pypa/gh-action-pypi-publish`. That action creates PEP 740 attestations by default ([PyPI trusted publishers](https://docs.pypi.org/trusted-publishers/), [uv publish guide](https://docs.astral.sh/uv/guides/package/)).
- SemVer. Keep the version in `pyproject.toml` as a static value that the release workflow bumps (`uv version --bump minor`). Tag it as `py-vX.Y.Z` so it stays separate from the npm tags.

---

## 3. Cross-cutting

### 3.1 Shared schema (TS and Python)
```
packages/core/src/schema/*.ts  (zod v4, source of truth)
      │  pnpm gen:schema  → z.toJSONSchema(..., { target: "draft-2020-12" })
      ▼
schema/layer-tree.schema.json   (committed)
      │  uv run datamodel-codegen
      ▼
python/src/figma_bridge_convert/_generated/models.py  (committed, do not edit)
```
- CI runs both generators and then `git diff --exit-code`. This drift check is the contract.
- Python golden outputs are also validated against the JSON Schema with `jsonschema`, and the TS tests parse the same golden files with zod. This round-trip across languages catches mismatches.
- Put `$id` and version in the schema. Breaking changes bump `schemaVersion`, and that gets an ADR.

### 3.2 CI (GitHub Actions)
- Matrix: `ubuntu-latest`, `macos-latest`, `windows-latest` × Node 22/24 for TS, and × Python 3.11/3.13 for Python. Run expensive jobs (visual tests, coverage) only on Ubuntu.
- Caching: `actions/setup-node` with `cache: pnpm`, and `astral-sh/setup-uv` with `enable-cache: true` ([setup-uv](https://github.com/astral-sh/setup-uv)).
- Pin third-party actions to commit SHA, set `permissions: contents: read` by default, and use `concurrency` to cancel superseded runs. Add a `zizmor` scan for workflow security ([zizmor](https://github.com/zizmorcore/zizmor)). Use Dependabot or Renovate for actions and deps.
- Windows pitfalls: set `core.autocrlf false` and add a `.gitattributes` with `* text=auto eol=lf`. Use `path.join` or `fileURLToPath`, never string paths. Use `shell: bash` in steps.

### 3.3 Git hooks and commits
- **lefthook**: one Go binary with no Python or Node runtime needed for hooks, it runs in parallel, and it works on Windows ([lefthook](https://github.com/evilmartians/lefthook)). pre-commit (the Python framework) is fine for Python-only repos, but this repo spans both languages.
- Hooks: `biome check --write` on staged files, `ruff check --fix` and `ruff format`, and `commitlint` on commit-msg.
- **Conventional Commits** ([spec](https://www.conventionalcommits.org/)) with scopes = package names (`feat(mcp): ...`, `fix(convert): ...`). Changesets still write the user-facing changelog.

### 3.4 Community files
- `LICENSE`: MIT, with `Copyright (c) 2026 <Author One>, <Author Two>` on one line ([choosealicense MIT](https://choosealicense.com/licenses/mit/)). List both people in `package.json` `contributors` and in `pyproject` `authors`.
- `SECURITY.md`: supported versions and GitHub private vulnerability reporting ([GitHub docs](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Threat model note: the local server binds to `127.0.0.1` only, checks Origin, and uses a per-session token.
- `CONTRIBUTING.md`: prerequisites (Node 24, pnpm via Corepack, uv), `pnpm i && uv sync`, commands table, commit convention, how to update goldens.
- `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1 ([contributor-covenant.org](https://www.contributor-covenant.org/)).
- `.github/ISSUE_TEMPLATE/*.yml` issue forms (bug with OS, Figma version, and repro file; feature request), `config.yml` with `blank_issues_enabled: false`, and `PULL_REQUEST_TEMPLATE.md`.

### 3.5 README structure (pattern from uv, Ruff, Vite, tRPC, Playwright)
1. Name, one-line value proposition, badges (CI, npm, PyPI, license). Keep the badges minimal.
2. A GIF or screenshot showing the result (pptx slide, then editable Figma layers).
3. **Highlights**: 4–6 bullets (uv and Ruff style).
4. **Installation / Quick start**: copy-paste `npx figma-bridge ...` and the MCP client config JSON.
5. Usage per surface (CLI, MCP, plugin).
6. How it works: a small architecture diagram, with a link to `docs/architecture.md`.
7. Limitations and fidelity table (what converts and what does not). Playwright and Ruff are honest about scope in this way.
8. Contributing, License, Acknowledgements.
Keep the README under about 200 lines and push depth into `docs/`.

### 3.6 ADRs
- `docs/adr/NNNN-title.md` in MADR format ([adr.github.io/madr](https://adr.github.io/madr/)): Context, Decision drivers, Options, Outcome, Consequences. Write ADR-0001 for this stack and then one per schema or protocol change.

### 3.7 Code readability conventions
- One concept per module, about 300 lines soft cap. Name files after what they export (`parse-slide.ts`, `layer_tree.py`).
- Put pure core logic in `core` / `convert` and I/O at the edges. That makes golden tests possible.
- TSDoc on every exported symbol, and Google-style docstrings in Python (enforced by Ruff `D` rules with `convention = "google"`).
- Errors: TS uses one `BridgeError` base class with a `code` string union (`"PLUGIN_NOT_CONNECTED" | "NODE_NOT_FOUND" | ...`) and `cause`. Never throw strings. Python uses `class ConvertError(Exception)` with subclasses per failure (`UnsupportedShapeError`). The CLI maps codes to exit codes and human messages.
- Discriminated unions for node types (`type: "FRAME" | "TEXT" | ...`) and an exhaustive `switch` enforced by `switch-exhaustiveness-check` or `assertNever`.

### 3.8 Visual testing of the renderer in CI
- Reference rendering: `soffice --headless --convert-to pdf input.pptx` on `ubuntu-latest`, then rasterize with `pdftoppm -r 96 -png` (poppler) or pypdfium2. Install with `sudo apt-get install -y libreoffice-impress poppler-utils` ([LibreOffice headless](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)). Cache the apt debs through `awalsh128/cache-apt-pkgs-action` to save about 1–2 minutes.
- Determinism:
  - Pin fonts. Commit OFL fonts (for example Inter, Noto Sans, Liberation or Carlito/Caladea as metric-compatible substitutes for Calibri/Cambria) into `tests/fonts/`, install them into `~/.fonts`, and run `fc-cache -f`. Set `SAL_USE_VCLPLUGIN=svp` and a fixed `HOME` or `-env:UserInstallation=file:///tmp/lo-profile` so profile state does not leak between runs.
  - Pin the LibreOffice version (Docker image or a specific PPA) because rendering changes between releases. Running inside a pinned container (`ghcr.io/<org>/lo-render:24.8`) is the most reproducible option.
  - Compare with a tolerance: `pixelmatch` / `odiff`, or SSIM in Python (`scikit-image`), with a per-fixture threshold. Upload diff PNGs as artifacts on failure.
- The Figma side cannot run headless in CI. Compare the **layer tree** (syrupy goldens) in CI, and for the final visual check, render the layer tree with an in-repo reference rasterizer (a simple SVG writer from the tree, rasterized by resvg), then diff it against the LibreOffice PNG. Run real Figma export checks manually or nightly on a self-hosted runner.
- Run visual tests only on Linux. Font rasterization differs by OS, so a cross-OS pixel comparison produces flaky results.

---

## 4. Chosen stack

| Area | Choice | Why (short) |
|---|---|---|
| Package manager | pnpm 10 workspaces + catalogs | Strict deps, OSS standard |
| Task runner | `pnpm -r` + TS project refs (Turborepo later if needed) | Few packages, less config |
| TS config | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax, NodeNext | Catches index and optional bugs |
| Build | tsdown (libs/CLI), esbuild (Figma plugin), `tsc -b` typecheck | Fast, modern, .d.ts |
| Lint/format TS | Biome (format + base lint) + typescript-eslint strictTypeChecked (type-aware only) | Speed plus deep async safety |
| Tests TS | Vitest 3 projects + coverage-v8 | Standard, fast, ESM-native |
| Validation | zod v4 (`zod/mini` in plugin UI) | Native JSON Schema, MCP SDK support |
| Logging | pino → stderr | stdio MCP safe, JSON |
| CLI | commander + extra-typings | Zero deps, familiar |
| Release TS | Changesets + npm trusted publishing (provenance) | No tokens, changelogs |
| Node | engines >=22, .nvmrc 24, CI 22/24 | LTS lines |
| Python tooling | uv (uv_build backend, src layout, uv.lock) | One tool |
| Lint/format Py | Ruff | One tool |
| Types Py | pyright strict | Fast, strict |
| Tests Py | pytest + syrupy (JSON goldens) + hypothesis | Goldens plus invariants |
| Model | pydantic v2, generated by datamodel-code-generator from JSON Schema | Single contract |
| Release Py | uv build + PyPI Trusted Publishing | OIDC, attestations |
| Schema contract | zod → JSON Schema 2020-12 → pydantic, drift check in CI | TS/Py in sync |
| CI | GH Actions, 3 OS matrix, SHA-pinned actions, zizmor | Cross-platform, secure |
| Hooks/commits | lefthook + commitlint (Conventional Commits) | Cross-language, Windows OK |
| Docs | README (uv/Ruff pattern), MADR ADRs, CONTRIBUTING, SECURITY, CoC 2.1, issue forms | Admired-project norms |
| Visual tests | headless LibreOffice (pinned, Linux only) + pinned fonts + SSIM/odiff | Deterministic |

---

## 5. Config snippets

### `tsconfig.base.json`
```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```
Plugin override (`packages/plugin/tsconfig.json`): `"module": "Preserve", "moduleResolution": "Bundler", "target": "ES2017", "lib": ["ES2017"], "types": ["@figma/plugin-typings"]`.

### `biome.json`
```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100, "lineEnding": "lf" },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" } },
  "linter": {
    "rules": {
      "recommended": true,
      "suspicious": { "noConsole": "error" },
      "style": { "useImportType": "error", "noNonNullAssertion": "error" }
    }
  }
}
```

### `eslint.config.js` (type-aware only)
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/*.generated.*"] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "off", // Biome handles it
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }]
    }
  }
);
```

### `vitest.config.ts` (root)
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["packages/*/src/**"] },
    restoreMocks: true,
  },
});
```

### `tsdown.config.ts` (e.g. packages/cli)
```ts
import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
});
```

### `python/pyproject.toml`
```toml
[project]
name = "figma-bridge-convert"
version = "0.1.0"
description = "Convert PPTX/PDF into a Figma layer tree"
readme = "README.md"
license = "MIT"
license-files = ["LICENSE"]
authors = [{ name = "Author One" }, { name = "Author Two" }]
requires-python = ">=3.11"
dependencies = ["python-pptx>=1.0", "pypdfium2>=4.30", "pydantic>=2.9"]

[project.scripts]
figma-bridge-convert = "figma_bridge_convert.cli:main"

[dependency-groups]
dev = [
  "pytest>=8", "pytest-cov", "syrupy>=4", "hypothesis>=6",
  "jsonschema>=4", "pyright>=1.1.400", "ruff>=0.13", "datamodel-code-generator>=0.30",
]

[build-system]
requires = ["uv_build>=0.8,<0.10"]
build-backend = "uv_build"

[tool.ruff]
line-length = 100
target-version = "py311"
extend-exclude = ["src/figma_bridge_convert/_generated"]

[tool.ruff.lint]
select = ["E", "W", "F", "I", "B", "UP", "SIM", "C4", "RUF", "N", "D", "ANN", "PTH", "PT", "TRY", "EM", "PL", "PERF", "FBT", "S"]
ignore = ["D105", "D107", "PLR0913", "TRY003"]

[tool.ruff.lint.pydocstyle]
convention = "google"

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "D", "ANN", "PLR2004"]

[tool.pyright]
include = ["src", "tests"]
typeCheckingMode = "strict"
pythonVersion = "3.11"
stubPath = "typings"
reportMissingTypeStubs = false

[tool.pytest.ini_options]
addopts = ["-ra", "--strict-markers", "--strict-config", "--import-mode=importlib"]
testpaths = ["tests"]
markers = ["visual: pixel comparison vs LibreOffice (linux only)"]
xfail_strict = true
```

### `lefthook.yml`
```yaml
pre-commit:
  parallel: true
  commands:
    biome:
      glob: "*.{ts,tsx,js,json}"
      run: pnpm biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true
    ruff:
      glob: "python/**/*.py"
      run: uv run --directory python ruff check --fix {staged_files} && uv run --directory python ruff format {staged_files}
      stage_fixed: true
commit-msg:
  commands:
    commitlint:
      run: pnpm commitlint --edit {1}
```

### `.github/workflows/ci.yml` (skeleton)
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ts:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    defaults: { run: { shell: bash } }
    steps:
      - uses: actions/checkout@<sha> # v5
      - uses: pnpm/action-setup@<sha> # v4
      - uses: actions/setup-node@<sha> # v5
        with: { node-version: "${{ matrix.node }}", cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm biome ci .
      - run: pnpm lint          # eslint type-aware
      - run: pnpm typecheck     # tsc -b
      - run: pnpm test -- --coverage
      - run: pnpm build && pnpm publint

  py:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        python: ["3.11", "3.13"]
    runs-on: ${{ matrix.os }}
    defaults: { run: { shell: bash, working-directory: python } }
    steps:
      - uses: actions/checkout@<sha>
      - uses: astral-sh/setup-uv@<sha> # v6
        with: { enable-cache: true, python-version: "${{ matrix.python }}" }
      - run: uv sync --locked
      - run: uv run ruff check . && uv run ruff format --check .
      - run: uv run pyright
      - run: uv run pytest -m "not visual"

  schema-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version: 24, cache: pnpm }
      - uses: astral-sh/setup-uv@<sha>
      - run: pnpm install --frozen-lockfile && pnpm gen:schema
      - run: cd python && uv run datamodel-codegen --input ../schema/layer-tree.schema.json --input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --output src/figma_bridge_convert/_generated/models.py
      - run: git diff --exit-code

  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: awalsh128/cache-apt-pkgs-action@<sha>
        with: { packages: libreoffice-impress poppler-utils fontconfig, version: 1 }
      - run: mkdir -p ~/.fonts && cp python/tests/fonts/*.ttf ~/.fonts/ && fc-cache -f
      - uses: astral-sh/setup-uv@<sha>
        with: { enable-cache: true }
      - run: cd python && uv sync --locked && uv run pytest -m visual
        env: { SAL_USE_VCLPLUGIN: svp }
      - if: failure()
        uses: actions/upload-artifact@<sha>
        with: { name: visual-diffs, path: python/tests/__visual_diffs__/ }
```
Release workflows are separate (`release-npm.yml` with `changesets/action` and `id-token: write`; `release-pypi.yml` on `py-v*` tags with `uv build` and `pypa/gh-action-pypi-publish` in environment `pypi`, `id-token: write`).

---

## Sources
- tsdown: https://tsdown.dev/advanced/benchmark · https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026 · https://alan.norbauer.com/articles/tsdown-bundler/
- zod JSON Schema: https://zod.dev/json-schema · https://zod.dev/v4 · https://github.com/StefanTerdell/zod-to-json-schema (deprecation note)
- Other links inline above.
