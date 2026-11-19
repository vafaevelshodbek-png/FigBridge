# Reconstructing web UI as editable Figma layers

This experimental workflow targets browser-rendered HTML/CSS applications. It reads
the running browser's actual computed layout; it does not infer screens from JSX
alone or invent product states. Authentication, navigation and fixture setup remain
the calling project's responsibility.

## Capture and import

After building the workspace (`pnpm build`), run the current development plugin in
the intended existing Figma file and check `figbridge status` and `session.info`.
The capture function is self-contained and can be passed directly to Playwright:

```js
import { captureDOM, prepareDOM } from 'figbridge/web/capture';
import { importCapture } from 'figbridge/web/import';
import { writeFile } from 'node:fs/promises';

// page is an authenticated Playwright Page controlled by the caller.
const preparation = await page.evaluate(prepareDOM, { fullPage: true, videoTime: 0 });
// Inspect preparation.warnings; unresolved media invalidates a completeness claim.
const capture = await page.evaluate(captureDOM, {
  name: 'Settings / notifications', fullPage: true,
});
await writeFile('settings.json', JSON.stringify(capture));
await page.screenshot({ path: 'settings.png', fullPage: true, scale: 'css' });
const imported = await importCapture('settings.json', {
  file: 'My existing Figma file', pageId: '0:1',
  key: 'my-app:settings:notifications', x: 0, y: 0,
});
console.log(imported.frameId, imported.warnings, imported.sourceWarnings);
```

Package subpaths `web/capture`, `web/import` and `web/normalize` are shipped with
the package. Capture needs a browser supplied by the caller; Playwright is not a
runtime dependency. The importer uses the normal authenticated local hub and
validated Scene API, including access control and blob transport. The target must
be identified by an explicit expected file name. When several Figma files are open,
only the unique matching session is selected; duplicate file names require an
explicit session id. The active unrelated editor is never used as a fallback.
Asset URLs must be readable by the importing Node process. `assetCache` may map a private/dynamic
URL to a data URL without changing the application. Do not publish captures with
private text, user data or authenticated URLs.

`selector` captures a particular element's complete box instead of the viewport.
`fullPage` increases the exported slide height; scroll descendants are retained
even when outside the visible viewport. `maxNodes` defaults to 30,000 and fails
explicitly on overflow. Capture the full source container for layouts larger than the viewport.
`originalSize` on the importer scales a capture carrying `originalSize.width` to
that original coordinate system. Source image files remain at natural resolution.

## New native operations

- Scene `frame`: nested local coordinates, independent corner radii, fills,
  borders, clipping, overflow direction, native shadows/blur, alpha masks and
  blend modes. `component: true` creates a native Figma Component.
- Scene `svg`: validated, self-contained SVG imported as editable vectors;
  scripts, event handlers, foreignObject and external hrefs are rejected.
- Scene text supports native text shadows. Browser lines use intrinsic sizing to
  avoid a second native wrap caused by small font metric differences.
- `page.ensure {name, renameId?, maxPages?}` reuses an existing named page or
  safely renames the explicitly identified page, preserving children. Creating a
  page beyond the default maximum of three fails. It never deletes pages.
- `scene.render {slide, parentId?, sourceKey?, strict?}` tags owned results by
  source key. Repeating a key replaces only the matching owned frame in that
  parent. Its position is preserved. Multiple matching keys are an explicit
  error. A strict render with warnings discards the staged result and preserves
  the previous frame. Cancellation removes staged slide content.
- `session.info` includes the plugin source fingerprint and capability list,
  allowing a client to distinguish the live bundle from files merely built on disk.
- Nodes carry `figbridge.sourceId` and optional `figbridge.source` plugin data,
  exposed in node summaries for source reconciliation.

Capture also resolves generic browser fonts by actual metrics, normalizes variable
font family names, expands zero-length SVG round dashes into vector circles,
reconstructs axis-aligned mirroring and root SVG transforms, and matches CSS
premultiplied transparent gradient ends. CSS masks isolate descendant blending.
Image colour filters are baked only into the original individual image at its
natural resolution. Whole-screen screenshots are never used as UI layers.

Masked content is explicitly grouped inside its mask scope, including the original
frame background and nested frames. This prevents Figma from applying a mask only
to a background rectangle while letting nested images escape. CSS pseudo elements
retain their stacking order relative to text and other children. HTML input values
and placeholders retain alignment and letter spacing. Repeating linear gradients
are expanded using the measured gradient axis length.

The native renderer yields through UI messages every 25 nodes. This keeps large
imports responsive without relying on background-window timers, which may be
throttled heavily. `session.info` advertises `scene.cooperativeYield`. Batch callers
may set `requireUnrestricted: true` to stop before a write when access resets or
the plugin is paused. Access is intentionally not persisted across plugin reloads.

Loaded video graphics are captured as individual decoded frames at their natural
resolution, with source URL and timestamp retained. Unloaded video emits a warning;
the result represents a static moment and does not reproduce playback.
For a video that has never played and still displays its poster, capture retains
the original poster image rather than a transparent decoded frame. Image/video
`object-fit: cover` and percentage/keyword `object-position` produce an explicit
source-image crop, preserving the original pixels.

`prepareDOM` is an opt-in asynchronous browser helper; `captureDOM` remains
synchronous. The helper waits for fonts and image decode, briefly visits page
sections to trigger the application's own lazy loaders, restores the original
scroll position and image loading attributes, and prepares static video media.
`timeoutMs` defaults to 10 seconds; `maxScrollSteps` defaults to 100. Failures and
bounded-scroll exhaustion are reported. It pauses loaded videos by default;
`pauseVideos: false` leaves playback active and `videoTime` is optional. It does
not prove readiness of application data or reproduce unbounded infinite scroll.

Fresh captures carry computed CSS stacking-context metadata. Positioned contexts
are lifted through verified nonstacking, unclipped, effect-free ancestors to their
actual paint parent, retaining measured coordinates and source IDs. This allows a
high-z-index guide inside an application root to appear above a portal modal.
Descendants remain inside real isolation/opacity/transform contexts. Clipping or
effect boundaries are retained conservatively. Legacy captures lacking this
metadata need recapture or an explicitly documented source-backed migration;
their correct global stacking cannot be inferred from DOM hierarchy alone.

## Verification and limits

To run the synthetic browser regression cases, install Playwright and its Chromium
in a directory of your choice, then pass that directory to:

```bash
node packages/figbridge/scripts/capture-browser-check.mjs /path/to/playwright-project
```

This check does not need Figma, an application, or credentials.

Always export the actual imported Figma frame and compare it to the corresponding
browser screenshot. Successful RPCs and the reference Scene rasterizer do not
prove visual fidelity. The reference renderer does not emulate all native effects,
mask compositing, SVG importer behaviour or blend modes.

By default capture finishes finite CSS/Web Animations and pauses infinite ones so
the measured nodes and the following screenshot share one state. `stabilize: false`
keeps the instantaneous animation state when a caller explicitly needs it. JavaScript
canvas animations and asynchronous application data still require caller control.

The browser extractor preserves fixed geometry; it does not infer responsive Auto
Layout or reusable instance relationships. A library may create native Components,
while captured screen occurrences remain editable native frames. Fonts must be
available to Figma; substitutions and overflow are reported. Small rasterization
and font-metric differences remain possible even with the same family.

CSS backdrop saturation, arbitrary rotated/skewed HTML containers, complex
non-decorative pseudo elements and unsupported background grammars require review
and emit capture warnings. Canvas graphics are retained as separate raster layers,
not editable drawing commands. SVG text follows Figma's SVG importer semantics.
Asynchronous content must be ready before capture and screenshot; a changed state
invalidates a pixel comparison.
Full-page capture uses document coordinates, including the current scroll offset;
viewport capture uses viewport coordinates. Mixing those coordinate systems shifts
fixed dialogs and is covered by a browser regression test. Pixel comparison offers
`includeAlpha: true`; its historical default remains RGB-only. A resized comparison
is diagnostic only and does not validate matching export dimensions. Figma SVG
fallback verification can use a browser SVG renderer because a generic SVG rasterizer
can omit image patterns and produce a misleading diff. The export basis remains
recorded separately from native Figma PNG verification.
`node.export` also accepts a bounded `rasterTimeoutMs` (100–60,000 ms), leaving the
existing 15-second default intact. A timed-out native PNG export still returns SVG
with its true MIME type. A comparison must record that fallback instead of claiming
it was a native raster export.
