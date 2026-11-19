# Import browser screens into Figma

The web workflow measures a running page and creates native Text, Frames,
supported SVG vectors and image assets through the existing Scene renderer.
It does not flatten a whole screen into an image.

In a source build, use `node packages/figbridge/dist/cli.mjs` wherever the examples use `figbridge`. Install Chromium once after installing the package:

```sh
npx playwright install chromium
```

Capture a page without a Figma connection:

```sh
figbridge web capture https://example.com --out ./captures/example
```

Import into an explicitly selected, connected file:

```sh
figbridge web import https://example.com --file "Web to Figma" --session SESSION_ID --out ./captures/example-import
```

Use a new output directory for each job. The importer verifies the exact file
name, active session and unrestricted plugin access before capture, then again
before every screen write. Existing frames are retained. New screens are placed
in a grid below existing content; `--x`, `--y`, `--columns` override placement.

## Browser states and known flows

`--explore` discovers bounded same-origin links, menu/tab/details controls,
hover and scroll states, including nested and horizontal scroll containers. Set `--max-states`, `--max-depth`, `--max-actions` and
`--max-scroll-steps`. Unknown buttons, known destructive controls and form
submissions are blocked and recorded. Application POST requests needed to load
data remain allowed. DOM labels cannot prove absence of every server side effect.

For a known flow, provide `--flow flow.json`:

```json
[
  {"name":"Open menu","steps":[{"action":"click","selector":"#menu"}]},
  {"name":"Second tab","steps":[{"action":"click","role":"tab","name":"Details"}]}
]
```

Recipes use click, hover, fill, select, press, scroll and wait actions. Submission
and known destructive activation remain blocked. Each branch is replayed from
the root URL. Client storage and server databases are not reset automatically;
use test data/reset fixtures for applications whose state changes between visits.
Scroll recipes accept `selector` or `role`/`name` and `x`/`y` offsets; without a
target they scroll the window. An x-only action leaves vertical scroll unchanged.
Exploration requires HTTP(S). Local file URLs support single-screen capture.

## Authentication and browser ownership

The default is a separate headless browser context. `--storage-state PATH` loads
an explicitly provided Playwright state file. `--cdp URL` explicitly attaches to
a Chromium endpoint and opens a new page in its existing context; existing pages
are not closed. `--channel chrome` or `--channel msedge` can use an installed
browser. Do not place authentication state files in a repository.

## Artifacts, verification and losses

Every accepted state has native `.capture.json`, a matching `.reference.png`,
and optional `.cdp.json`. Image resources are embedded in the capture's assetCache.
`manifest.json` records source URL, recipes, state/edge status, budgets, warnings,
and imported Figma node IDs. Failed jobs retain partial artifacts and explicit
status. Coverage never claims every possible state of an unknown application.

`--selector CSS` captures a subtree; `--viewport-only`, `--width`, `--height`,
`--color-scheme`, and `--locale` set the capture environment. Original password
input values are masked in the Scene and redacted from diagnostic snapshots.
Other visible content and authenticated assets are local capture data and may
be private. Review artifacts before sharing them.
Fill values in saved/returned recipes and edges are redacted; keep the original
explicit flow file privately when a replay needs those inputs. A manifest is not
a credential store. With `captureCdp: false`, closed-shadow diagnostics are disabled.

`--strict` rejects source/preparation warnings before importing any state and
also enables the renderer's font/overflow checks. Non-strict mode returns losses
for review. Canvas/video remain separate raster assets; closed shadow roots,
complex clip paths, transformed frame rendering and private CORS-blocked assets require
review. CORS failures are explicit rather than replaced with hidden screenshots.
Generated CSS content uses measured Chromium pseudo-element boxes: supported
single-line text stays Text, SVG backgrounds and simple border triangles stay
vectors. Unsupported generated content, effects and sizing retain review warnings.
Viewport captures prune fully invisible paint/resources while retaining visible
fixed and overflowing descendants. Document captures preserve the browser's opaque
canvas; subtree captures retain their own transparency.
Public HTTP(S) assets blocked by browser CORS can use anonymous bounded streaming
fetch. Browser cookies/auth headers are not copied to that fallback. It follows
at most five HTTP(S) redirects, with byte/time limits and loop detection.

The current native output preserves measured absolute geometry. Auto Layout,
inferred reusable components, variants, variables and prototype links are not
part of this renderer contract yet. Compare an actual native Figma export with
the reference PNG; a successful import is not proof of pixel equality.

Saved captures can be imported offline:

```sh
figbridge web import-capture ./captures/example/001.capture.json --file "Web to Figma" --session SESSION_ID --strict
```

MCP exposes `figma_capture_web` and `figma_import_web` with the same options
(`outDir`, `file`, `session`, `explore`, `recipes`, bounds and strict). Both
workflows are also exported as `captureWebsite` and `importWebsite`. Browser
adapters are available at `figbridge/web/browser` and `figbridge/web/explore`.

## Checks

```sh
pnpm check
node packages/figbridge/scripts/capture-browser-check.mjs packages/figbridge
node packages/figbridge/scripts/browser-adapter-check.mjs
node packages/figbridge/scripts/test-web-explore.mjs
node packages/figbridge/scripts/test-viewport-clip.mjs
node packages/figbridge/scripts/test-canvas-background.mjs
node packages/figbridge/scripts/test-object-fit.mjs
node packages/figbridge/scripts/test-browser-font-stack.mjs
node packages/figbridge/scripts/pseudo-capture-check.mjs
node packages/figbridge/scripts/browser-pseudo-adapter-check.mjs
pnpm -F figbridge smoke
```

Capture output requires a new or empty directory. Each job exclusively reserves it
before opening Chromium; existing files are preserved and concurrent jobs targeting
the same directory are rejected. Failed jobs retain their partial artifacts. A
process killed without cleanup can leave `.web-capture.lock`; inspect the directory
and use a new empty destination for the next capture.

Browser captures import materialized data-URL assets, either already inline in the
capture or resolved from their capture cache.
A missing/rejected asset fails import even in non-strict mode, without retrying its
original URL. Legacy standalone captures may fetch original URLs, with redirects
rejected, a shared 15-second asset deadline, 8 MiB per asset and 32 MiB total
streamed input limits.
