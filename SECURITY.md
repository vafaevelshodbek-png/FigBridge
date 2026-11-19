# Security

## Local access

The hub listens on `127.0.0.1` and checks the request host and origin. The plugin handshake and protected API routes require a 128-bit pairing token. The liveness route is available locally without the token. The token is stored in `~/.figbridge/token` by default, with mode `0600` on macOS and Linux and user-profile permissions on Windows.

The plugin runs a fixed set of document methods under your Figma account. Edits are visible to people who can view the file.

| Plugin mode | What an agent can do |
| --- | --- |
| **Read only** | Inspect and export permitted document content |
| **Ask before changes** | Request approval for each write |
| **Auto** | Make routine changes and request approval for destructive operations |
| **Unrestricted** | Write without individual prompts until the plugin reopens |

Run the MCP server with `--read-only` to remove mutating tools from that server. Website capture artifacts may contain visible page content and authenticated assets. Keep them and any browser storage-state files private when capturing authenticated pages. [Web import and authentication](docs/web-import.md)

## Report a vulnerability

Use GitHub's private report form. Include the affected version or commit and a minimal reproduction. [Report a vulnerability](https://github.com/vafaevelshodbek-png/FigBridge/security/advisories/new)
