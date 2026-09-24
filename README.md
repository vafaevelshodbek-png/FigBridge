# figbridge

**Let AI agents read and edit Figma — and turn PDF decks into editable Figma slides.**

figbridge connects an AI agent (Claude Code, Claude Desktop, Cursor, VS Code, any MCP client) to the file you have open in Figma Desktop through a small Figma plugin. The agent can inspect layers, export images, build and edit frames, and import a PDF presentation as real, editable Figma layers:

- backgrounds become frame fills, not pictures;
- cards and pills become rectangles with their exact corner radii;
- logos, icons and lines become vectors;
- photos become image layers at source resolution, cropped and rounded like the original;
- text becomes editable paragraphs with its fonts, sizes and colours;
- everything inside a card is grouped with the card.

Every import can be checked against the original with a visual diff.

> Status: pre-release. The core works end to end; see [Limitations](#limitations).

## Quick start

1. **Install the plugin** — Figma Desktop → *Plugins → Development → Import plugin from manifest…* → `packages/plugin/manifest.json` (build it first with `pnpm build`).
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
4. Ask your agent: *"Import ~/decks/q2.pdf pages 1–5 into Figma below the existing frames."*

## Tools

| Tool | What it does |
|---|---|
| `figma_sessions` | Connected Figma files (when several are open) |
| `figma_file_info`, `figma_pages` | File, editor, pages, selection |
| `figma_outline`, `figma_find`, `figma_selection`, `figma_get_node` | Read the document (paged, size-bounded) |
| `figma_export` | Render a node to PNG/JPG/SVG and look at it |
| `figma_create`, `figma_update`, `figma_clone`, `figma_delete` | Edit layers |
| `figma_import_deck` | PDF → editable slide frames |

The same operations are available from the CLI: `figbridge status | call | export | import`.

## How it works

```
AI client ──stdio/MCP──▶ figbridge ──WebSocket (127.0.0.1)──▶ figbridge plugin ──▶ Figma Plugin API
                         (hub, importers)
```

The importer is a pure function `PDF → Scene` (an editable layer tree); the plugin renders a Scene. Architecture, protocol and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/adr](docs/adr).

## Security

The hub listens on `127.0.0.1` only, rejects browser origins and DNS-rebinding hosts, and requires a pairing token. The plugin executes a fixed set of methods — there is no "run arbitrary code" tool. `figbridge mcp --read-only` disables every mutating tool. See [SECURITY.md](SECURITY.md).

## Limitations

- PPTX import is not yet ported to this codebase (PDF works today).
- Brand fonts that are not installed fall back to Inter with the same weight; lines can be slightly longer.
- Rotated text in PDFs is skipped; vectors drawn on top of a photo inside the same image stay part of the photo.
- Figma Desktop is required (browser Figma cannot load development plugins).

## Development

```bash
pnpm install
pnpm build          # all packages + the plugin
pnpm check          # typecheck, lint, tests
```

Node ≥ 22. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Created by **Elshodbek** and **[strevesuksess](https://github.com/strevesuksess)**, who wrote the original Figma bridge this project grew from. MIT licensed.
