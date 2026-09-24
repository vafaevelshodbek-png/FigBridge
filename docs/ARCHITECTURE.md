# Architecture

figbridge lets AI agents read and write a Figma Desktop file through a Figma plugin, and converts slide decks (PDF, PPTX) into **editable** Figma layers. This document is the map; decisions and their rationale live in [`docs/adr/`](adr/), research that informed them in [`docs/research/`](research/).

## Goals

1. **Agent-first.** Every capability is an MCP tool with a precise schema, small responses, actionable errors.
2. **Editable output.** Imported slides are real Figma primitives — frame fills, rectangles with radii, vectors, image fills, text with runs — never a flattened picture of the page.
3. **Verifiable.** Every conversion can be checked against the original by an automatic visual diff.
4. **Safe by default.** Localhost only, pairing token, no arbitrary code execution, untrusted input handled defensively.
5. **Portable and license-clean.** Windows, macOS, Linux. MIT, and every runtime dependency permissively licensed.

Non-goals: running without Figma Desktop; round-tripping Figma back to PPTX; OCR of scanned decks (v1).

## System overview

```
 ┌──────────────┐  stdio (MCP)   ┌──────────────────────────────┐   WebSocket    ┌────────────────────────┐
 │  AI client   │ ─────────────▶ │  figbridge (Node process)    │ ◀────────────▶ │  Figma Desktop          │
 │ Claude Code, │                │  • MCP server (tools)        │  ws://127.0.0.1 │  figbridge plugin       │
 │ Cursor, …    │ ◀───────────── │  • Hub: sessions, routing    │   :7331         │  ui.html  ⇄  code.js    │
 └──────────────┘                │  • Importers: PDF, PPTX      │                 │  (iframe)   (sandbox)   │
        ▲                        │  • CLI                       │                 └────────────────────────┘
        │ shell                  └──────────────────────────────┘
        └──── figbridge <cmd> ─────────▲ (CLI talks to the same hub over HTTP on 127.0.0.1)
```

- **Hub.** One process owns port 7331 (PID lockfile). Additional MCP processes started by other clients detect the owner and relay to it, so several agents can share one plugin connection.
- **Plugin.** Two halves, as Figma requires: `ui.html` holds the WebSocket and reassembles binary blobs; `code.js` runs the Plugin API. They talk through `postMessage` using the same envelope.
- **Importers.** Pure functions `document → Scene`. They never talk to Figma. The hub sends the Scene to the plugin, which renders it.

## Packages (pnpm workspace)

| Package | Responsibility | Depends on |
|---|---|---|
| `@figbridge/protocol` | Wire envelope, method catalog, error codes — zod schemas and inferred types | zod |
| `@figbridge/scene` | Scene IR: the editable layer tree (frames, rects, ellipses, vectors, images, text, groups); validation; reference rasterizer for tests | zod, @napi-rs/canvas (dev/test) |
| `@figbridge/import-pdf` | PDF → Scene via pdf.js operator lists: paint order, clips, soft masks, shadings, images, text | pdfjs-dist, @napi-rs/canvas |
| `@figbridge/import-pptx` | PPTX → Scene via OOXML: inheritance master → layout → slide, theme colors, text runs, tables, charts | fflate, fast-xml-parser |
| `@figbridge/plugin` | Figma plugin: transport client, Scene renderer, read/write handlers | @figma/plugin-typings (types only) |
| `figbridge` | CLI + MCP server + hub | all of the above, ws, @modelcontextprotocol/server, commander, pino |

Dependency rule: `protocol` and `scene` depend on nothing internal; importers depend on `scene`; `plugin` depends on `protocol` and `scene` types; `figbridge` depends on everything. No cycles, enforced in CI.

## The Scene IR

The contract between importers and the renderer. Coordinates are in slide pixels (1920×1080 by default), top-left origin. Every node:

```ts
interface NodeBase { id: string; name: string; x: number; y: number; w: number; h: number;
                     rotation?: number; flipX?: boolean; flipY?: boolean; opacity?: number; visible?: boolean }
type SceneNode =
  | RectNode      // fills, strokes, cornerRadii [tl,tr,br,bl]
  | EllipseNode
  | VectorNode    // SVG path data + fill rule, fills/strokes
  | ImageNode     // blob ref, scale mode, crop, corner radii
  | TextNode      // characters + style runs + paragraphs
  | GroupNode;    // children
interface Slide { name: string; width: number; height: number; background: Paint[]; children: SceneNode[] }
```

Paints: solid, linear/radial gradient, image. Images travel as **blob references**, never inline base64 in the tree. The schema is versioned; the plugin rejects unknown major versions.

## Wire protocol (v1)

JSON text frames with a shared envelope; binary frames for blobs. Full spec: [`docs/protocol.md`](protocol.md).

```jsonc
{ "v": 1, "id": "01J…", "type": "req", "method": "scene.render", "params": { … }, "session": "s_7f3a" }
{ "v": 1, "id": "01J…", "type": "res", "ok": true, "result": { … } }
{ "v": 1, "id": "01J…", "type": "res", "ok": false, "error": { "code": "FONT_MISSING", "message": "…", "retryable": false } }
{ "v": 1, "type": "evt", "event": "progress", "data": { "id": "01J…", "done": 3, "total": 36 } }
{ "v": 1, "id": "01J…", "type": "cancel" }
```

- Handshake `hello` (plugin: token, supported versions, file name, editor type, instance id) → `welcome` (chosen version, session id, heartbeat, max chunk).
- Sessions: one per open file. Calls without a session work only when exactly one session exists; otherwise `AMBIGUOUS_SESSION` with the list.
- Timeouts from one table, innermost shortest; cancellation propagates to the plugin, which checks between nodes.
- Heartbeat: server ping every 20 s, drop after ~60 s; client reconnects with jittered exponential backoff and re-binds its session.
- Idempotency keys on mutating requests, so a retry after reconnect never duplicates a slide.

## Security model

- Listen on `127.0.0.1` only. Reject requests whose `Host` is not a loopback name (DNS rebinding).
- WebSocket upgrade accepts only `Origin: null` (Figma plugin iframe) **and** a valid pairing token in `hello`. The token is generated per install, stored in the user config dir with user-only permissions, shown once in the plugin UI for pairing.
- The plugin executes a fixed method catalog. There is no `eval` / "execute arbitrary code" method.
- Message size caps; binary blobs chunked with acks; file paths for imports are resolved and checked.
- `--read-only` mode disables every mutating method.
- Documents are untrusted: parsers are bounded (page count, object count, image size, recursion depth, decompression size).

## Import pipelines

**PDF** (`@figbridge/import-pdf`): pdf.js `getOperatorList` gives the paint-ordered stream with graphics state, clip paths, soft masks, transparency groups, shadings, images and text. An interpreter replays it into a flat list of primitives with resolved transforms, clips and effective opacity. Recognizers then lift primitives into Scene nodes:
rounded rectangles (per-corner radii), vectors (with even-odd rule and glyph merging), gradients, **photo regions** (rendered by pdf.js with only image operators enabled — no redaction hacks), text paragraphs (line grouping, ligature repair), and **card grouping** by geometric containment and paint order.

**PPTX** (`@figbridge/import-pptx`): OOXML parsing with full inheritance (slide → layout → master → theme), color transforms, preset and custom geometry, pictures (crop, SVG blip), text (runs, bullets, line spacing, autofit as stored), tables, charts (native bars; others rasterized through LibreOffice when available).

Both are **deterministic**: same input, same Scene. Heuristic thresholds are named constants with a comment explaining the evidence.

## Verification

- Golden Scene snapshots (JSON) for every corpus document — any behavioral change shows up in review.
- Visual diff: Scene is rasterized by `@figbridge/scene`'s reference renderer and compared with the original (pdf.js render for PDF, LibreOffice → PDF → pdf.js for PPTX) with per-region SSIM. Reports list the worst slides.
- Live check in Figma (manual/nightly): the same diff against Figma's own export.

## Error model

A single `BridgeError { code, message, retryable, data?, cause? }`. Codes are a closed union in `@figbridge/protocol`. The CLI maps them to exit codes; MCP returns `isError: true` with a message that tells the agent what to do next.

## Repository layout

```
packages/{protocol,scene,import-pdf,import-pptx,plugin,figbridge}/
  src/  test/  README.md  package.json  tsconfig.json
docs/ ARCHITECTURE.md  protocol.md  adr/  research/
corpus/          redistributable test documents (+ MANIFEST.json); others stay local-only
.github/         CI, issue forms
```
