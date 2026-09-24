# 0001. One language (TypeScript) and a license-clean dependency stack

- Status: accepted
- Date: 2026-09-24

## Context

The prototype used Node for the bridge and Python + PyMuPDF for PDF import. PyMuPDF/MuPDF is **AGPL-3.0**: shipping it makes the combined work AGPL, which contradicts our MIT license and scares off companies. Poppler, pdf2htmlEX and mutool are GPL/AGPL too (research 04). Two languages also mean two toolchains, two CI jobs and a schema-drift problem between TS and Python models.

## Decision drivers

- MIT distribution with permissive runtime dependencies only.
- Access to the full PDF paint model: clip paths, soft masks, transparency groups, shadings, images, text.
- One toolchain, one type system for the Scene IR shared by importers and the plugin.

## Options

1. Keep Python, switch to pypdfium2 (Apache/BSD) + pikepdf (MPL) — PDFium hides soft masks, shading parameters and groups; would need raw-object parsing on top.
2. **pdf.js (`pdfjs-dist`, Apache-2.0) in Node** — `getOperatorList` exposes every paint operator with arguments, including groups, soft masks and gradient stops; it can also render subsets of operators to a canvas.
3. PDFBox (Apache-2.0) — complete, but adds a JVM.

## Decision

Option 2. The whole project is TypeScript: pdf.js for PDF, `fflate` + `fast-xml-parser` (MIT) for OOXML, `@napi-rs/canvas` (MIT) for rasterization in tests and photo extraction. LibreOffice is an optional external tool (reference renders, chart fallback), invoked as a process, never linked.

## Consequences

- The PDF importer is re-implemented on pdf.js; the Python prototype remains as a behavioral reference for tests.
- No schema generation between languages; the Scene IR is a zod schema with inferred types.
- A dependency-license check runs in CI (allow-list: MIT, ISC, BSD-2/3, Apache-2.0, MPL-2.0 for tools only).
