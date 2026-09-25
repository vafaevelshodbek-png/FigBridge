/**
 * Per-slide conversion context: the slide → layout → master → theme chain, colour and
 * font resolution, output units, and the sinks for blobs and warnings.
 */
import type { Paint } from "@figbridge/scene";
import type { ColorContext } from "./color.js";
import type { Package } from "./package.js";
import { attr, child, childrenOf, path, type XmlElement } from "./xml.js";

/** EMU per typographic point (and per pixel of a 1920-wide 16:9 slide at scale 1). */
export const EMU_PER_POINT = 12_700;

export interface Part {
  /** Absolute part name, e.g. `ppt/slides/slide1.xml`. */
  readonly name: string;
  readonly root: XmlElement;
}

export interface Theme {
  readonly scheme: ReadonlyMap<string, string>;
  /** Latin typefaces of the font scheme (`+mj-lt`, `+mn-lt`). */
  readonly majorFont: string;
  readonly minorFont: string;
  /** Format scheme matrices referenced by `fillRef`/`lnRef`/`bgRef` indices. */
  readonly fillStyles: readonly XmlElement[];
  readonly bgFillStyles: readonly XmlElement[];
  readonly lineStyles: readonly XmlElement[];
}

export type BlobStore = Map<string, { bytes: Uint8Array; mimeType: string }>;

export interface SlideContext {
  readonly pkg: Package;
  /** Output pixels per EMU. */
  readonly scale: number;
  /** 1-based slide number (for `slidenum` fields and messages). */
  readonly slideNumber: number;
  readonly slide: Part;
  readonly layout: Part | undefined;
  readonly master: Part | undefined;
  readonly theme: Theme;
  readonly colors: ColorContext;
  /** `presentation.xml` default text style (base for non-placeholder text). */
  readonly defaultTextStyle: XmlElement | undefined;
  readonly blobs: BlobStore;
  /** Fills of the enclosing groups, innermost last (for `grpFill`). */
  readonly groupFills: Paint[][];
  warn(message: string): void;
  nextId(): string;
}

const FALLBACK_FONT = "Inter";

/** Parse a theme part; missing pieces fall back to Office defaults. */
export function readTheme(root: XmlElement | undefined): Theme {
  const elements = path(root, "themeElements");
  const scheme = new Map<string, string>();
  for (const entry of child(elements, "clrScheme")?.children ?? []) {
    const srgb = child(entry, "srgbClr");
    const sys = child(entry, "sysClr");
    const value = attr(srgb, "val") ?? attr(sys, "lastClr");
    if (value !== undefined) scheme.set(entry.name, value);
  }
  const fonts = child(elements, "fontScheme");
  const format = child(elements, "fmtScheme");
  return {
    scheme,
    majorFont: attr(path(fonts, "majorFont/latin"), "typeface") ?? FALLBACK_FONT,
    minorFont: attr(path(fonts, "minorFont/latin"), "typeface") ?? FALLBACK_FONT,
    fillStyles: child(format, "fillStyleLst")?.children ?? [],
    bgFillStyles: child(format, "bgFillStyleLst")?.children ?? [],
    lineStyles: childrenOf(child(format, "lnStyleLst"), "ln"),
  };
}

/** Theme font references (`+mj-lt`, `+mn-ea`, …) → the theme's Latin typeface. */
export function resolveTypeface(theme: Theme, typeface: string | undefined): string | undefined {
  if (typeface === undefined || typeface === "") return undefined;
  if (typeface.startsWith("+mj")) return theme.majorFont;
  if (typeface.startsWith("+mn")) return theme.minorFont;
  return typeface;
}

/** EMU → output pixels. */
export function px(ctx: Pick<SlideContext, "scale">, emu: number): number {
  return emu * ctx.scale;
}

/** Points → output pixels. */
export function ptToPx(ctx: Pick<SlideContext, "scale">, points: number): number {
  return points * EMU_PER_POINT * ctx.scale;
}

/** Round to hundredths: stable JSON, no sub-pixel noise. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
