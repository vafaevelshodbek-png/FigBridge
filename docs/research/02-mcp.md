# 02 — Model Context Protocol: spec, TypeScript SDK, tool design, testing, distribution, security

Researched 2026-09-24. Scope: what a high-quality local MCP server in TypeScript should look like for figma-bridge (MCP server + local WebSocket to a Figma dev plugin + pptx/PDF importer).

> Caveat: anthropic.com was unreachable from the research environment, so the Anthropic tool-writing guidance below comes from the published article (URL cited) as previously known, not re-fetched today. All spec and SDK facts were fetched live on 2026-09-24.

---

## 1. Spec essentials

### 1.1 Current version: 2026-07-28 (large, breaking revision)
Source: [changelog](https://modelcontextprotocol.io/specification/latest/changelog). Previous revision: [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25).

| Change | Effect on figma-bridge |
|---|---|
| **Stateless protocol**: no `initialize`/`initialized` handshake; every request carries protocol version + client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`) (SEP-2575) | Keep no per-connection state in the MCP layer. |
| **`server/discover`** RPC, servers MUST implement | SDK v2 does it. |
| **No protocol sessions, no `Mcp-Session-Id`**; cross-call state lives in explicit server-minted handles passed as tool args (SEP-2567) | E.g. import job id or page handle returned by one tool, accepted by the next. See "Stateful Tools" in [tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools). |
| **MRTR (multi round-trip requests)** replaces server-initiated requests (elicitation, sampling, roots): server returns `resultType: "input_required"` + `inputRequests`; client retries with `inputResponses` (SEP-2322) | Elicitation ("confirm deleting 40 nodes?") is now a result shape, not a callback. |
| **`resultType` required** on all results | SDK handles. |
| **`subscriptions/listen`** replaces the HTTP GET stream and `resources/subscribe` | Only needed if we push `list_changed` / resource updates. |
| **SSE resumability removed** (`Last-Event-ID`) | Design long ops for retry/idempotency. |
| **Tasks moved to an extension** `io.modelcontextprotocol/tasks` (polling `tasks/get`) (SEP-2663) | Optional fit for long pptx/PDF imports. |
| **Roots, Sampling, Logging deprecated** (SEP-2577); `ping`, `logging/setLevel` removed | Log to stderr / OpenTelemetry. |
| `inputSchema`/`outputSchema` accept any JSON Schema 2020-12; `structuredContent` any JSON value (SEP-2106) | Arrays allowed as structured output. |
| `tools/list` SHOULD be **deterministic order**; list results carry `ttlMs`/`cacheScope` (SEP-2549) | Register tools in fixed order (prompt-cache friendly). |
| Streamable HTTP POSTs MUST carry `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`; mismatches → `-32020 HeaderMismatch` (SEP-2243) | SDK handles. |
| HTTP+SSE (2024-11-05) formally Deprecated; 12-month deprecation policy (SEP-2596) | Never implement it. |

Backward compatibility: "legacy era" (2024-10-07 … 2025-11-25, handshake-based) vs "modern era" (2026-07-28) — [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [SDK protocol-versions doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md). Shipping hosts will speak 2025-era for months, so **serve both eras**; SDK v2's `serveStdio`/`createMcpHandler` do this by default from one factory.

### 1.2 Transports
Sources: [transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
- **stdio**: newline-delimited JSON-RPC over the child's stdin/stdout; the client spawns the server; cancellation = `notifications/cancelled`. stdout is protocol-only, logs go to stderr ([SDK stdio doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)). Default for local servers; every host supports it.
- **Streamable HTTP**: one endpoint, every message is a POST; reply is JSON or a request-scoped SSE stream (progress, then result). Cancellation = client closes the response stream. Modern-only servers answer GET/DELETE with `405`.
- Custom transports over byte streams SHOULD reuse stdio framing.

### 1.3 Tools
Source: [tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- Fields: `name`, `title`, `description`, `icons`, `inputSchema` (object schema; no-arg tools: `{type:"object", additionalProperties:false}`), `outputSchema`, `annotations`.
- Names: 1–128 chars, `[A-Za-z0-9_.-]`, case-sensitive, unique per server. Hosts aggregating servers can collide on generic names, so prefix ours (`figma_...`).
- **Annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) are hints; clients MUST treat them as untrusted unless the server is trusted. Hosts use them for confirmation UX, so set them accurately ([schema: ToolAnnotations](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations)).
- Content types: `text`, `image` (base64 + `mimeType`), `audio`, `resource_link`, embedded `resource`; all accept `annotations` (`audience`, `priority`, `lastModified`).
- **Structured output**: `structuredContent` MUST conform to `outputSchema` if given; SHOULD also be serialized in a text block for back-compat.
- **Two error channels**: protocol errors (unknown tool, malformed request → JSON-RPC error) vs **tool execution errors** (`isError: true`, actionable text) that clients SHOULD pass to the model for self-correction.
- Server MUSTs: validate inputs, access control, rate-limit, sanitize outputs.

### 1.4 Resources, prompts, utilities
- Resources: URI-addressed read-only context; not-found error is now `-32602` ([resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources), changelog). Fit: `figma://node/{id}` snapshots. Hosts surface tools much better than resources, so every essential capability must also be a tool.
- Prompts: user-invoked templates ([prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)); Claude Code exposes them as slash commands ([Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp)). Candidates: "import deck", "audit page".
- **Progress**: client puts `progressToken` in `_meta`; server sends `notifications/progress` with increasing `progress`, optional `total`/`message` ([progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)).
- **Cancellation**: server SHOULD stop work and MUST NOT send further messages for the request ([cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)). Propagate the abort to the plugin RPC.
- **Elicitation**: form (JSON schema) or URL mode, now via MRTR ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). Use sparingly; host support varies.
- **Logging**: deprecated; use stderr and optionally OTel (`traceparent` in `_meta`, SEP-414).

---

## 2. TypeScript SDK usage patterns

Sources: [typescript-sdk README](https://github.com/modelcontextprotocol/typescript-sdk) (main = v2), [v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/), [releases](https://github.com/modelcontextprotocol/typescript-sdk/releases).

- **v2 is the stable line** for 2026-07-28. Split packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, thin middleware `@modelcontextprotocol/node|express|fastify|hono`. As of 2026-09-23: `server@2.1.0`, `node@2.1.0`; v1 (`@modelcontextprotocol/sdk`) is at 1.30.1 and gets fixes for at least 6 months after v2. **Use v2.** v1→v2 codemod and [upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md).
- Schemas via Standard Schema (Zod v4 `zod/v4`, Valibot, ArkType). `.describe()` becomes the argument description the model sees ([tools doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md)).
- `registerTool` replaces v1 `tool()`. Invalid arguments come back as `isError: true` results before the handler runs.

### 2.1 Server factory + stdio entry
```ts
// src/server.ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { PluginBridge } from './bridge/index.js';

export function createServer(bridge: PluginBridge) {
  const server = new McpServer({ name: 'figma-bridge', version: PKG_VERSION });

  server.registerTool('figma_get_node', {
    title: 'Get Figma node',
    description: 'Read one node (optionally children to `depth`) from the open Figma file. ' +
      'If you only know a name, call figma_search_nodes first. Concise summary by default.',
    inputSchema: z.object({
      nodeId: z.string().describe('Figma node id, e.g. "12:34"'),
      depth: z.number().int().min(0).max(5).default(1),
      format: z.enum(['concise', 'detailed']).default('concise'),
    }),
    outputSchema: z.object({ id: z.string(), name: z.string(), type: z.string(), children: z.array(z.any()).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const node = await bridge.call('getNode', args, { signal: ctx.mcpReq.signal }); // cancellation reaches the plugin
    if (!node) return { isError: true, content: [{ type: 'text',
      text: `No node ${args.nodeId} in the open file. Call figma_get_selection or figma_search_nodes to get valid ids.` }] };
    return { content: [{ type: 'text', text: JSON.stringify(node) }], structuredContent: node };
  });
  return server;
}

// src/bin/stdio.ts  (#!/usr/bin/env node)
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const handle = serveStdio(() => createServer(bridge));   // serves legacy + modern clients
console.error('figma-bridge MCP ready');                  // stderr only, never stdout
process.on('SIGINT', () => void handle.close());
```
`serveStdio` replaces v1 `new StdioServerTransport()` + `connect()` ([stdio doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)). The abort-signal field name should be checked against [errors/cancellation docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/logging-progress-cancellation.md) when coding.

### 2.2 Progress (pptx/PDF import)
```ts
async ({ path }, ctx) => {
  const token = ctx.mcpReq._meta?.progressToken;
  for (const [i, slide] of slides.entries()) {
    await importSlide(slide);
    if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress',
      params: { progressToken: token, progress: i + 1, total: slides.length, message: `Slide ${i + 1}` } });
  }
  return { content: [{ type: 'text', text: `Imported ${slides.length} slides` }] };
}
```
Source: [logging-progress-cancellation doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/logging-progress-cancellation.md).

### 2.3 Optional Streamable HTTP entry (localhost)
```ts
import { createServer as createHttp } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';

const handler = createMcpHandler(() => createServer(bridge)); // fresh instance per request, stateless
const node = toNodeHandler(handler), vHost = localhostHostValidation(), vOrigin = localhostOriginValidation();
createHttp((req, res) => { if (!vHost(req, res) || !vOrigin(req, res)) return; void node(req, res); })
  .listen(3333, '127.0.0.1');
```
The handler validates **no Host, Origin or token** by itself; guards go in front ([http doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)). `createMcpExpressApp` / `createMcpHonoApp` / `createMcpFastifyApp` arm both guards by default on localhost binds. Auth: verify the bearer in front and pass `handler.fetch(req, { authInfo })` ([authorization doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)). `responseMode: 'json'` drops mid-call notifications; the default upgrades to SSE only when progress is emitted.

### 2.4 Project layout
```
packages/mcp/
  src/server.ts        # createServer(deps) factory: pure, no I/O at import time
  src/tools/*.ts       # one file per tool group; each exports register(server, deps)
  src/bridge/          # WebSocket to plugin: request ids, timeouts, abort, reconnect
  src/bin/stdio.ts     # bin entry
  test/*.test.ts       # vitest, in-process client
```
Mirrors [servers/src/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem): `index.ts` entry, `lib.ts` logic, `path-validation.ts`, `__tests__/`, `vitest.config.ts`, `Dockerfile`. Dependency-inject the bridge so tests pass a fake.

---

## 3. Tool-design rules checklist

Primary source: Anthropic, [Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (cited as [A]); plus the [tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) ([S]).

- [ ] **Design for workflows, not endpoints.** Don't mirror the Plugin API 1:1; consolidate chains into one tool (their examples: `schedule_event` instead of list_users + list_events + create_event; `search_logs` instead of `read_logs`) [A]. For us: `figma_build_from_spec` (JSON → frame tree) instead of 30 `create_rect`/`set_fill` calls.
- [ ] **Fewer, high-leverage tools**; overlapping tools confuse agents [A]. Keep the default set small and gate extras behind toolsets / `--read-only`, as [github-mcp-server](https://github.com/github/github-mcp-server) does.
- [ ] **Namespace names** by service/resource; prefix vs suffix effects vary by model, so choose by eval [A]. Charset `[A-Za-z0-9_.-]` [S].
- [ ] **Write descriptions like onboarding a new teammate**: when to use, when not, relation to other tools, id formats, units, limits; unambiguous param names (`nodeId`, not `id`). Small description edits gave large eval gains [A].
- [ ] **Return meaningful context**: names, types, human-readable fields over opaque ids and low-level metadata; keep the ids needed for follow-up calls [A].
- [ ] **`response_format` enum (`concise` | `detailed`)** so the agent controls verbosity; concise by default [A].
- [ ] **Token budget**: pagination, filtering, range selection, truncation with sane defaults; Claude Code caps tool responses at 25,000 tokens by default [A], adjustable via `MAX_MCP_OUTPUT_TOKENS` ([Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp)). When truncating, say so and how to get more ("50 of 812 nodes; pass `cursor` or narrow `depth`").
- [ ] **Actionable errors**: `isError: true` explaining what was wrong and how to fix it, with a valid example; no raw stack traces [A][S]. Distinguish "plugin not connected: open Figma and run the Figma Bridge plugin" from "node not found".
- [ ] **Images**: `type: "image"` base64 PNG + `mimeType` for visual verification [S]; cap size, expose `scale`, and for big exports write a file and return its path or a `resource_link`.
- [ ] **Structured output** (`outputSchema` + `structuredContent`) plus text mirror [S].
- [ ] **Accurate annotations**: reads `readOnlyHint:true`; deletes/overwrites `destructiveHint:true`; idempotent setters `idempotentHint:true`; local-only `openWorldHint:false` [S].
- [ ] **Explicit handles for state**, retention stated in the description, clear "expired handle" error [S §Stateful Tools].
- [ ] **Deterministic `tools/list` order**, stable descriptions ([changelog](https://modelcontextprotocol.io/specification/latest/changelog)).
- [ ] **Validate everything server-side** (Zod bounds, path checks) and rate-limit [S §Security].
- [ ] **Evaluate with agents**: realistic multi-step tasks, agentic loop, measure success / tool calls / tokens / errors, let Claude read transcripts and propose fixes [A].

---

## 4. Testing approach

1. **In-process integration tests (vitest).** SDK v2 recipe: `createMcpHandler(createServer)` and a `StreamableHTTPClientTransport` whose `fetch` calls `handler.fetch`; no port. `versionNegotiation: { mode: 'auto' }` exercises 2026-07-28; `InMemoryTransport.createLinkedPair()` covers 2025-era only. Assert `structuredContent` and `isError` (errors are results, not throws). Close client, then handler, in `afterEach` ([docs/testing.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md)).
   ```ts
   const handler = createMcpHandler(() => createServer(fakeBridge));
   const client = new Client({ name: 't', version: '0' }, { versionNegotiation: { mode: 'auto' } });
   await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'),
     { fetch: (u, i) => handler.fetch(new Request(u, i)) }));
   const r = await client.callTool({ name: 'figma_get_node', arguments: { nodeId: 'missing' } });
   expect(r.isError).toBe(true);
   ```
2. **stdio smoke test**: spawn the built bin via `StdioClientTransport` (`@modelcontextprotocol/client/stdio`), list tools, call one. Catches stray stdout writes and bin/shebang breakage ([testing.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md)). Run in CI on Windows, macOS, Linux.
3. **Fake plugin**: a WebSocket client in tests speaking the plugin protocol, to test timeouts, disconnects, auth handshake, cancellation without Figma.
4. **Snapshot `tools/list`** (names, descriptions, schemas, annotations) so tool-surface changes show up in review.
5. **MCP Inspector** for manual checks: `npx @modelcontextprotocol/inspector node ./dist/bin/stdio.js` ([Inspector](https://github.com/modelcontextprotocol/inspector), [SDK stdio doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)). Use a current version: Inspector < 0.14.1 had a DNS-rebinding/CSRF RCE, CVE-2025-49596 ([advisory](https://github.com/modelcontextprotocol/inspector/security/advisories/GHSA-7f8r-222p-6f5g)).
6. **Agent evals** per [A]: scripted tasks on a fixture Figma file, run nightly/manually; track success rate, calls, tokens.
7. Reference practice: [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — each server in `src/<name>` with own `package.json`, `vitest.config.ts`, `__tests__/`; the `everything` server demos every protocol feature for comparison.

---

## 5. Distribution and client config

Publish to npm with a `bin`, so every client runs `npx -y <pkg>` (below: placeholder `figma-bridge-mcp`). `package.json`: `"type":"module"`, `"bin": {"figma-bridge-mcp": "dist/bin/stdio.js"}`, `"files": ["dist"]`, `"engines": {"node": ">=20"}`, shebang in the entry; publish with `--provenance`. Also consider the [MCP Registry](https://github.com/modelcontextprotocol/registry) (`server.json`) and a Claude Desktop extension bundle `.mcpb` ([mcpb](https://github.com/modelcontextprotocol/mcpb)).

**Claude Code** ([docs](https://docs.claude.com/en/docs/claude-code/mcp)):
```sh
claude mcp add figma-bridge -- npx -y figma-bridge-mcp                   # local scope (default)
claude mcp add --scope user figma-bridge -- npx -y figma-bridge-mcp
claude mcp add --scope project figma-bridge -- npx -y figma-bridge-mcp   # writes .mcp.json
claude mcp add --transport http figma-bridge http://127.0.0.1:3333/mcp   # if HTTP entry is used
# native Windows: claude mcp add figma-bridge -- cmd /c npx -y figma-bridge-mcp
```
`.mcp.json` (project, committed):
```json
{ "mcpServers": { "figma-bridge": { "command": "npx", "args": ["-y", "figma-bridge-mcp"] } } }
```

**Claude Desktop** — `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`) ([connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)):
```json
{ "mcpServers": { "figma-bridge": { "command": "npx", "args": ["-y", "figma-bridge-mcp"] } } }
```

**Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), same `mcpServers` shape; HTTP: `{ "url": "http://127.0.0.1:3333/mcp" }` ([Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol)). Offer a one-click install deeplink (`cursor://anysphere.cursor-deeplink/mcp/install?name=...&config=<base64>`).

**VS Code (Copilot agent mode)** — `.vscode/mcp.json`; top-level key is `servers`, not `mcpServers` ([VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)):
```json
{ "servers": { "figma-bridge": { "type": "stdio", "command": "npx", "args": ["-y", "figma-bridge-mcp"] } } }
```
CLI: `code --add-mcp '{"name":"figma-bridge","command":"npx","args":["-y","figma-bridge-mcp"]}'`.

Others use the same command/args: Windsurf `~/.codeium/windsurf/mcp_config.json`; Codex `~/.codex/config.toml` `[mcp_servers.figma-bridge]`.

Architecture note: use stdio as the MCP transport for all clients. Several hosts may run at once (Claude Code + Cursor), each spawning its own stdio process, while the plugin has one WebSocket. Pattern: the first process binds the WS port and becomes the hub; later processes connect to it as relays, or fail with an actionable message naming the port and the owning process.

---

## 6. Security checklist (local server + WebSocket to plugin)

Spec basis: [Streamable HTTP §Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) (MUST validate `Origin`, 403 on invalid; SHOULD bind 127.0.0.1; SHOULD authenticate; "without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites"), [security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices), [tools spec §Security](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

- [ ] **Bind `127.0.0.1`, never `0.0.0.0`**, for the MCP HTTP endpoint (if any) and the plugin WebSocket.
- [ ] **Host header allow-list** (`127.0.0.1:PORT`, `localhost:PORT`) on HTTP and on the WS upgrade; this is the check that defeats DNS rebinding ([SDK http doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)). Use `localhostHostValidation` / `hostHeaderValidationResponse`.
- [ ] **Origin check on the WebSocket upgrade.** Browsers don't apply CORS to WebSockets, so any web page can open `ws://127.0.0.1:PORT` unless the server checks `Origin` (cross-site WebSocket hijacking, [OWASP WebSocket cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)). A Figma plugin UI runs in an iframe with a `null` origin ([Figma: making network requests](https://developers.figma.com/docs/plugins/making-network-requests/)); allow exactly the observed plugin origin and reject all `http(s)://` web origins. Any sandboxed page can also send `null`, so Origin alone is not enough:
- [ ] **Pairing token for the plugin WS**: random 128-bit token generated at start, kept in a user-only file (e.g. `~/.figma-bridge/token`) or shown once for the user to paste into the plugin; required in the first message; constant-time compare; drop unauthenticated sockets after a short timeout.
- [ ] **Auth on any HTTP MCP endpoint** (bearer token as above; full OAuth is meant for remote servers, [authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)). Prefer stdio, which has no network surface.
- [ ] **No `Access-Control-Allow-Origin: *`**; don't answer CORS preflights on MCP/WS endpoints.
- [ ] **Validate messages both ways**: Zod on plugin→server messages, WS `maxPayload`, per-request ids and timeouts, rate limits [S].
- [ ] **File inputs for pptx/PDF import**: canonicalize paths, reject symlink escapes, optional allowed roots (model on [filesystem path-validation.ts](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/path-validation.ts)); parse untrusted files defensively (zip-bomb and entry-count limits for pptx, page/size limits for PDF).
- [ ] **Prompt injection**: Figma text and imported documents are untrusted content returned to the model. Mark mutating tools `destructiveHint:true` so hosts prompt, and ship a `--read-only` mode ([security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)).
- [ ] **Never log secrets**; logs to stderr only; no telemetry by default.
- [ ] **Supply chain**: few runtime deps, lockfile, npm provenance; keep SDK and Inspector current (CVE-2025-49596 shows local dev tooling is a real target).
- [ ] **Don't mark sensitive params with `x-mcp-header`** (values become visible headers) [S].

---

## Sources
- Spec changelog 2026-07-28: https://modelcontextprotocol.io/specification/latest/changelog
- Transports: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports ; https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- TypeScript SDK (v2): https://github.com/modelcontextprotocol/typescript-sdk — docs/testing.md, docs/protocol-versions.md, docs/serving/http.md, docs/serving/stdio.md, docs/servers/tools.md, docs/servers/logging-progress-cancellation.md
- Reference servers: https://github.com/modelcontextprotocol/servers
- Anthropic: https://www.anthropic.com/engineering/writing-tools-for-agents
- Inspector: https://github.com/modelcontextprotocol/inspector
- Clients: https://docs.claude.com/en/docs/claude-code/mcp ; https://modelcontextprotocol.io/docs/develop/connect-local-servers ; https://docs.cursor.com/context/model-context-protocol ; https://code.visualstudio.com/docs/copilot/chat/mcp-servers
