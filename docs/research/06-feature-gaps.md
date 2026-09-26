# 06 — Feature gaps against similar tools

Researched 2026-09-26. Architecture was compared in [01-competitors.md](01-competitors.md); this note is about what users can do elsewhere and not with figbridge. Each gap is a card in the project board, to be prioritised by the maintainer; nothing here is decided.

## Deck and document importers

| Tool | What it has that we do not |
|---|---|
| [Pitchdeck](https://docs.hypermatic.com/pitchdeck/design/import-pptx) | Speaker notes; import into Figma Slides. (No charts, SmartArt or layouts — we are ahead there.) |
| [PPTF](https://www.figma.com/community/plugin/1611637977064559630) | Similar scope to ours: tables and charts as editable layers. |
| [office.to.design](https://www.figma.com/community/plugin/1448627014003851120) | Word, Keynote and Pages, not only PowerPoint. |
| [html.to.design](https://html.to.design/docs/free-features/) | Creates local styles and variables, applies auto layout, maps or downloads missing fonts. |
| [FPPT](https://www.figma.com/community/plugin/1585357315383633597) and others | The reverse direction: Figma → PPTX / PDF. |

## Agent bridges

| Tool | What it has that we do not |
|---|---|
| [figwright](https://github.com/awdr74100/figwright) | ~115 tools: variables, styles, components and properties, auto layout, effects, prototyping and motion, batch edits, design diff against baselines, a debug panel showing exact model inputs. |
| [figma-console-mcp](https://github.com/southleft/figma-console-mcp) | Variables and token sync (DTCG, CSS, Tailwind…), component docs, accessibility audits, design-system health scores, version history, FigJam and Figma Slides tools, a cloud relay for web AI clients. |
| [Official Figma MCP](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) | `get_design_context` for code generation, Code Connect, asset upload, Mermaid → FigJam diagrams, web page → Figma design. |

## Where figbridge is ahead

Editable charts, SmartArt and tables from PPTX; PDF import (no other bridge has it); access modes with per-change approval and an agent-only undo; pixel comparison for pixel-perfect work; tests that model the Figma API's rules.
