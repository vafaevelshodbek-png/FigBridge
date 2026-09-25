/**
 * DrawingML colours: scheme colours through the colour map, and colour transforms.
 *
 * A colour element (`srgbClr`, `schemeClr`, …) may carry transform children that apply in
 * document order: `lumMod`/`lumOff` work in HSL, `tint`/`shade` blend towards white/black,
 * `alpha` sets opacity. The formulas are the ones the Python prototype used; its output was
 * checked against PowerPoint renders of the same slides.
 */

import { DEGREE, PERCENT } from "./units.js";
import { attr, num, type XmlElement } from "./xml.js";

/** An sRGB colour with opacity. */
export interface Rgba {
  /** `#RRGGBB`, upper case. */
  color: string;
  /** Opacity in [0, 1]. */
  alpha: number;
}

/** Everything needed to resolve scheme colours on one slide. */
export interface ColorContext {
  /** Theme colour scheme: `dk1`, `lt1`, `accent1`, … → `RRGGBB`. */
  readonly scheme: ReadonlyMap<string, string>;
  /** Colour map (master `clrMap` or slide override): `tx1` → `dk1`, … */
  readonly map: Readonly<Record<string, string>>;
}

const PRESET_COLORS: Readonly<Record<string, string>> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  lime: "00FF00",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  orange: "FFA500",
  navy: "000080",
  darkGray: "A9A9A9",
  lightGray: "D3D3D3",
};

const COLOR_ELEMENTS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"]);

/** Scheme colour name → hex, following the colour map (`tx1` → `dk1`). */
export function schemeColor(ctx: ColorContext, name: string): string {
  const mapped = ctx.map[name] ?? name;
  return ctx.scheme.get(mapped) ?? ctx.scheme.get(name) ?? "000000";
}

/**
 * Resolve the colour held by `container` (a `solidFill`, `gs`, `fgClr`, `fontRef`, …).
 * `placeholder` substitutes `phClr` (theme style matrices reference it).
 */
export function resolveColor(
  container: XmlElement | undefined,
  ctx: ColorContext,
  placeholder?: Rgba,
): Rgba | undefined {
  const el = container?.children.find((c) => COLOR_ELEMENTS.has(c.name));
  if (el === undefined) return undefined;
  let rgb: [number, number, number];
  let alpha = 1;
  switch (el.name) {
    case "schemeClr": {
      const value = attr(el, "val") ?? "tx1";
      if (value === "phClr" && placeholder !== undefined) {
        rgb = hexToRgb(placeholder.color);
        alpha = placeholder.alpha;
      } else rgb = hexToRgb(schemeColor(ctx, value));
      break;
    }
    case "sysClr":
      rgb = hexToRgb(attr(el, "lastClr") ?? (attr(el, "val") === "window" ? "FFFFFF" : "000000"));
      break;
    case "prstClr":
      rgb = hexToRgb(PRESET_COLORS[attr(el, "val") ?? ""] ?? "000000");
      break;
    case "scrgbClr":
      rgb = [
        linearToSrgb(num(el, "r", 0) / PERCENT),
        linearToSrgb(num(el, "g", 0) / PERCENT),
        linearToSrgb(num(el, "b", 0) / PERCENT),
      ];
      break;
    case "hslClr":
      rgb = hslToRgb(
        num(el, "hue", 0) / DEGREE / 360,
        num(el, "sat", 0) / PERCENT,
        num(el, "lum", 0) / PERCENT,
      );
      break;
    default:
      rgb = hexToRgb(attr(el, "val") ?? "000000");
  }
  return applyTransforms(rgb, alpha, el.children);
}

/** Apply DrawingML colour transforms in document order. Exported for tests. */
export function applyTransforms(
  start: readonly [number, number, number],
  startAlpha: number,
  transforms: readonly XmlElement[],
): Rgba {
  let [r, g, b] = start;
  let alpha = startAlpha;
  for (const t of transforms) {
    const v = num(t, "val", 0) / PERCENT;
    switch (t.name) {
      case "lumMod":
      case "lumOff":
      case "satMod":
      case "satOff":
      case "hueMod":
      case "hueOff": {
        let [h, s, l] = rgbToHsl(r, g, b);
        if (t.name === "lumMod") l *= v;
        else if (t.name === "lumOff") l += v;
        else if (t.name === "satMod") s *= v;
        else if (t.name === "satOff") s += v;
        else if (t.name === "hueMod") h = (h * v) % 1;
        else h = (h + num(t, "val", 0) / DEGREE / 360) % 1;
        [r, g, b] = hslToRgb(h, clamp01(s), clamp01(l));
        break;
      }
      // Tint and shade operate in linear light (as PowerPoint renders them); doing it in
      // sRGB makes tinted fills visibly too dark (e.g. black 20 % tint → #CCC instead of #E6E6E6).
      case "tint":
        [r, g, b] = [r, g, b].map((x) => linearToSrgb(1 - (1 - srgbToLinear(x)) * v)) as [
          number,
          number,
          number,
        ];
        break;
      case "shade":
        [r, g, b] = [r, g, b].map((x) => linearToSrgb(srgbToLinear(x) * v)) as [
          number,
          number,
          number,
        ];
        break;
      case "alpha":
        alpha = v;
        break;
      case "alphaMod":
        alpha *= v;
        break;
      case "alphaOff":
        alpha += v;
        break;
      case "inv":
        [r, g, b] = [1 - r, 1 - g, 1 - b];
        break;
      case "gray": {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        [r, g, b] = [y, y, y];
        break;
      }
      default:
        break;
    }
  }
  return { color: rgbToHex(r, g, b), alpha: Math.round(clamp01(alpha) * 1000) / 1000 };
}

// ── conversions ──────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  // Accepts "RRGGBB" (OOXML) and "#RRGGBB" (resolved colours fed back as phClr).
  const bare = hex.startsWith("#") ? hex.slice(1) : hex;
  const clean = /^[0-9A-Fa-f]{6}$/.test(bare) ? bare : "000000";
  return [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const byte = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

/** HSL with every component in [0, 1] (same convention as Python's colorsys). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    const t = ((t0 % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(x: number): number {
  const c = clamp01(x);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
