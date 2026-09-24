# 0004. A Scene IR between importers and the Figma renderer

- Status: accepted
- Date: 2026-09-24

## Context

In the prototype each converter emitted ad-hoc JSON and the plugin interpreted it with many special cases. Testing required a live Figma.

## Decision

A versioned, zod-validated **Scene IR**: slides of typed nodes (rect, ellipse, vector, image, text, group) with paints, strokes, per-corner radii, text runs and paragraphs, in slide pixel coordinates. Importers are pure `document → Scene`; the plugin is a Scene renderer; a reference rasterizer renders Scenes in Node for golden and visual tests.

## Consequences

- Importers are testable in CI without Figma: golden Scene JSON + visual diff against the original.
- New sources (Keynote, Google Slides export, HTML) only need a new `→ Scene` importer.
- The IR must stay close to Figma's model to keep the renderer thin; extensions go through an ADR.
