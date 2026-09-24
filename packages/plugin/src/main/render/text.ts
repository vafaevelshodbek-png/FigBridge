/**
 * Scene text nodes → Figma TextNode with styled runs and paragraphs.
 */
import type { TextNode as SceneText } from "@figbridge/scene";
import type { FontLoader } from "./fonts.js";
import { hexToRgb } from "./geometry.js";

const ALIGN = { left: "LEFT", center: "CENTER", right: "RIGHT", justified: "JUSTIFIED" } as const;
const VALIGN = { top: "TOP", center: "CENTER", bottom: "BOTTOM" } as const;
const CASE = { original: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE" } as const;
const DECORATION = {
  none: "NONE",
  underline: "UNDERLINE",
  strikethrough: "STRIKETHROUGH",
} as const;

/** Clamp a Scene range to the actual character count (defensive: importers may be off by one). */
function clamp(start: number, end: number, length: number): [number, number] | undefined {
  const s = Math.max(0, Math.min(start, length));
  const e = Math.max(0, Math.min(end, length));
  return e > s ? [s, e] : undefined;
}

/**
 * Fill `text` (already appended to its final parent) with characters and styles.
 * Geometry is applied by the caller afterwards, because text sizing depends on content.
 */
export async function writeText(
  text: TextNode,
  scene: SceneText,
  fonts: FontLoader,
): Promise<void> {
  const firstRun = scene.runs[0];
  if (firstRun === undefined) return;
  text.fontName = await fonts.resolve({ family: firstRun.fontFamily, style: firstRun.fontStyle });
  text.characters = scene.characters;
  const length = text.characters.length;

  for (const run of scene.runs) {
    const range = clamp(run.start, run.end, length);
    if (range === undefined) continue;
    const [s, e] = range;
    text.setRangeFontName(
      s,
      e,
      await fonts.resolve({ family: run.fontFamily, style: run.fontStyle }),
    );
    text.setRangeFontSize(s, e, run.fontSize);
    if (run.fill.type === "solid") {
      text.setRangeFills(s, e, [
        { type: "SOLID", color: hexToRgb(run.fill.color), opacity: run.fill.opacity },
      ]);
    }
    if (run.letterSpacing !== 0)
      text.setRangeLetterSpacing(s, e, { unit: "PIXELS", value: run.letterSpacing });
    if (run.textCase !== "original") text.setRangeTextCase(s, e, CASE[run.textCase]);
    if (run.decoration !== "none") text.setRangeTextDecoration(s, e, DECORATION[run.decoration]);
    if (run.link !== undefined) text.setRangeHyperlink(s, e, { type: "URL", value: run.link });
  }

  let gap = 0;
  for (const [index, paragraph] of scene.paragraphs.entries()) {
    const range = clamp(paragraph.start, Math.max(paragraph.end, paragraph.start + 1), length);
    if (range !== undefined) {
      const [s, e] = range;
      const lineHeight = paragraph.lineHeight;
      text.setRangeLineHeight(
        s,
        e,
        lineHeight.unit === "auto"
          ? { unit: "AUTO" }
          : { unit: lineHeight.unit === "pixels" ? "PIXELS" : "PERCENT", value: lineHeight.value },
      );
      if (paragraph.list !== "none") {
        text.setRangeListOptions(s, e, {
          type: paragraph.list === "bullet" ? "UNORDERED" : "ORDERED",
        });
        if (paragraph.indentLevel > 0) text.setRangeIndentation(s, e, paragraph.indentLevel);
      }
    }
    const next = scene.paragraphs[index + 1];
    if (next !== undefined) gap = Math.max(gap, paragraph.spaceAfter + next.spaceBefore);
  }
  // Figma has one paragraph spacing per node; list items use their own property.
  if (gap > 0) {
    text.paragraphSpacing = gap;
    if (scene.paragraphs.some((p) => p.list !== "none")) text.listSpacing = gap;
  }

  text.textAlignHorizontal = ALIGN[scene.align];
  text.textAlignVertical = VALIGN[scene.verticalAlign];
  text.textAutoResize =
    scene.sizing === "fixed" ? "NONE" : scene.sizing === "width" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
}
