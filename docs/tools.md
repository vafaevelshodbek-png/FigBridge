# MCP and CLI reference

FigBridge exposes its MCP server over stdio. The CLI also works directly with the local hub. [Build and pair FigBridge](first-import-check.md)

## Connect an MCP client

Use the absolute path to the built CLI. A client can start `mcp` itself. It attaches to an existing local hub when one is running.

```sh
claude mcp add figbridge -- node /absolute/path/to/FigBridge/packages/figbridge/dist/cli.mjs mcp
codex mcp add figbridge -- node /absolute/path/to/FigBridge/packages/figbridge/dist/cli.mjs mcp
```

For Claude Desktop or Cursor, add this entry to the client configuration.

```json
{
  "mcpServers": {
    "figbridge": {
      "command": "node",
      "args": ["/absolute/path/to/FigBridge/packages/figbridge/dist/cli.mjs", "mcp"]
    }
  }
}
```

VS Code uses `servers` in `.vscode/mcp.json` and `"type": "stdio"` on the entry. Append `--read-only` to restrict the server to read and capture tools. Individual files also retain their own plugin access mode. [Security and permissions](../SECURITY.md)

## Tool catalog

| Task | MCP tools |
| --- | --- |
| Choose a file or page | `figma_sessions`, `figma_file_info`, `figma_pages` |
| Inspect layers | `figma_outline`, `figma_selection`, `figma_get_node`, `figma_find` |
| Export or compare | `figma_export`, `figma_compare` |
| Edit layers | `figma_create`, `figma_update`, `figma_clone`, `figma_delete` |
| Capture and import | `figma_capture_web`, `figma_import_web`, `figma_import_deck` |
| Read native comments | `figma_comments` |

Discovery and schemas are available from an MCP client. The implementation defines each tool's inputs and behavior. [Tool definitions](../packages/figbridge/src/mcp/tools.ts)

Native comments use the Figma REST API and a separate Figma token with `file_comments:read`. [Comments setup](comments.md)

### Update layer effects

`figma_update` accepts `props.effects`. It replaces the entire effect list. An empty array clears the list. Omitting the field preserves it. Supported types are `DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR` and `BACKGROUND_BLUR`. Colors use 0–1 RGBA, and offsets and radii are measured in pixels.

```json
{
  "effects": [
    {
      "type": "DROP_SHADOW",
      "color": { "r": 0, "g": 0, "b": 0, "a": 0.15 },
      "offset": { "x": 0, "y": 4 },
      "radius": 12
    }
  ]
}
```

## CLI

Run the CLI from the repository root. Append `--help` to a command to see its options.

```sh
node packages/figbridge/dist/cli.mjs --help
node packages/figbridge/dist/cli.mjs web capture --help
node packages/figbridge/dist/cli.mjs call --help
```

Use `status` to choose a connected file and pass `--session` when targeting a specific file. The built-in commands also include `doctor`, `export`, `compare`, `import` and `comments`.
