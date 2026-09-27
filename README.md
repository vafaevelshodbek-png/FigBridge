# figbridge

**Let AI agents read and edit Figma — and turn PDF and PowerPoint decks into editable Figma slides.**

figbridge connects an AI agent (Claude Code, Claude Desktop, Cursor, VS Code, any MCP client) to the file you have open in Figma Desktop through a small Figma plugin. The agent can inspect layers, export images, build and edit frames, and import a PDF or `.pptx` deck as real, editable Figma layers:

- backgrounds become frame fills, not pictures;
- cards and pills become rectangles with their exact corner radii;
- logos, icons and lines become vectors;
- photos become image layers at source resolution, cropped and rounded like the original;
- text becomes editable paragraphs with its fonts, sizes and colours;
- PowerPoint tables stay tables of cells, and charts (bar, column, line, area, scatter, pie, doughnut and combinations) are rebuilt as shapes with their axes;
- everything inside a card is grouped with the card;
- in a Figma Slides file every page becomes a real slide, with the deck's speaker notes kept on it;
- fonts that had to be replaced are listed in the plugin window, and text that no longer fits its box is reported.

The importers are tested against real decks with golden images on every change; see [Limitations](#limitations) for what is not covered yet.

> Status: pre-release, not yet on npm. The core works end to end in Figma Desktop; until the first release, install from source (see [Development](#development)) and use `node packages/figbridge/dist/cli.mjs` wherever this page says `npx figbridge`.

## Quick start

You need Node.js 22 or newer and Figma Desktop (browser Figma cannot run development plugins). Setup takes about five minutes.

1. **Install the plugin** — it ships inside the package: `npx figbridge plugin` prints the path of its `manifest.json`. In Figma Desktop: *Plugins → Development → Import plugin from manifest…* and pick that file.
2. **Add the MCP server** to your client:

   ```bash
   claude mcp add figbridge -- npx -y figbridge mcp          # Claude Code
   ```

   ```jsonc
   // Claude Desktop / Cursor (.cursor/mcp.json)
   { "mcpServers": { "figbridge": { "command": "npx", "args": ["-y", "figbridge", "mcp"] } } }
   // VS Code (.vscode/mcp.json) uses the key "servers" instead of "mcpServers"
   ```

3. **Pair once** — run `npx figbridge pair`, open the figbridge plugin in your Figma file and paste the token.
4. Ask your agent: *"Import ~/decks/q2.pdf pages 1–5 into Figma."* Slides are laid out in a grid below whatever is already on the page; in a Figma Slides file they are added as slides.

If the plugin says it is not connected, run `npx figbridge doctor`: it checks Node, the token, the plugin and the hub and prints the one thing to fix.

## Tools

| Tool | What it does |
|---|---|
| `figma_sessions` | Connected Figma files (when several are open) |
| `figma_file_info`, `figma_pages` | File, editor, pages, selection |
| `figma_outline`, `figma_find`, `figma_selection`, `figma_get_node` | Read the document (paged, size-bounded) |
| `figma_export` | Render a node to PNG/JPG/SVG and look at it |
| `figma_compare` | Pixel-compare a layer with an image (a screenshot of its implementation): differing share and a diff map, for pixel-perfect work |
| `figma_create`, `figma_update`, `figma_clone`, `figma_delete` | Edit layers |
| `figma_import_deck` | PDF or PPTX → editable slide frames |

The same operations are available from the CLI: `figbridge status | call | export | compare | import`. If something does not connect, `figbridge doctor` checks the whole setup and says what to fix.

## How it works

```
AI client ──stdio/MCP──▶ figbridge ──WebSocket (127.0.0.1)──▶ figbridge plugin ──▶ Figma Plugin API
                         (hub, importers)
```

The importer is a pure function `PDF → Scene` (an editable layer tree); the plugin renders a Scene. Architecture, protocol and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/adr](docs/adr).

## Security

The hub listens on `127.0.0.1` only, rejects browser origins and DNS-rebinding hosts, and requires a pairing token. The plugin executes a fixed set of methods — there is no "run arbitrary code" tool. In the plugin window you choose how much the agent may do in each file — **Read only**, **Ask before changes** (the default: every change waits for your Allow), **Auto** (only destructive changes such as large deletions or replacing frames are asked) or **Unrestricted** (resets when the plugin reopens) — and you can pause or stop the agent and follow its recent actions. `figbridge mcp --read-only` disables every mutating tool. See [SECURITY.md](SECURITY.md).

## Limitations

- PPTX: radar, bubble, stock and surface charts are skipped with a warning (bar, column, line, area, scatter, pie, doughnut and their combinations are rebuilt). SmartArt is imported from the drawing PowerPoint stores with it; files saved without one (rare) skip the diagram with a warning.
- Fonts that are not installed are replaced by a metric-compatible twin when one exists (Calibri → Carlito, Arial → Arimo, Times New Roman → Tinos…), else by a face of the same kind or Inter with the same weight; brand fonts can then run slightly longer.
- Rotated text in PDFs is skipped; vectors drawn on top of a photo inside the same image stay part of the photo.
- Animated GIFs keep their animation (it plays in Figma's presentation view) unless they are larger than 4096 px on a side, which Figma requires to be downscaled to a still image. Videos import as their poster frame.
- Superscript and subscript text is set smaller but stays on the baseline (plugins cannot shift it). TIFF pictures are converted to PNG (first page); EMF and WMF pictures are skipped with a warning.
- Figma Desktop is required (browser Figma cannot load development plugins).

## Development

```bash
pnpm install
pnpm build          # all packages + the plugin
pnpm check          # typecheck, lint, tests
pnpm test:coverage  # tests with the coverage floor CI enforces
pnpm -F figbridge smoke   # pack, install into an empty folder with npm, run CLI and MCP
```

Importer changes are checked against golden images in `corpus/golden/`; after an intended change, `UPDATE_GOLDEN=1 pnpm vitest run --project figbridge golden` and review the new images.

Node ≥ 22. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Created by **[Vafaev Elshodbek](https://github.com/vafaevelshodbek-png)** and **[strevesuksess](https://github.com/strevesuksess)**, who wrote the original Figma bridge this project grew from. MIT licensed.
