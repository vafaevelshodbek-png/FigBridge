/**
 * Glyphs → lines → paragraphs → Scene text nodes.
 *
 * PDFs position every glyph (or word) absolutely; editable text needs paragraphs. We rebuild
 * them deterministically from geometry: glyphs on one baseline form a line, lines with the
 * same left edge (or centre), size and a regular baseline step form a paragraph.
 */
import type { TextNode as SceneTextNode, TextRun } from "@figbridge/scene";
import { parseFontName } from "./fonts.js";
import type { Glyph } from "./primitives.js";
import { round } from "./round.js";

/** Glyphs belong to the same line when their baselines differ by less than this × size. */
const SAME_BASELINE = 0.2;
/** A horizontal gap larger than this × size starts a new line (separate text blocks). */
const MAX_WORD_GAP = 1.6;
/** A gap wider than this × size between glyphs means a word break. */
const SPACE_GAP = 0.15;
/** Lines align when their left edges (or centres) differ by less than this many px. */
const ALIGN_TOLERANCE = 3;
/** Two consecutive lines belong to one paragraph if the baseline step ≤ this × size. */
const MAX_LINE_STEP = 1.9;
/** Allowed deviation of a paragraph's baseline step, px. */
const STEP_TOLERANCE = 1.8;
/** Font sizes are "equal" within this many px. */
const SIZE_TOLERANCE = 0.8;
/** Replacement fonts are usually wider than brand fonts: widen boxes so lines don't wrap. */
const WIDTH_SLACK = 1.06;

/** Ligatures fonts commonly encode without a Unicode mapping (pdf.js yields a control char). */
const LIGATURE_CANDIDATES = ["ti", "fi", "fl", "ft", "ff", "tt", "ffi", "ffl", "fj", "th"] as const;
/** Accept a ligature guess when its letters' widths sum within this fraction of the glyph. */
const LIGATURE_WIDTH_TOLERANCE = 0.2;

/**
 * Replace unmapped ligature glyphs (control characters) by the letter pair whose combined
 * width in the same font best matches the glyph width; drop them when nothing fits.
 */
export function repairLigatures(glyphs: readonly Glyph[]): Glyph[] {
  // Nominal width per (font, character), normalised by size, learned from the document.
  const widths = new Map<string, number>();
  for (const g of glyphs) {
    if (g.text.length === 1 && g.text >= " " && g.size > 0)
      widths.set(`${g.font}\u0000${g.text}`, g.nominal / g.size);
  }
  const widthOf = (font: string, text: string) => {
    let total = 0;
    for (const ch of text) {
      const w = widths.get(`${font}\u0000${ch}`);
      if (w === undefined) return undefined;
      total += w;
    }
    return total;
  };
  const out: Glyph[] = [];
  for (const g of glyphs) {
    if (!isUnmapped(g.text) || g.size <= 0) {
      out.push(g);
      continue;
    }
    const target = g.nominal / g.size;
    let best: { text: string; error: number } | undefined;
    for (const candidate of LIGATURE_CANDIDATES) {
      const w = widthOf(g.font, candidate);
      if (w === undefined) continue;
      const error = Math.abs(w - target) / target;
      if (best === undefined || error < best.error) best = { text: candidate, error };
    }
    if (best !== undefined && best.error <= LIGATURE_WIDTH_TOLERANCE)
      out.push({ ...g, text: best.text });
  }
  return out;
}

/** pdf.js yields C0 control characters for glyphs without a Unicode mapping. */
function isUnmapped(text: string): boolean {
  return text.length > 0 && Array.from(text).every((ch) => ch.charCodeAt(0) < 0x20);
}

/** Drop glyphs painted twice at the same place (decks often draw text twice for "boldness"). */
export function dedupeGlyphs(glyphs: readonly Glyph[]): Glyph[] {
  const seen = new Set<string>();
  return glyphs.filter((g) => {
    const key = `${g.text}|${String(Math.round(g.x * 2))}|${String(Math.round(g.y * 2))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Line {
  glyphs: Glyph[];
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

/** Group upright glyphs into lines, in reading order (top to bottom, left to right). */
export function buildLines(glyphs: readonly Glyph[]): Line[] {
  const lines: Line[] = [];
  let current: Line | undefined;
  for (const glyph of glyphs) {
    if (!glyph.upright) continue;
    const continues =
      current !== undefined &&
      Math.abs(glyph.y - current.baseline) < SAME_BASELINE * Math.max(glyph.size, current.size) &&
      glyph.x >= current.x1 - 0.5 * glyph.size &&
      glyph.x - current.x1 < MAX_WORD_GAP * glyph.size;
    if (current !== undefined && continues) {
      // Many PDFs (TeX, some exporters) position words without space glyphs: synthesize one.
      const gap = glyph.x - current.x1;
      const lastText = current.glyphs[current.glyphs.length - 1]?.text ?? "";
      if (gap > SPACE_GAP * glyph.size && lastText !== " " && glyph.text !== " ") {
        current.glyphs.push({ ...glyph, text: " ", x: current.x1, advance: gap, nominal: gap });
      }
      current.glyphs.push(glyph);
      current.x1 = Math.max(current.x1, glyph.x + glyph.advance);
      current.size = Math.max(current.size, glyph.size);
    } else {
      current = {
        glyphs: [glyph],
        x0: glyph.x,
        x1: glyph.x + glyph.advance,
        baseline: glyph.y,
        size: glyph.size,
      };
      lines.push(current);
    }
  }
  return lines
    .map(trimLine)
    .filter((line): line is Line => line !== undefined)
    .sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
}

function trimLine(line: Line): Line | undefined {
  const glyphs = [...line.glyphs];
  while (glyphs.length > 0 && (glyphs[glyphs.length - 1]?.text.trim() ?? "") === "") glyphs.pop();
  while (glyphs.length > 0 && (glyphs[0]?.text.trim() ?? "") === "") glyphs.shift();
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { ...line, glyphs, x0: first.x, x1: last.x + last.advance };
}

const midpoint = (line: Line) => (line.x0 + line.x1) / 2;

/** Group lines into paragraphs. Every line ends up in exactly one paragraph. */
export function buildParagraphs(lines: readonly Line[]): Line[][] {
  const used = new Set<number>();
  const paragraphs: Line[][] = [];
  lines.forEach((start, index) => {
    if (used.has(index)) return;
    used.add(index);
    const group = [start];
    for (;;) {
      const last = group[group.length - 1];
      if (last === undefined) break;
      const step =
        group.length > 1 ? (group[1]?.baseline ?? 0) - (group[0]?.baseline ?? 0) : undefined;
      let next = -1;
      for (let j = index + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (candidate === undefined || used.has(j)) continue;
        const gap = candidate.baseline - last.baseline;
        if (gap <= 0) continue;
        if (gap > MAX_LINE_STEP * last.size) break;
        const aligned =
          Math.abs(candidate.x0 - last.x0) < ALIGN_TOLERANCE ||
          Math.abs(midpoint(candidate) - midpoint(last)) < ALIGN_TOLERANCE ||
          // Hanging punctuation: a quote in the first line pushes it left of the rest.
          (group.length === 1 &&
            /^[“"«'‘]/.test(start.glyphs[0]?.text ?? "") &&
            candidate.x0 - last.x0 > 0 &&
            candidate.x0 - last.x0 < 0.7 * last.size);
        if (!aligned || Math.abs(candidate.size - last.size) > SIZE_TOLERANCE) continue;
        if (step !== undefined && Math.abs(gap - step) > STEP_TOLERANCE) continue;
        next = j;
        break;
      }
      if (next < 0) break;
      used.add(next);
      const nextLine = lines[next];
      if (nextLine !== undefined) group.push(nextLine);
    }
    paragraphs.push(group);
  });
  return paragraphs;
}

type Alignment = SceneTextNode["align"];

function alignmentOf(paragraph: readonly Line[]): Alignment {
  if (paragraph.length < 2) return "left";
  const lefts = paragraph.map((l) => l.x0);
  const spread = Math.max(...lefts) - Math.min(...lefts);
  if (spread < ALIGN_TOLERANCE) return "left";
  const mids = paragraph.map(midpoint);
  if (Math.max(...mids) - Math.min(...mids) < ALIGN_TOLERANCE) return "center";
  const rights = paragraph.map((l) => l.x1);
  if (Math.max(...rights) - Math.min(...rights) < ALIGN_TOLERANCE) return "right";
  return "left";
}

/** Build one Scene text node per paragraph. */
export function paragraphToNode(paragraph: readonly Line[], id: string): SceneTextNode | undefined {
  let characters = "";
  const runs: TextRun[] = [];
  paragraph.forEach((line, lineIndex) => {
    if (lineIndex > 0) characters += "\n";
    for (const glyph of line.glyphs) {
      const start = characters.length;
      characters += glyph.text;
      if (characters.length === start) continue;
      const { family, style } = parseFontName(glyph.font);
      const size = Math.round(glyph.size * 100) / 100;
      const previous = runs[runs.length - 1];
      if (
        previous !== undefined &&
        previous.end === start &&
        previous.fontFamily === family &&
        previous.fontStyle === style &&
        previous.fontSize === size &&
        previous.fill.type === "solid" &&
        previous.fill.color === glyph.color &&
        previous.fill.opacity === glyph.alpha
      ) {
        previous.end = characters.length;
      } else {
        runs.push({
          start,
          end: characters.length,
          fontFamily: family,
          fontStyle: style,
          fontSize: size,
          fill: { type: "solid", color: glyph.color.toUpperCase(), opacity: glyph.alpha },
          letterSpacing: 0,
          textCase: "original",
          decoration: "none",
        });
      }
    }
  });
  if (characters.trim() === "" || runs.length === 0) return undefined;

  const first = paragraph[0];
  if (first === undefined) return undefined;
  const x0 = Math.min(...paragraph.map((l) => l.x0));
  const x1 = Math.max(...paragraph.map((l) => l.x1));
  const step =
    paragraph.length > 1 ? (paragraph[1]?.baseline ?? 0) - first.baseline : first.size * 1.21;
  // Place the box so Figma's first baseline lands on the PDF baseline: with a fixed line
  // height Figma centres the font's ascent/descent (≈1.21 em for common sans fonts) in the line.
  const top = first.baseline - (step - first.size * 1.21) / 2 - first.size * 0.97;
  const width = (x1 - x0) * WIDTH_SLACK + 4;
  const align = alignmentOf(paragraph);
  const x = align === "center" ? x0 - (width - (x1 - x0)) / 2 : align === "right" ? x1 - width : x0;

  return {
    id,
    name: characters.split("\n")[0]?.slice(0, 40) ?? "text",
    type: "text",
    x: round(x),
    y: round(top),
    w: round(width),
    h: round(step * paragraph.length),
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    characters,
    runs,
    paragraphs: [
      {
        start: 0,
        end: characters.length,
        lineHeight:
          paragraph.length > 1 ? { unit: "pixels", value: round(step) } : { unit: "auto" },
        spaceBefore: 0,
        spaceAfter: 0,
        list: "none",
        indentLevel: 0,
      },
    ],
    align,
    verticalAlign: "top",
    sizing: "width",
  };
}
