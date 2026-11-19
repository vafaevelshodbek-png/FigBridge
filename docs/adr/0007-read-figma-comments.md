# Read native Figma comments through REST

Status: implemented; live CLI and MCP reads verified on 2026-10-20.

## Context

The Plugin API exposes canvas nodes, not native comment threads. Reading text layers or
Dev Mode annotations does not satisfy the request. Figma provides a documented
`GET /v1/files/:key/comments` endpoint with `file_comments:read`.

## Decision

Add a read-only Node-side adapter shared by the MCP tool `figma_comments` and CLI
`figbridge comments <file>`. Require a file key or Figma URL explicitly: the current
plugin does not reliably expose a file key. No plugin restart or wire protocol change
is needed. Existing canvas operations keep working without REST credentials.

Read a personal access token from `FIGMA_ACCESS_TOKEN`, otherwise
`~/.figbridge/figma-token` (respecting `FIGBRIDGE_HOME`). Never accept a token as an MCP
argument, put it in URLs, send it to the plugin, or return upstream error bodies.
Use only the fixed HTTPS API origin, refuse redirects, cap response size and duration,
propagate cancellation, and validate external JSON. Do not automatically retry 429.

Return native comments and replies with authors, timestamps, resolution and original
anchor metadata. Provide bounded local pagination and filters for thread status and
an exact anchor node, inheriting the root's anchor and status for replies. A node filter
does not mean descendants. File-level results must not imply current-page membership:
canvas-coordinate anchors cannot establish a page through this endpoint.

Alternatives: browser scraping is brittle and session-dependent; a plugin-only handler
cannot access comments. OAuth registration and write/reaction operations are out of scope.

## Acceptance

Tests cover URL validation, thread filters, pagination, bounded output, credential absence,
403/404/429, malformed data, cancellation, timeout and redirect rejection. MCP transport
tests prove discovery, honest annotations and an actionable missing-token error without
a plugin. Run typecheck, lint, tests, build and package smoke before publication. Verify
real comments in a test file when a read token and file URL are available.

A live acceptance test compared comments and replies with the Figma panel
and checked the anchor, pagination, and thread filter. One reply used
`order_id: null`; the adapter accepts it and a regression test covers this response.
Credentials and live response data are not committed.

Sources: https://developers.figma.com/docs/rest-api/comments-endpoints/,
https://developers.figma.com/docs/rest-api/comments-types/,
https://developers.figma.com/docs/rest-api/comments-property-types/.
