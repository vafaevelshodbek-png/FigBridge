# 03 — Figma Plugin API constraints and transport design

Status: research note, 2026-09-24. Claims marked **[verified]** were checked against the linked page in this session. Claims marked **[docs, not re-checked]** come from the linked doc page but were not re-read today. Re-check those before relying on them.

## A. Figma Plugin API constraints

### A1. Manifest
Source: https://developers.figma.com/docs/plugins/manifest/ **[verified]**

- `networkAccess.allowedDomains` accepts `["none"]`, `["*"]` or a list of patterns (`example.com`, `*.example.com`, `api.example.com/rest/get`). The schemes `http`, `https`, `ws` and `wss` are all allowed.
- `networkAccess.devAllowedDomains` lists domains that only work while the plugin runs in development. Put `http://localhost:3333` and `ws://localhost:3333` here. Also list `127.0.0.1` separately, because the host has to match literally.
- `networkAccess.reasoning` is required if you use `"*"` or localhost entries in `allowedDomains`. A published build that talks to a local server needs localhost in `allowedDomains` and a reasoning string.
- `documentAccess: "dynamic-page"` is required for new plugins, and it means no additional page loads happen when the plugin runs. The consequence is that you must use the async APIs (A3).
- `editorType` accepts `figma`, `figjam`, `dev`, `slides` and `buzz`. `figjam` and `dev` cannot be combined. For our case use `["figma","slides"]`, and add `figjam` if needed.
- `relaunchButtons` only show when every selected node has relaunch data with the same `command`.
- Note: the network allowlist is enforced through CSP on the UI iframe. The main thread has no `fetch` to arbitrary hosts, so all I/O goes through the UI. https://developers.figma.com/docs/plugins/making-network-requests/ **[docs, not re-checked]**

### A2. Figma Slides differences
Source: https://developers.figma.com/docs/plugins/working-in-slides/ **[verified]**

- Node types: `SLIDE` (fixed 1920×1080), `SLIDE_ROW`, `SLIDE_GRID` and `INTERACTIVE_SLIDE_ELEMENT`. `SLIDE_GRID` is the top-level container and cannot be selected or edited in the UI.
- Create slides with `figma.createSlide()` and `figma.createSlideRow()`, not with `createPage`. Reorder them with `getSlideGrid()` / `setSlideGrid()`, which work on a 2D array.
- Components, styles, variables and libraries are unavailable. So are `createConnector`, `createCodeBlock` and `createSection`.
- `createShapeWithText`, `createTable` and `createGif` are available.
- Importer implication: branch on `figma.editorType`. In a Slides file, write one pptx slide into one `SLIDE` and treat `SLIDE` like `FRAME` wherever the code checks `node.type`. In a Design file, create one frame per slide, 1920×1080, on a page.

### A3. Async APIs (required under dynamic-page)
- Use `figma.getNodeByIdAsync`, `page.loadAsync()`, `figma.loadAllPagesAsync()` and `setCurrentPageAsync`. The sync variants throw under `dynamic-page`. https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/ **[docs, not re-checked]**
- Call `figma.loadFontAsync(fontName)` before you change `characters` or any font-dependent property. Missing fonts throw an error. `figma.listAvailableFontsAsync()` returns the installed families, and we use that list to build a fallback map (for example, "Calibri" becomes "Inter"). https://developers.figma.com/docs/plugins/api/properties/figma-loadfontasync/ , https://developers.figma.com/docs/plugins/working-with-text/ **[docs, not re-checked]**

### A4. Images and SVG
- `figma.createImage(bytes)` accepts PNG, JPEG or GIF. The maximum size is 4096 px on each side. It throws "Image is too small", "Image is too large" or "Image type is unsupported". https://developers.figma.com/docs/plugins/api/properties/figma-createimage/ **[verified]** The importer should downscale in the UI iframe with OffscreenCanvas before sending, or tile the image. EMF/WMF/TIFF from a pptx has to be rasterized on the server first.
- `figma.createImageAsync(url)` loads the image in the UI context, so it is also subject to the allowlist. https://developers.figma.com/docs/plugins/api/properties/figma-createimageasync/ **[docs, not re-checked]**
- `figma.createNodeFromSvg(svg)` returns a FRAME. It does not support every SVG feature (filters, some masks, `<foreignObject>` and CSS stylesheets are known gaps from forum reports), and a malformed string throws. Wrap each call in try/catch and fall back to a raster image. https://developers.figma.com/docs/plugins/api/properties/figma-createnodefromsvg/ **[docs, not re-checked]**

### A5. postMessage between UI and main thread
- `figma.ui.postMessage` / `parent.postMessage({pluginMessage}, '*')` uses structured clone. `Uint8Array` is transferred efficiently, so send images as bytes, not base64. https://developers.figma.com/docs/plugins/creating-ui/ **[docs, not re-checked]**
- There is no documented size limit. Community reports say that messages of tens of MB stall the editor. Our design choice: keep each message at 1–4 MB or less and send images one by one. We did not find an official source for a specific limit, so treat this as an empirical rule.

### A6. Performance with many nodes
- Set `figma.skipInvisibleInstanceChildren = true` to speed up traversal. https://developers.figma.com/docs/plugins/api/properties/figma-skipinvisibleinstancechildren/ **[docs, not re-checked]**
- `figma.commitUndo()` sets an undo checkpoint. Call it once per slide so that one Ctrl+Z undoes one slide, not thousands of operations. https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/ **[docs, not re-checked]**
- Practical rules, taken from the plugin performance guidance at https://developers.figma.com/docs/plugins/accessing-document/ **[docs, not re-checked]**:
  - Build the node under its final parent. Do not create it on the page and reparent it afterwards.
  - Set properties before you append children to auto-layout frames.
  - Avoid `figma.group` in loops, because each call recomputes bounds. Use frames with `clipsContent=false`.
  - Load fonts once per unique font, not once per node.
  - Yield between slides (`await new Promise(r=>setTimeout(r,0))`) so that the UI keeps responding and the heartbeats still go out.
- Text: use `setRangeFontName`, `setRangeFontSize`, `setRangeFills`, `setRangeListOptions` and `setRangeIndentation`, plus `listSpacing` and `paragraphSpacing`. `lineHeight` is `{unit:'PIXELS'|'PERCENT'|'AUTO', value}`. pptx `spcPct` maps to PERCENT. https://developers.figma.com/docs/plugins/api/TextNode/ **[docs, not re-checked]**
- `relativeTransform` is a 2×3 matrix relative to the parent. Use it for pptx `rot` and `flipH/V` instead of `rotation`, which rotates around the top-left corner. https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/ **[docs, not re-checked]**

### A7. UI iframe lifecycle and throttling
- The plugin's UI is a Chromium iframe inside Figma Desktop (Electron). When the window is hidden, minimized or backgrounded, Chromium throttles timers in hidden or background frames to at most once per second, and to once per minute under intensive throttling. https://developer.chrome.com/blog/timer-throttling-in-chrome-88 **[docs, not re-checked]** As a result, `setInterval` polling is delayed and JS heartbeats arrive late. An open WebSocket still receives messages, but a server that requires a pong within about 5 s will drop the connection.
- Mitigations:
  - Allow at least 60 s of heartbeat tolerance on the server.
  - Let the server send pings, so the browser answers ws protocol pings automatically without any JS timer.
  - Create the UI with `figma.showUI(__html__, {visible:false})` if you want it hidden. It still runs.
  - Reconnect when `visibilitychange` fires.
- The plugin stops on `figma.closePlugin()` or when the user closes it. Nothing keeps it alive between sessions. Dev plugins can be restarted with "Run last plugin" (Ctrl+Alt+P). Figma Desktop's hot reload of a dev plugin ("Hot reload plugin" in the Plugins > Development menu) reloads it when `main`/`ui` changes. https://developers.figma.com/docs/plugins/plugin-quickstart-guide/ **[docs, not re-checked]**

### A8. Tooling
- Typings: `@figma/plugin-typings`. https://www.npmjs.com/package/@figma/plugin-typings , https://github.com/figma/plugin-typings
- Lint: `@figma/eslint-plugin-figma-plugins` catches deprecated sync APIs under dynamic-page. https://github.com/figma/eslint-plugin-figma-plugins
- Build: esbuild produces two bundles. `code.ts` builds to `code.js` (target `es2017`; the main thread is a sandbox with no DOM). `ui.ts` is inlined into `ui.html`, because the manifest `ui` field points to a single HTML file. The official samples are at https://github.com/figma/plugin-samples (see the esbuild-react sample). The main-thread sandbox lacks some modern syntax and APIs, so check the target and avoid relying on `structuredClone`, `TextDecoder` and similar in `code.ts`.

## B. Transport design

### B1. Choosing the transport
| Option | From a Figma iframe (origin `null`) | Server → plugin push | Verdict |
|---|---|---|---|
| WebSocket | Works if `ws://localhost:PORT` is in `devAllowedDomains`/`allowedDomains` (A1). The browser sends `Origin: null`. | Native, full-duplex | **Choose this** |
| HTTP long-poll | Works. Needs CORS `Access-Control-Allow-Origin: *` or `null`. | Emulated, 1 RTT extra, and suffers from timer throttling | Fallback |
| SSE | Works over `http:`. Down + a separate POST up. | Yes | Adds nothing over WS here |

The current bridge polls on :3333 (see memory note figma-bridge-setup). Moving to WS removes the latency from polling and the stalls caused by throttling (A7).

**Server library:** Node 22 ships a global `WebSocket` **client** (stable in Node 22.4). https://nodejs.org/en/blog/announcements/v22-release-announce **[docs, not re-checked]** Node has no built-in WebSocket **server**, so use `ws`. https://github.com/websockets/ws `ws` also provides `maxPayload`, `perMessageDeflate` (turn it off for image bytes), `verifyClient`/`handleUpgrade` for origin and token checks, and ping/pong.

### B2. Security for a localhost server
- Bind to `127.0.0.1` only, never `0.0.0.0`.
- **DNS rebinding:** check that the `Host` header is exactly `127.0.0.1:PORT` or `localhost:PORT`. Otherwise reply 403. https://github.com/modelcontextprotocol/typescript-sdk (the MCP SDK added host validation after a DNS-rebinding advisory), https://en.wikipedia.org/wiki/DNS_rebinding
- **Origin:** a real Figma plugin UI sends `Origin: null`. Allow `null` and reject any `http(s)://` origin, so ordinary web pages cannot connect. `null` can be spoofed from a sandboxed iframe on a malicious page, so the Origin check alone is not enough.
- **Pairing token:** the server generates 128 random bits at startup and prints them to its stdout and to a file readable only by the user (`~/.figma-bridge/token`). The agent reads the token from that file. The plugin UI gets it through a one-time manual paste, or the server shows a 6-digit code and the plugin UI displays the same code for the user to confirm. Send the token in the first `hello` message, not in the URL, because URLs end up in logs.
- Set `maxPayload` (for example 32 MB). Limit to one pending handshake per socket and close the socket if `hello` does not arrive within 5 s.

### B3. Proposed protocol (v1)
There are two legs: agent ↔ server (HTTP/MCP) and server ↔ plugin (WS). Main-thread ↔ UI messages reuse the same envelope unchanged.

Envelope (JSON text frames):
```json
{ "v": 1, "id": "01J9…", "type": "req", "method": "nodes.create", "params": {…}, "session": "s_7f3a" }
{ "v": 1, "id": "01J9…", "type": "res", "ok": true,  "result": {…} }
{ "v": 1, "id": "01J9…", "type": "res", "ok": false, "error": { "code": "FONT_MISSING", "message": "…", "data": {…}, "retryable": false } }
{ "v": 1, "type": "evt", "event": "selection.changed", "data": {…} }
{ "v": 1, "id": "01J9…", "type": "cancel" }
{ "v": 1, "id": "01J9…", "type": "progress", "done": 40, "total": 312 }
```
Why this shape: it is JSON-RPC-like with correlation ids (ULIDs, which sort by time for log grepping). An explicit `type` avoids guessing what a message is, and `retryable` lets the agent decide whether to retry. We do not use raw JSON-RPC 2.0 because we need `progress`/`cancel` and binary chunks. The MCP protocol uses the same notification pattern. https://www.jsonrpc.org/specification , https://modelcontextprotocol.io/specification

Handshake:
```json
// plugin → server, first frame
{ "v":1, "type":"hello", "token":"…", "protocol":[1], "plugin":{"version":"0.4.0"},
  "file":{"key":"abc123|null","name":"Deck.fig","editorType":"slides"}, "instance":"i_rand" }
// server → plugin
{ "v":1, "type":"welcome", "protocol":1, "session":"s_7f3a", "maxChunk":1048576, "heartbeatMs":20000 }
```
- `figma.fileKey` is only available to private or dev plugins with `enablePrivatePluginApi`, and is otherwise undefined. https://developers.figma.com/docs/plugins/api/figma/#filekey **[docs, not re-checked]** So always send `instance` (a random id) together with `file.name`.
- Protocol negotiation: the plugin sends the list of versions it supports, and the server picks the highest version both sides support. If there is none, the server replies with an `error` of `PROTOCOL_UNSUPPORTED` that includes an upgrade hint.

Multiple instances: the server keeps a `Map<session, socket>`. `GET /sessions` returns `[{session, file, editorType, connectedAt, lastSeen}]`. Every agent call carries `session`. If `session` is missing and exactly one session exists, the server uses it. If there are several, it returns the error `AMBIGUOUS_SESSION` with the list, and the agent chooses. We deliberately do not use "last focused wins", because it silently writes into the wrong file.

Large payloads (images):
- Send binary WS frames: a header of 4-byte length + JSON `{id, blob, seq, last}`, followed by the raw bytes. Chunks are at most 1 MB. The request refers to images by `blob` id, and the plugin puts the pieces together before calling `createImage`. This avoids base64's 33% overhead and the double copy through the JSON parser.
- Alternative: the plugin fetches `GET http://127.0.0.1:PORT/blob/:id?t=token` itself. That is simpler and also allowed by `devAllowedDomains`.
- Backpressure: the server checks `ws.bufferedAmount` and waits for per-chunk acks, allowing at most 4 MB in flight. On the plugin side, the main-thread queue processes one slide at a time and sends a `progress` event after each.

Timeouts, cancellation, heartbeat:
- Each request has a `timeoutMs`, 30 s by default and longer for `import.*`. On timeout the server sends `cancel`. The plugin checks a cancel flag between nodes and calls `commitUndo` at the point where it stopped.
- The server sends a ws ping every 20 s and closes the connection after 3 missed pongs, which is about 60 s and tolerates throttling (A7).
- The client reconnects with exponential backoff and full jitter (base 500 ms, cap 10 s). https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ After reconnecting it sends `hello` again with the same `instance`. The server rebinds the session, and in-flight requests are failed with `retryable:true`.
- Idempotency: mutating requests may carry `idempotencyKey`. The plugin stores the results of the last N keys in memory, so a retry after a reconnect does not create a slide twice.

Schema validation: use **zod** (v4 has `z.toJSONSchema`, and MCP tool schemas come from it) or **valibot** (much smaller bundle for the UI iframe). https://zod.dev , https://valibot.dev , https://github.com/sinclairzx81/typebox (fastest when compiled, and JSON Schema-native). Recommendation: TypeBox or zod on the server. In the plugin, validate only the envelope and method names with a small hand-written guard, which keeps `code.js` small. Keep one shared `protocol.ts` for the types.

Error codes (initial set): `UNAUTHORIZED`, `PROTOCOL_UNSUPPORTED`, `AMBIGUOUS_SESSION`, `NO_SESSION`, `TIMEOUT`, `CANCELLED`, `NODE_NOT_FOUND`, `FONT_MISSING`, `IMAGE_TOO_LARGE`, `UNSUPPORTED_IN_EDITOR` (for example `createSection` in Slides), `VALIDATION`, `INTERNAL`.

## Open questions / to verify
1. The real postMessage size ceiling in Figma Desktop. Measure it empirically: 1, 8 and 32 MB Uint8Array.
2. Does Figma Desktop throttle the plugin iframe when the window is minimized? Test by logging the ws ping/pong gap.
3. Whether a `127.0.0.1` entry is accepted in `allowedDomains` for a published (non-dev) plugin.
