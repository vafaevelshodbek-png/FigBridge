# 0003. MCP is the primary interface; the CLI is a thin client

- Status: accepted
- Date: 2026-09-24

## Context

Agents discover capabilities through MCP; people search for "figma mcp". The prototype exposed only a CLI documented in a skill file. MCP spec 2026-07-28 removed session setup and per-connection state; the TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`) serves both old and new clients (research 02).

## Decision

- MCP server over stdio via SDK v2, tools defined with zod v4 schemas, accurate annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), `outputSchema` + text fallback.
- A small, workflow-shaped tool set (~15–20 tools, `figma_` prefix): read outline (paged, size-budgeted), get node, export image, find, build from spec, update, delete, import deck, list sessions, etc.
- Responses stay under a token budget (Claude Code default 25k); large results are paged or written to disk with a path returned; images returned as capped PNG.
- Long operations (imports) report progress and honor cancellation.
- The CLI calls the same hub methods; it exists for scripts and debugging.
- Logs go to stderr (pino), never stdout.

## Consequences

- Works in Claude Code, Claude Desktop, Cursor, VS Code with a one-line config (`npx -y figbridge mcp`).
- Tool list is snapshot-tested; changes are visible in review.
