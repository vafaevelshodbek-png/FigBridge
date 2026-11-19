# FigBridge

**Import websites, app screens, PDFs and PowerPoint decks into Figma as editable layers.**

FigBridge connects a local CLI and MCP server to Figma Desktop. Bring source material into a design file, then inspect, edit, export or compare the resulting layers.

[![CI](https://github.com/vafaevelshodbek-png/FigBridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vafaevelshodbek-png/FigBridge/actions/workflows/ci.yml)

![Tremor dashboard in Chromium and the imported dashboard in Figma Desktop with a chart vector being edited](docs/assets/web-import.png)

*The open-source Tremor dashboard, rendered from a local checkout. In Figma Desktop, the cursor selects an anchor on the Queries chart while the vector controls and stroke properties are visible. [Tremor source](https://github.com/tremorlabs/template-dashboard/tree/ac673531b124244b75fef5c750df1fa9ee783d4a) · [Web import guide](docs/web-import.md)*

## What you can do

| Workflow | Result |
| --- | --- |
| **Website capture** | Open live sites, follow links and explore UI states within set limits. Import pages, menus and other captured states as editable Figma layers. |
| **Reconstruct screens from source code** | Run a frontend from source, such as an open GitHub repository, and turn the rendered screens into editable Figma layers. |
| **PDF and PowerPoint** | Convert pages and slides into editable layers. PowerPoint tables and supported charts are rebuilt from native shapes, and Figma Slides imports preserve speaker notes. |
| **Figma automation** | Inspect or update layers, export frames, compare pixels and read native comments from an MCP client or the CLI. |

## Quick start

Install from source with Node.js 22+, pnpm 12.6.0 and Figma Desktop.

```sh
git clone https://github.com/vafaevelshodbek-png/FigBridge.git
cd FigBridge
pnpm install --frozen-lockfile
pnpm build
node packages/figbridge/dist/cli.mjs plugin
```

Import the printed manifest in **Plugins → Development → Import plugin from manifest**. The setup guide takes you through pairing and a first web or deck import. [Pair the plugin and run an import](docs/first-import-check.md)

## Explore the project

- [Web import](docs/web-import.md) and [PDF / PowerPoint import](docs/deck-import.md)
- [MCP setup and tool reference](docs/tools.md)
- [Architecture and package map](docs/ARCHITECTURE.md)
- [Security and permissions](SECURITY.md) and [contributing](CONTRIBUTING.md)

MIT licensed. Created by [Vafaev Elshodbek](https://github.com/vafaevelshodbek-png), building on the original Figma bridge by [strevesuksess](https://github.com/strevesuksess).
