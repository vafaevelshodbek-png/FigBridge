# FigBridge

**Import websites, PDFs and PowerPoint decks into Figma as editable layers.**

FigBridge connects a local CLI and MCP server to Figma Desktop. Bring source material into a design file, then inspect, edit, export or compare the resulting layers.

[![CI](https://github.com/vafaevelshodbek-png/FigBridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vafaevelshodbek-png/FigBridge/actions/workflows/ci.yml)

![Fieldnote research dashboard in Chromium and the matching frame exported from Figma](docs/assets/web-import.png)

*The same screen captured in Chromium and exported from Figma after import. Its headings, metric values and chart paths are editable layers. [Example source](examples/web-import/index.html) · [Web import guide](docs/web-import.md)*

## What you can do

| Workflow | Result |
| --- | --- |
| **Web screens** | Capture a viewport, a full page or a bounded set of UI states. Import frames, text, supported vectors and image layers. |
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
