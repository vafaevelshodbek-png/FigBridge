# Getting started

Use **Figma Desktop** on Windows or macOS. Start with a Figma Design file.

## Assistant setup

Use a local Codex session in the ChatGPT desktop app or a local Claude Code session in Claude Desktop. The assistant needs permission to run commands on the same computer as Figma. [ChatGPT desktop](https://learn.chatgpt.com/docs/app) · [Claude Code on desktop](https://code.claude.com/docs/en/desktop)

1. Ask the assistant to install FigBridge from its GitHub repository. It will prepare the plugin and give you a path ending in `manifest.json`.
2. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest** and select that file. Run **figbridge** from the Development menu and tell the assistant it is open.
3. Paste the pairing token into the plugin when the assistant says it is in your clipboard. Then the assistant can verify the connection.

### Steps for the assistant

1. Clone the repository into a user-writable folder. Use Node.js 22+ and pnpm 12.6.0. From the checkout, run `pnpm install --frozen-lockfile` and `pnpm build`.
2. Check `node packages/figbridge/dist/cli.mjs status`. Reuse an active FigBridge hub. A configured local MCP client starts its hub when it launches `mcp`. For CLI use in the current session, start `node packages/figbridge/dist/cli.mjs start` as a local background process if the hub is offline.
3. Run `node packages/figbridge/dist/cli.mjs plugin` and give the user the absolute manifest path and the Figma menu steps above.
4. Once the user has opened the plugin, pipe `node packages/figbridge/dist/cli.mjs pair` directly to `Set-Clipboard` in PowerShell or `pbcopy` on macOS. Keep the token in the local clipboard. After pairing, rerun `status` and check the intended file with `call session.info --session SESSION_ID`.
5. For a web import, install Chromium with `pnpm --filter figbridge exec playwright install chromium`. For future chats, configure the client's local MCP connection if requested. [MCP setup](tools.md)

## Manual setup

Install Node.js 22+ and pnpm 12.6.0 before building from source.

From the repository root, install dependencies, build the packages and locate the plugin manifest.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/figbridge/dist/cli.mjs plugin
```

1. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest** and select the printed file.
2. In one terminal, run `node packages/figbridge/dist/cli.mjs start` to start the local hub.
3. In a second terminal, run `node packages/figbridge/dist/cli.mjs pair`. Open the development plugin in your Figma file and paste the token.
4. Run `node packages/figbridge/dist/cli.mjs status`. Keep the plugin open and copy the session ID beside the intended file name.

## Import a deck page

Leave the plugin in **Ask before changes** and approve the import in Figma. Replace `SESSION_ID` with the value from `status`.

```sh
node packages/figbridge/dist/cli.mjs import corpus/poi_bar-chart.pptx --pages 1 --session SESSION_ID
```

To try PDF, replace the source with `corpus/beamer_metropolis_demo.pdf`. Select a text layer in the result and edit its content. [Deck import and format support](deck-import.md)

## Import a website

Install Chromium once. Choose **Unrestricted** for this plugin session, then use the file's exact name and the session ID from `status`.

```sh
pnpm --filter figbridge exec playwright install chromium
node packages/figbridge/dist/cli.mjs web import https://example.com/ --file "My Figma file" --session SESSION_ID --viewport-only --out out/example
```

The output directory must be new or empty. It receives the reference PNG, capture JSON and a manifest with any reported losses. Open the imported frame in Figma to inspect its native layers. [Web capture options and fidelity limits](web-import.md)

## Connect an agent or troubleshoot

MCP is optional for the commands above. Configure your client to run the built CLI with the `mcp` subcommand. [MCP setup](tools.md)

If the session does not appear, run `node packages/figbridge/dist/cli.mjs doctor`. Check that the development plugin is open in the intended Figma file and that it holds the token from this installation. For a website capture without a Figma session, use `web capture`.
