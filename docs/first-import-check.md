# Getting started

Install from source on Windows or macOS with **Node.js 22+**, **pnpm 12.6.0** and **Figma Desktop**. Use a Figma Design file for your first import.

## Build and pair

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
