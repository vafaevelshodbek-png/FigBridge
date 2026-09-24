# Security

## Model

figbridge gives an AI agent edit access to the Figma files you open with the plugin. It is designed so that nothing else can:

- The hub binds to `127.0.0.1` only.
- Requests whose `Host` header is not a loopback name are rejected (DNS rebinding).
- Browser origins are rejected; only the plugin's opaque origin (`null`) or non-browser clients are accepted.
- Every request and the plugin handshake require a 128-bit pairing token stored with user-only permissions in `~/.figbridge/token`.
- The plugin implements a fixed method catalog. There is no method that evaluates code.
- Documents being imported are treated as untrusted input; parsing is bounded.
- `--read-only` disables every method that modifies the document.

Changes you make through figbridge are made with your Figma account and are visible to everyone viewing the file.

## Reporting a vulnerability

Please report privately via GitHub Security Advisories on this repository rather than a public issue. Include steps to reproduce and the version. We aim to respond within a week.
