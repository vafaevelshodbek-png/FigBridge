/**
 * Local text styles for imported text: created once per file by name, reused on later
 * imports, and linked only where the style's values equal the text's (so linking changes
 * nothing visible).
 */
import type { TextStyle as SceneTextStyle } from "@figbridge/scene";
import type { FontLoader } from "./fonts.js";

export class TextStyles {
  readonly #ids = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly fonts: FontLoader,
    private readonly warnings: string[],
  ) {}

  /** Id of the local style for `def`, creating it when missing; undefined when unusable. */
  id(def: SceneTextStyle): Promise<string | undefined> {
    let id = this.#ids.get(def.name);
    if (id === undefined) {
      id = this.#ensure(def);
      this.#ids.set(def.name, id);
    }
    return id;
  }

  async #ensure(def: SceneTextStyle): Promise<string | undefined> {
    const fontName = await this.fonts.resolve({ family: def.fontFamily, style: def.fontStyle });
    const wanted = {
      fontName,
      fontSize: def.fontSize,
      letterSpacing: { unit: "PIXELS", value: def.letterSpacing } as LetterSpacing,
      lineHeight: figmaLineHeight(def.lineHeight),
      textCase: CASE[def.textCase],
    };
    const existing = (await figma.getLocalTextStylesAsync()).find((s) => s.name === def.name);
    if (existing !== undefined) {
      if (sameValues(existing, wanted)) return existing.id;
      this.warnings.push(
        `text style "${def.name}" already exists with other values; imported text is not linked to it`,
      );
      return undefined;
    }
    const style = figma.createTextStyle();
    style.name = def.name;
    style.fontName = wanted.fontName;
    style.fontSize = wanted.fontSize;
    style.letterSpacing = wanted.letterSpacing;
    style.lineHeight = wanted.lineHeight;
    style.textCase = wanted.textCase;
    return style.id;
  }
}

const CASE = { original: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE" } as const;

export function figmaLineHeight(lineHeight: SceneTextStyle["lineHeight"]): LineHeight {
  return lineHeight.unit === "auto"
    ? { unit: "AUTO" }
    : { unit: lineHeight.unit === "pixels" ? "PIXELS" : "PERCENT", value: lineHeight.value };
}

function sameValues(
  style: TextStyle,
  wanted: {
    fontName: FontName;
    fontSize: number;
    letterSpacing: LetterSpacing;
    lineHeight: LineHeight;
    textCase: TextCase;
  },
): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const lineHeight = (h: LineHeight) =>
    h.unit === "AUTO" ? "AUTO" : `${h.unit}:${h.value.toFixed(2)}`;
  return (
    style.fontName.family === wanted.fontName.family &&
    style.fontName.style === wanted.fontName.style &&
    close(style.fontSize, wanted.fontSize) &&
    style.letterSpacing.unit === wanted.letterSpacing.unit &&
    close(style.letterSpacing.value, wanted.letterSpacing.value) &&
    lineHeight(style.lineHeight) === lineHeight(wanted.lineHeight) &&
    style.textCase === wanted.textCase
  );
}
