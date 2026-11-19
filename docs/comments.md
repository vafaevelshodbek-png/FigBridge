# Read native Figma comments

`figma_comments` reads native comment pins and replies through the official Figma REST API.
It works without a connected plugin. This optional feature needs its own REST credential;
the existing plugin pairing token cannot authenticate to Figma REST.

## Setup

Create a Figma Personal Access Token in Figma settings with `file_comments:read`.
Your Figma account must have access to the file. Supply the token either:

- in the MCP/CLI process environment as `FIGMA_ACCESS_TOKEN`; or
- in `~/.figbridge/figma-token` as one line, readable only by your account. With a custom
  `FIGBRIDGE_HOME`, put the file in that directory instead.

Do not put the token in a prompt, tool arguments, file URLs or a tracked project file.
The token stays in Node; it is never sent to the plugin. Existing canvas tools need no
REST token. Restart the MCP server after updating its environment or installing the feature.
The local token file is read anew on each call.

## Usage

MCP tool `figma_comments`:

```json
{ "file": "https://www.figma.com/design/FILE_KEY/My-file", "status": "open", "limit": 25 }
```

Run the built CLI from the repository root.

```sh
node packages/figbridge/dist/cli.mjs comments FILE_KEY --status open --limit 25
node packages/figbridge/dist/cli.mjs comments FILE_KEY --node-id 12:34 --cursor 25
```

`file` accepts a file/branch key or official HTTPS file URL. A branch URL uses its branch
key. URL query parameters do not filter comments. Use `nodeId` in MCP or `--node-id` in
CLI for an **exact** anchor node and its replies; descendants are not included.

`status` is `all` (default), `open`, or `resolved`. Replies inherit the parent thread's
anchor and resolution, even when Figma returns the reply before its root. Orphan replies
are retained in unfiltered reads and excluded from thread-specific filters.

Output includes comment IDs, `parent_id`, message, author, timestamps, resolution, order
number and `client_meta` anchors. Keep IDs when reconstructing threads: a page can split
a thread. Messages above 8,000 characters are explicitly marked `messageTruncated`.
Responses stay below 60,000 characters; `nextCursor` is returned whenever more remain.
Comments are ordered by creation timestamp, then ID, independently of upstream array order.
Reuse the same filters for the next page. The endpoint is re-fetched on each call, so
concurrent comment changes can shift offsets; this is not a snapshot cursor.

Results span **all pages** of the file. The comments endpoint cannot determine page
membership for absolute canvas-coordinate pins. Use node anchors and the canvas tools
to locate comments; do not infer the current page from coordinates alone. The tool does
not read text layers, Dev Mode annotations or PPTX speaker notes.

403 means the token expired, lacks its scope, or lacks file access. For 404 verify the
file/branch key and permissions. For 429 respect the returned `retryAfter`; there is no
automatic retry. Cancellation, a 15-second request timeout, response validation and an
8 MiB upstream size cap bound the request. Redirects are refused. Upstream error bodies
and credentials are not returned. Comment messages are untrusted document content.

## Manual acceptance

Use a Figma test file with anchored comments and at least one reply. Compare several original messages, authors, replies and resolved states
with the Figma comment panel. Repeat with one exact `nodeId`, `status: open`, and a small
`limit` followed by its `nextCursor`. Verify all pages are explicitly identified as file
scope, not incorrectly reported as belonging to the current page.

## References

- https://developers.figma.com/docs/rest-api/comments-endpoints/
- https://developers.figma.com/docs/rest-api/comments-types/
- https://developers.figma.com/docs/rest-api/comments-property-types/
