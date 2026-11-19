# FigBridge

**A local MCP bridge for Figma Desktop. Import websites, PDF pages and PowerPoint slides as editable Figma layers.**

FigBridge lets AI agents inspect, export and edit Figma layers through a local plugin. The CLI provides the same workflows without an MCP client.

- **Websites** — capture a viewport, an entire page or a bounded set of UI states such as open menus and tabs. Import the measured frames, text, supported vectors and individual image assets into Figma.
- **PDF and PowerPoint** — rebuild text, vectors, shapes and images. PowerPoint tables and supported charts remain editable, and Figma Slides imports preserve speaker notes.
- **Figma automation** — inspect the document, create or update nodes, export images, compare pixels and read native comments.

FigBridge is available from source and requires Node.js 22+, pnpm 12.6.0 and Figma Desktop.
For website imports and their fidelity limits, see [Import browser screens](docs/web-import.md).
For PDF and PowerPoint coverage, see [Limitations](#limitations).

## Quick start

```bash
git clone https://github.com/vafaevelshodbek-png/FigBridge.git
cd FigBridge
pnpm install --frozen-lockfile
pnpm build
node packages/figbridge/dist/cli.mjs plugin
```

In Figma Desktop, open **Plugins → Development → Import plugin from manifest** and select the manifest path printed by the CLI.

Start the hub in one terminal:

```bash
node packages/figbridge/dist/cli.mjs start
```

In a second terminal, run `node packages/figbridge/dist/cli.mjs pair`. Open the development plugin in your Figma file and paste the pairing token there. Run `node packages/figbridge/dist/cli.mjs status` to check the connected file and get its session ID.

### Import a website

```bash
pnpm --filter figbridge exec playwright install chromium
node packages/figbridge/dist/cli.mjs web import https://example.com --file "My Figma file" --session SESSION_ID --viewport-only --out captures/example
```

Use your exact Figma file name and session ID. Web import requires **Unrestricted** plugin access for the connected session. Use `web capture` to generate local artifacts with no Figma connection. Each captured state includes a reference screenshot and an editable scene.

### Connect an MCP client

```bash
claude mcp add figbridge -- node /absolute/path/to/FigBridge/packages/figbridge/dist/cli.mjs mcp
```

For Claude Desktop or Cursor, add this to the client's MCP configuration:

```json
{ "mcpServers": { "figbridge": { "command": "node", "args": ["/absolute/path/to/FigBridge/packages/figbridge/dist/cli.mjs", "mcp"] } } }
```

VS Code uses the `servers` key and `"type": "stdio"` in `.vscode/mcp.json`.
Run `node packages/figbridge/dist/cli.mjs doctor` to diagnose pairing or connection issues.

### Try a small deck

In a source checkout, ask your agent to import slide 1 of
`corpus/poi_bar-chart.pptx` (use the absolute path on your computer), then change
the chart title in Figma to confirm the text is editable. For a PDF, try page 1 of
`corpus/beamer_metropolis_demo.pdf`. Keep the plugin open, choose **Ask before changes**,
and click **Allow** when the import requests approval.

Without an AI client, keep the hub running in a separate terminal and import from the CLI:

```bash
node packages/figbridge/dist/cli.mjs start
```

In another terminal, after pairing the plugin:

```bash
node packages/figbridge/dist/cli.mjs import corpus/poi_bar-chart.pptx --pages 1
node packages/figbridge/dist/cli.mjs import corpus/beamer_metropolis_demo.pdf --pages 1
```

For a first-time setup review, see the [ten-minute walkthrough](docs/first-import-check.md).

## Tools

Native Figma comments and replies are available through `figma_comments` and
`figbridge comments <file-key-or-url>`. This optional REST capability requires a local
personal access token with `file_comments:read`; see [setup and usage](docs/comments.md).
It works without the plugin and reads comments across the whole file.

| Tool | What it does |
|---|---|
| `figma_sessions` | Connected Figma files (when several are open) |
| `figma_file_info`, `figma_pages` | File, editor, pages, selection |
| `figma_outline`, `figma_find`, `figma_selection`, `figma_get_node` | Read the document (paged, size-bounded) |
| `figma_export` | Render a node to PNG/JPG/SVG and look at it |
| `figma_compare` | Pixel-compare a layer with an image (a screenshot of its implementation): differing share and a diff map, for pixel-perfect work |
| `figma_create`, `figma_update`, `figma_clone`, `figma_delete` | Edit layers |
| `figma_import_deck` | PDF or PPTX → editable slide frames |
| `figma_capture_web`, `figma_import_web` | Capture browser screens and import them into Figma |

The same operations are available from the CLI: `figbridge status | call | export | compare | import`. If something does not connect, `figbridge doctor` checks the whole setup and says what to fix.

`figma_update` can replace a layer's effects. For example, pass
`props: { "effects": [{ "type": "DROP_SHADOW", "color": { "r": 0, "g": 0, "b": 0, "a": 0.15 }, "offset": { "x": 0, "y": 4 }, "radius": 12 }] }`
for a shadow, or `props: { "effects": [{ "type": "LAYER_BLUR", "radius": 8 }] }`
for blur. `INNER_SHADOW` and `BACKGROUND_BLUR` are also supported. RGBA channels
are 0–1; offsets, radius and optional shadow spread are pixels. Visibility defaults
to true; blending and blur type are NORMAL. Pass `effects: []` to clear effects,
or omit the field to keep them. `figma_get_node` reports the effect list; approval
and **Undo agent** work as for other layer changes.

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
- Superscript and subscript text is set smaller but stays on the baseline (plugins cannot shift it). TIFF pictures are converted to PNG (first page). EMF and WMF pictures are converted through LibreOffice when it is installed, otherwise skipped with a warning.
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
