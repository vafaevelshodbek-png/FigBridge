# Import PDF and PowerPoint

FigBridge converts PDF pages and PowerPoint slides into editable frames, text, shapes, vectors and image fills. Use a paired plugin in Figma Design or Figma Slides. [Build and pair FigBridge](first-import-check.md)

## Import from the CLI

Run from the repository root with the hub and plugin open. The `--pages` flag accepts a comma-separated list of 1-based page numbers. Omit it to import the entire deck.

```sh
node packages/figbridge/dist/cli.mjs import corpus/poi_bar-chart.pptx --pages 1 --session SESSION_ID
node packages/figbridge/dist/cli.mjs import corpus/beamer_metropolis_demo.pdf --pages 1,2 --session SESSION_ID
```

In **Ask before changes**, approve the request in the plugin. Figma Design places imported frames below existing content unless you set `--x` and `--y`. Figma Slides creates slides and preserves PowerPoint speaker notes. An MCP client can use `figma_import_deck` with an absolute file path. [MCP tools](tools.md)

## Format support

| Input | What to expect |
| --- | --- |
| **PDF** | Text, paths, fills and image regions. Rotated text is skipped. Artwork already embedded in a raster image stays in that image. |
| **PowerPoint** | Text, shapes, tables, supported charts and stored SmartArt drawings. Bar, column, line, area, scatter, pie, doughnut and supported combinations are rebuilt as shapes. Radar, bubble, stock and surface charts are skipped with a warning. |
| **Fonts and media** | The plugin reports substituted fonts and text overflow. Videos use poster frames. Large GIFs may become still images. TIFF uses the first page. EMF and WMF conversion requires LibreOffice. |
| **Text placement** | Superscript and subscript use smaller text on the baseline. Review line breaks and overflow after font substitution. |

The repository ships redistributable source decks and golden images for regression testing. [Test corpus and licenses](../corpus/README.md)
