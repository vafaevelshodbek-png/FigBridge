/**
 * `p:txBody` → Scene text node.
 *
 * Paragraph and run properties are resolved through the full chain PowerPoint uses:
 * master text style → master placeholder → layout placeholder → the shape's own list style
 * → paragraph `pPr` → run `rPr`.
 */
import type { Paint, Paragraph, TextNode, TextRun } from "@figbridge/scene";
import { resolveColor } from "./color.js";
import { ptToPx, resolveTypeface, round, type SlideContext } from "./context.js";
import { parseFontStyle } from "./fonts.js";
import { inheritanceChain, masterTextStyle, type PlaceholderRef } from "./placeholders.js";
import type { Box } from "./transform.js";
import { attr, child, num, type XmlElement } from "./xml.js";

const PERCENT = 100_000;
/** Office's default text insets (EMU). */
const DEFAULT_INSETS = { l: 91_440, t: 45_720, r: 91_440, b: 45_720 } as const;
/** Office's default font size (hundredths of a point). */
const DEFAULT_SIZE = 1800;
/**
 * PowerPoint's "single" line spacing for common sans fonts is ≈1.21 em, while Figma's percent
 * line height is relative to the font size: 100 % in PowerPoint ≈ 121 % in Figma.
 */
const SINGLE_LINE = 1.21;

interface ParagraphProps {
  algn?: string;
  lnSpc?: { pct: number } | { pts: number };
  spcBef?: { pct: number } | { pts: number };
  spcAft?: { pct: number } | { pts: number };
  bullet?: "none" | "bullet" | "ordered";
  marL?: number;
}

interface RunProps {
  sz?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  cap?: string;
  spc?: number;
  font?: string;
  fill?: Paint;
}

function spacing(el: XmlElement | undefined): ParagraphProps["lnSpc"] {
  const pct = child(el, "spcPct");
  if (pct !== undefined) return { pct: num(pct, "val", PERCENT) / PERCENT };
  const pts = child(el, "spcPts");
  if (pts !== undefined) return { pts: num(pts, "val", 0) / 100 };
  return undefined;
}

function mergeParagraph(into: ParagraphProps, el: XmlElement | undefined): void {
  if (el === undefined) return;
  const algn = attr(el, "algn");
  if (algn !== undefined) into.algn = algn;
  const marL = attr(el, "marL");
  if (marL !== undefined) into.marL = Number(marL);
  const ln = spacing(child(el, "lnSpc"));
  if (ln !== undefined) into.lnSpc = ln;
  const before = spacing(child(el, "spcBef"));
  if (before !== undefined) into.spcBef = before;
  const after = spacing(child(el, "spcAft"));
  if (after !== undefined) into.spcAft = after;
  if (child(el, "buNone") !== undefined) into.bullet = "none";
  if (child(el, "buChar") !== undefined) into.bullet = "bullet";
  if (child(el, "buAutoNum") !== undefined) into.bullet = "ordered";
}

function mergeRun(ctx: SlideContext, into: RunProps, el: XmlElement | undefined): void {
  if (el === undefined) return;
  const sz = attr(el, "sz");
  if (sz !== undefined) into.sz = Number(sz);
  const b = attr(el, "b");
  if (b !== undefined) into.b = b === "1" || b === "true";
  const i = attr(el, "i");
  if (i !== undefined) into.i = i === "1" || i === "true";
  const u = attr(el, "u");
  if (u !== undefined) into.u = u !== "none";
  const strike = attr(el, "strike");
  if (strike !== undefined) into.strike = strike !== "noStrike";
  const cap = attr(el, "cap");
  if (cap !== undefined) into.cap = cap;
  const spc = attr(el, "spc");
  if (spc !== undefined) into.spc = Number(spc);
  const typeface = resolveTypeface(ctx.theme, attr(child(el, "latin"), "typeface"));
  if (typeface !== undefined) into.font = typeface;
  const color = resolveColor(child(el, "solidFill"), ctx.colors);
  if (color !== undefined) into.fill = { type: "solid", color: color.color, opacity: color.alpha };
}

/** List-style level elements (`lvl1pPr`…) along the inheritance chain, general first. */
function levelChain(
  ctx: SlideContext,
  shape: XmlElement,
  ref: PlaceholderRef | undefined,
  level: number,
): XmlElement[] {
  const name = `lvl${String(level)}pPr`;
  const styles: (XmlElement | undefined)[] = [];
  if (ref === undefined) styles.push(ctx.defaultTextStyle);
  styles.push(masterTextStyle(ctx, ref));
  for (const inherited of inheritanceChain(ctx, ref))
    styles.push(child(child(inherited, "txBody"), "lstStyle"));
  styles.push(child(child(shape, "txBody"), "lstStyle"));
  return styles.flatMap((style) => {
    const lvl = child(style, name);
    const def = child(style, "defPPr");
    return [def, lvl].filter((e): e is XmlElement => e !== undefined);
  });
}

/** Resolved `bodyPr`: own attributes over layout/master placeholder ones. */
function bodyProps(
  ctx: SlideContext,
  shape: XmlElement,
  ref: PlaceholderRef | undefined,
  txBody: XmlElement,
) {
  const chain = [
    ...inheritanceChain(ctx, ref).map((s) => child(child(s, "txBody"), "bodyPr")),
    child(txBody, "bodyPr"),
  ];
  const get = (name: string) =>
    chain.reduce<string | undefined>((value, el) => attr(el, name) ?? value, undefined);
  const autofit = chain.reduce<XmlElement | undefined>(
    (v, el) => child(el, "normAutofit") ?? v,
    undefined,
  );
  const scale = num(autofit, "fontScale", PERCENT) / PERCENT;
  const lineReduction = num(autofit, "lnSpcReduction", 0) / PERCENT;
  return {
    insets: {
      l: Number(get("lIns") ?? DEFAULT_INSETS.l),
      t: Number(get("tIns") ?? DEFAULT_INSETS.t),
      r: Number(get("rIns") ?? DEFAULT_INSETS.r),
      b: Number(get("bIns") ?? DEFAULT_INSETS.b),
    },
    anchor: get("anchor") ?? "t",
    wrap: get("wrap") !== "none",
    vert: get("vert") ?? "horz",
    scale,
    lineReduction,
  };
}

const ALIGN: Readonly<Record<string, TextNode["align"]>> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "justified",
  dist: "justified",
};
const VALIGN: Readonly<Record<string, TextNode["verticalAlign"]>> = {
  t: "top",
  ctr: "center",
  b: "bottom",
};

/** Build a text node for a shape's text body, or undefined when it has no visible text. */
export function textNode(
  ctx: SlideContext,
  shape: XmlElement,
  ref: PlaceholderRef | undefined,
  box: Box,
  name: string,
): TextNode | undefined {
  const txBody = child(shape, "txBody");
  if (txBody === undefined) return undefined;
  const body = bodyProps(ctx, shape, ref, txBody);
  // Theme font colour from the shape style (`fontRef`) is the base run colour.
  const styleColor = resolveColor(child(child(shape, "style"), "fontRef"), ctx.colors);

  let characters = "";
  const runs: TextRun[] = [];
  const paragraphs: Paragraph[] = [];
  let firstAlign: string | undefined;
  let hasBullets = false;

  for (const [index, p] of txBody.children.filter((c) => c.name === "p").entries()) {
    if (index > 0) characters += "\n";
    const pPr = child(p, "pPr");
    const level = num(pPr, "lvl", 0) + 1;
    const para: ParagraphProps = {};
    const base: RunProps =
      styleColor === undefined
        ? {}
        : { fill: { type: "solid", color: styleColor.color, opacity: styleColor.alpha } };
    for (const lvl of levelChain(ctx, shape, ref, level)) {
      mergeParagraph(para, lvl);
      mergeRun(ctx, base, child(lvl, "defRPr"));
    }
    mergeParagraph(para, pPr);
    firstAlign ??= para.algn;

    const start = characters.length;
    let firstSize = base.sz ?? DEFAULT_SIZE;
    let sawRun = false;
    for (const r of p.children) {
      if (r.name !== "r" && r.name !== "fld" && r.name !== "br") continue;
      const props: RunProps = { ...base };
      mergeRun(ctx, props, child(r, "rPr"));
      let text = r.name === "br" ? " " : (child(r, "t")?.text ?? "");
      if (r.name === "fld" && attr(r, "type") === "slidenum") text = String(ctx.slideNumber);
      if (text === "") continue;
      if (!sawRun) firstSize = props.sz ?? DEFAULT_SIZE;
      sawRun = true;
      const runStart = characters.length;
      characters += text;
      runs.push(toRun(ctx, props, runStart, characters.length, body.scale));
    }
    const sizePx = ptToPx(ctx, (firstSize / 100) * body.scale);
    const list = para.bullet === "bullet" || para.bullet === "ordered" ? para.bullet : "none";
    if (list !== "none" && characters.length > start) hasBullets = true;
    paragraphs.push({
      start,
      end: characters.length,
      lineHeight: lineHeightOf(ctx, para.lnSpc, body.lineReduction),
      spaceBefore: round(spaceOf(ctx, para.spcBef, sizePx)),
      spaceAfter: round(spaceOf(ctx, para.spcAft, sizePx)),
      list: characters.length > start ? list : "none",
      indentLevel: Math.max(0, level - 1),
    });
  }
  if (characters.trim() === "" || runs.length === 0) return undefined;

  const ins = body.insets;
  let x = box.x + ins.l * ctx.scale;
  const y = box.y + ins.t * ctx.scale;
  let w = Math.max(1, box.w - (ins.l + ins.r) * ctx.scale);
  const h = Math.max(1, box.h - (ins.t + ins.b) * ctx.scale);
  // Figma indents list markers more than PowerPoint: widen so lines break at the same words.
  if (hasBullets) w += Math.max(...runs.map((r) => r.fontSize));
  let rotation = box.rot;
  if (body.vert === "vert" || body.vert === "eaVert") rotation += 90;
  else if (body.vert === "vert270") rotation += 270;
  let tw = w;
  let th = h;
  if (rotation !== box.rot) {
    // Vertical text: lay out in the rotated frame, same centre.
    const cx = x + w / 2;
    const cy = y + h / 2;
    [tw, th] = [h, w];
    x = cx - tw / 2;
    return finish(cx - tw / 2, cy - th / 2);
  }
  return finish(x, y);

  function finish(fx: number, fy: number): TextNode {
    return {
      id: ctx.nextId(),
      name,
      type: "text",
      x: round(fx),
      y: round(fy),
      w: round(tw),
      h: round(th),
      rotation: rotation % 360,
      flipX: false,
      flipY: false,
      opacity: 1,
      visible: true,
      characters,
      runs,
      paragraphs,
      align: ALIGN[firstAlign ?? "l"] ?? "left",
      verticalAlign: VALIGN[body.anchor] ?? "top",
      sizing: body.wrap ? "fixed" : "width",
    };
  }
}

function toRun(
  ctx: SlideContext,
  props: RunProps,
  start: number,
  end: number,
  scale: number,
): TextRun {
  const { family, style } = parseFontStyle(
    props.font ?? ctx.theme.minorFont,
    props.b ?? false,
    props.i ?? false,
  );
  return {
    start,
    end,
    fontFamily: family,
    fontStyle: style,
    fontSize: round(ptToPx(ctx, ((props.sz ?? DEFAULT_SIZE) / 100) * scale)),
    fill: props.fill ?? { type: "solid", color: "#000000", opacity: 1 },
    letterSpacing: round(ptToPx(ctx, (props.spc ?? 0) / 100)),
    textCase: props.cap === "all" ? "upper" : "original",
    decoration: props.u === true ? "underline" : props.strike === true ? "strikethrough" : "none",
  };
}

function lineHeightOf(
  ctx: SlideContext,
  spec: ParagraphProps["lnSpc"],
  reduction: number,
): Paragraph["lineHeight"] {
  if (spec === undefined)
    return reduction > 0
      ? { unit: "percent", value: round((1 - reduction) * SINGLE_LINE * 100) }
      : { unit: "auto" };
  if ("pct" in spec)
    return {
      unit: "percent",
      value: round(Math.max(0.01, spec.pct - reduction) * SINGLE_LINE * 100),
    };
  return { unit: "pixels", value: round(Math.max(1, ptToPx(ctx, spec.pts))) };
}

function spaceOf(ctx: SlideContext, spec: ParagraphProps["spcBef"], sizePx: number): number {
  if (spec === undefined) return 0;
  return "pct" in spec ? spec.pct * sizePx * SINGLE_LINE : ptToPx(ctx, spec.pts);
}
