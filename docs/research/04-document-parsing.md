# 04 — Document parsing for pptx/PDF → editable Figma

Status: research note, 2026-09-24. Verification depth: licenses for pypdfium2 and the pdf.to.design feature set were checked against the sources linked here during this pass. The other claims come from the projects' own documentation, cited per row. Check any claim the design depends on before relying on it.

## TL;DR recommendation

**LICENSE RISK:** PyMuPDF/MuPDF is **AGPL-3.0** (or commercial from Artifex) — https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright. If an MIT project imports it, anyone who distributes the combined work, or serves it over a network, has to comply with AGPL. The repo can keep its MIT license text, but in practice the whole product becomes AGPL. The same applies to Poppler (GPL-2/3, https://poppler.freedesktop.org/), pdf2htmlEX (GPL-3, https://github.com/pdf2htmlEX/pdf2htmlEX) and `mutool` (AGPL). Ghostscript is also AGPL.

Recommended MIT-safe stack:

| Layer | Pick | License |
|---|---|---|
| PDF object model (paths, images, text objects, clip, matrices) | **pypdfium2** (PDFium) | Apache-2.0 / BSD-3 — https://github.com/pypdfium2-team/pypdfium2 |
| Raw content-stream / resources (soft masks, transparency groups, shadings, ExtGState that PDFium does not expose) | **pikepdf** (qpdf) — `pikepdf.parse_content_stream` plus a small graphics-state interpreter of our own | MPL-2.0 (pikepdf), Apache-2.0 (qpdf) — https://github.com/pikepdf/pikepdf, https://github.com/qpdf/qpdf |
| Optional high-fidelity alternative (JS side, can run inside Node or the plugin) | **pdf.js** `page.getOperatorList()` plus `getTextContent()` | Apache-2.0 — https://github.com/mozilla/pdf.js |
| Text with glyph widths / ToUnicode diagnostics | pdfminer.six / pdfplumber (chars, fontname, matrix, `ncs`) | MIT — https://github.com/pdfminer/pdfminer.six, https://github.com/jsvine/pdfplumber |
| Reference raster | pypdfium2 `render` (PDF); LibreOffice headless → PDF → pypdfium2 (pptx) | Apache/BSD; MPL-2.0 (LO, invoked as an external process, no linking) |
| PPTX | lxml over raw OOXML, with python-pptx used only as a convenience for opening files and reading relationships | python-pptx MIT — https://github.com/scanny/python-pptx |
| Visual diff | SSIM (scikit-image, BSD) + pixelmatch-style AA-aware diff (pixelmatch ISC / odiff MIT); LPIPS only offline | https://github.com/mapbox/pixelmatch, https://github.com/dmtrKovalenko/odiff |

Keep PyMuPDF only as an **optional, separately installed AGPL plugin** (for example `figma-bridge[mupdf]`, off by default and clearly labeled), or drop it.

What stays deterministic and tested: the graphics-state interpreter, the paint-order → layer mapping, rect/rounded-rect recognition, photo-crop math, and gradient mapping. The grouping heuristics (paragraphs, cards, groups) also stay deterministic, covered by golden fixtures. ML layout models (docling etc.) are an *optional* hint source for reading order and paragraphs only, never for geometry.

## 1. PDF engines

| Engine | Paint-order access | Clip paths | Soft masks / transparency groups | Shadings | Images (CTM, SMask) | Text | License |
|---|---|---|---|---|---|---|---|
| PyMuPDF `get_drawings(extended=True)` / `get_bboxlog` / `rawdict` | yes: `seqno` gives paint order; extended mode emits clip and group items with nesting `level` (https://pymupdf.readthedocs.io/en/latest/recipes-drawings-and-graphics.html) | yes (extended) | groups are reported, SMask content is not exposed as vectors | no (appears only as a bbox in the bboxlog) | `get_image_info(xrefs=True)` with `transform`; smask via `extract_image` | good; ligature/ToUnicode handled by MuPDF; `rawdict` has per-char bboxes | **AGPL** |
| MuPDF stext / `mutool draw -F stext` | text plus image blocks; vectors are only summarized ("vector" blocks in newer builds) | partial | no | no | bbox only | very good | **AGPL** — https://mupdf.readthedocs.io/en/latest/mutool-draw.html |
| **PDFium / pypdfium2** | `FPDFPage_GetObject(i)` iterates page objects in content order; form XObjects are nested via `FPDFFormObj_*` | `FPDFPageObj_GetClipPath` → paths/segments per object (https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_transformpage.h) | object-level: `FPDFPageObj_HasTransparency`, blend mode; the soft-mask *contents* are not exposed → read them via pikepdf | shading objects are type `FPDF_PAGEOBJ_SHADING` but their parameters are not exposed → read via pikepdf | `FPDFImageObj_GetMatrix`, `GetBitmap` / `GetRenderedBitmap`, raw data via `GetImageDataRaw`; SMask via pikepdf | `FPDFText_*`: chars, unicode, font name, weight, size, char boxes (https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_text.h) | Apache/BSD |
| **pdf.js** `getOperatorList()` | full operator stream after font/image resolution (`OPS.*` constants: constructPath, clip, setGState, paintImageXObject, shadingFill, beginGroup / endGroup, and smask handled inside GState) — https://github.com/mozilla/pdf.js/blob/master/src/shared/util.js | yes (raw ops) | yes: `beginGroup` / `endGroup`, `SMask` in the gstate dict | yes: `shadingFill` with IR data (axial/radial stops) | yes | `getTextContent()` gives items plus the transform, width, fontName; `includeMarkedContent` | Apache-2.0 |
| pdfminer.six / pdfplumber | `LTCurve`/`LTRect`/`LTLine` in order, but clip is ignored | **no** | no | no | `LTImage` bbox, stream | chars with matrix, fontname, `ncs`/`scs` colors; weak on some ToUnicode cases | MIT |
| Poppler (`pdftocairo -svg`) | SVG in paint order with clipPath and masks; shadings rasterized or emitted as patterns | yes | masks → SVG `<mask>`; groups flattened | cairo patterns | embedded `<image>` | glyphs as outlines (no editable text) | **GPL** — https://poppler.freedesktop.org/ |
| Apache PDFBox (Java) | `PDFGraphicsStreamEngine` subclass: callbacks for every path op, clip, image, shading, and `showTransparencyGroup` — the cleanest complete engine API (https://pdfbox.apache.org/docs/2.0.13/javadocs/org/apache/pdfbox/contentstream/PDFGraphicsStreamEngine.html) | yes | yes (`PDSoftMask`, `PDTransparencyGroup`) | yes (`PDShading` types 1–7) | yes | `PDFTextStripper` / `TextPosition` with widths | Apache-2.0, but it adds a JVM |
| qpdf / pikepdf | raw tokens only; no interpreter | you implement it | full access to ExtGState `/SMask`, `/Group` dicts | full dicts | full | none | Apache / MPL |

Conclusion: no permissive Python library exposes *everything*. The most practical split is **PDFium for the object iteration, geometry and CTM**, plus **pikepdf to look up the resource dicts** (SMask, shading functions, `/Group`) referenced by the same content stream. The other option is to move PDF extraction to **pdf.js inside Node**: the operator list is complete, and it shares a runtime with the Figma plugin. PDFBox is the most complete on paper, but the JVM is a heavy dependency.

Known text pitfalls, whatever the engine: missing or incorrect ToUnicode maps (Type3 fonts and subset CID fonts show up as `�` or PUA code points); ligatures (`ﬁ`) — decompose with NFKC only when ToUnicode maps to the ligature code point; synthetic bold (text render mode 2 with stroke); and per-glyph positioning via TJ kerning. Recover paragraph widths from the advances, not from the string length. pdf.js documents several of these cases in its font tests: https://github.com/mozilla/pdf.js/tree/master/test/pdfs.

### Converters as an intermediate format?
- `mutool convert -F svg` / `pdftocairo -svg` / pdf2htmlEX: the output is paint-ordered and clip-correct, but text is lost or glyph-split (outlines, or absolutely positioned spans), and all three are AGPL/GPL. Use them only as **debug oracles** that are *invoked*, never bundled or linked. Running a GPL CLI as a separate process for internal comparison is generally considered outside the copyleft scope, but do not ship them in the package.
- pdf2htmlEX has been unmaintained for long stretches (the community fork is at the link above). Not recommended.

## 2. Layout analysis and structure recovery

| Tool | What it gives | Fit for slides |
|---|---|---|
| pdfplumber `extract_words` / `cluster_objects`, pdfminer `LAParams` (line_margin, char_margin, boxes_flow) — https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html | deterministic line and box grouping with tunable thresholds | good baseline for paragraphs; no concept of cards |
| **docling** (IBM, MIT) — https://github.com/docling-project/docling | DocLayNet-trained layout model, reading order, tables (TableFormer), picture regions; uses its own PDF backend (docling-parse, MIT) | tuned for documents; slides are partially out of distribution; usable for reading order and paragraph hints |
| marker (GPL-3 code, model weights under restricted license) — https://github.com/datalab-to/marker | PDF → Markdown | **license-incompatible**; the output is Markdown, not geometry |
| unstructured (Apache-2.0) — https://github.com/Unstructured-IO/unstructured | element partitioning (Title, NarrativeText…) | coarse, and bboxes are optional |
| LayoutParser (Apache-2.0) — https://github.com/Layout-Parser/layout-parser | Detectron2 wrappers | effectively unmaintained since 2022 |
| Nougat (MIT code, CC-BY-NC weights) — https://github.com/facebookresearch/nougat | OCR to Markdown for academic papers | wrong domain; non-commercial weights |

Trade-off: ML models give class labels and reading order, but they return **boxes on a raster**, with no link to the source objects. We already have exact vector and text objects, so card detection is a geometric containment problem: a filled or stroked rect contains text or images, is painted before them, and nothing in between breaks the containment. That solves it more reliably than a detector, and it is testable. Recommendation: stay deterministic, and consider docling only as an optional "reading-order / paragraph-merge hint" behind a flag, with its bboxes snapped to our objects.

## 3. PPTX

- python-pptx exposes shapes, text frames, runs, pictures (with `crop_*`), placeholders and basic fills. It **does not** resolve inheritance: a placeholder's effective font, size or color walks slide → layout → master → `txStyles` → theme, and python-pptx returns `None` for anything inherited. It also does not cover gradients in full, effects, autofit results, SmartArt or chart rendering (https://python-pptx.readthedocs.io/en/latest/dev/analysis/ — the analysis pages list these gaps). The existing lxml approach is correct. Keep an explicit resolver that follows the inheritance chain in ECMA-376 §19.3.1 / §21.1.2 (https://ecma-international.org/publications-and-standards/standards/ecma-376/): shape `spPr`/`txBody` lstStyle → layout placeholder (matched by `idx`/`type`) → master placeholder → master `p:txStyles` (title/body/other) → `a:objectDefaults` → theme `a:fontScheme`/`clrScheme` with `p:clrMap` remapping and `lumMod`/`lumOff`/`tint`/`shade` transforms.
- Autofit: `normAutofit fontScale`/`lnSpcReduction` values are written by PowerPoint at save time, so apply the stored values. Do not recompute them. `spAutoFit` resizes the shape, and the stored `xfrm` already reflects the result.
- Charts (`c:chartSpace`) and SmartArt (`dgm`): take the drawing fallback. SmartArt ships `dsp:drawing` (drawing1.xml) with pre-laid-out shapes, which can be converted as ordinary shapes. Charts have no fallback, so render them via LibreOffice → PDF and import the result as PDF vectors.
- LibreOffice (MPL-2.0) handles inheritance in its OOXML import filter (oox module, https://git.libreoffice.org/core/+/refs/heads/master/oox/source/ppt/). For reference images: `soffice --headless --convert-to pdf deck.pptx`, then rasterize with pypdfium2. Caveats: font substitution (install the deck's fonts or accept tolerance), and differences in SmartArt and chart styling. Pin the LO version in CI (the Docker image) so the goldens stay stable. Docs: https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html
- Aspose.Slides: commercial. Use it only as an external reference renderer when licensed. Never add it as a dependency.

## 4. Visual verification

- Metrics: pixel diff with antialias detection (pixelmatch, whose threshold is in YIQ space; odiff is a faster pixelmatch-compatible alternative), SSIM/MS-SSIM (`skimage.metrics.structural_similarity`, https://scikit-image.org/docs/stable/api/skimage.metrics.html), and LPIPS (https://github.com/richzhang/PerceptualSimilarity, BSD-2; a torch dependency, so offline only). Report **per-region** scores: compute them per mapped element bbox as well as globally, so a failure points to a specific layer.
- How renderers test themselves: resvg compares against reference PNGs with a small allowed pixel difference (https://github.com/linebender/resvg/tree/main/crates/resvg/tests); pdf.js uses "reftests" that compare against snapshots taken on the reference branch, and a human reviews the diffs (https://github.com/mozilla/pdf.js/wiki/Contributing); Skia uses Gold, a triage server for goldens with multiple accepted variants per test (https://skia.org/docs/dev/testing/skiagold/).
- Handling font substitution: (a) mask text regions and compare them separately with a looser threshold, or compare their bounding boxes and line counts instead of pixels; (b) check geometry deterministically from the extracted scene graph, independent of the raster: layer counts, bboxes within ±0.5 pt, fills and radii equal; (c) keep goldens as JSON scene snapshots (a syrupy/pytest-style snapshot) plus PNGs, and bless them explicitly with a `--update-goldens` flag.

## 5. Existing converters to Figma

- **pdf.to.design** (‹div›RIOTS): runs locally, converts vectors into Figma vectors and text into editable text, flags missing fonts for mapping, and puts one frame per page in a section. The free tier is limited to 3 pages — https://divriots.com/blog/introducing-pdf-to-design/, https://www.figma.com/community/plugin/1280917768965269588. The same company offers **office.to.design** for pptx/docx/xlsx — https://divriots.com/blog/how-to-import-office-documents-into-figma/. No technical internals are published. From public output, text tends to import as lines rather than paragraphs, and there is no semantic card grouping. This is observed behavior, not documented.
- pdf.tomake.design, a newer competitor — https://tomake.design/pdf-to-figma/.
- Figma Slides imports .pptx natively (https://help.figma.com/hc/en-us/articles/24170696386583) into Slides files; quality is reportedly good for text and shapes and weaker for SmartArt and charts.
- None of these publishes a verification metric. A visual-diff score reported per deck would set this project apart.

## Deterministic core — what to test

1. A graphics-state interpreter with golden tests on synthetic PDFs (generate them with pikepdf or reportlab: nested q/Q, clips, form XObjects, SMask, axial/radial shadings).
2. Path → primitive recognition (rect, rounded rect with per-corner radii, ellipse, line), with tolerance tests.
3. Image crop math (clip ∩ image CTM → Figma `imageTransform`, keeping the original pixels).
4. Text: runs → lines → paragraphs, using advance widths and baseline and leading clusters.
5. Containment-based card grouping, with property tests (random layouts must not produce cycles or orphans).
6. Visual regression over a fixed corpus of 10+ decks, beyond the two used for tuning, including CJK, RTL, Type3 fonts and broken ToUnicode maps.
