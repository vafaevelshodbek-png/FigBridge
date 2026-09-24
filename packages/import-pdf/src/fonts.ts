/**
 * PDF font names → Figma family + style.
 *
 * PDF names look like "ABCDEF+AllianceNo.2-SemiBold" or "Helvetica-BoldOblique": a subset
 * prefix, a family and a style suffix. When the family is not installed, the plugin falls
 * back to Inter with the same style (see packages/plugin/src/main/render/fonts.ts).
 */

const WEIGHTS: readonly (readonly [RegExp, number])[] = [
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*light|ultra\s*light/i, 200],
  [/black|heavy/i, 900],
  [/medium/i, 500],
  [/bold/i, 700],
  [/light/i, 300],
  [/thin|hairline/i, 100],
];

const STYLE_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

/** Style words stripped from the family part ("Roboto Light" → "Roboto"). */
const STYLE_WORDS =
  /[\s-]*(extra\s*bold|ultra\s*bold|semi\s*bold|demi\s*bold|extra\s*light|ultra\s*light|black|heavy|medium|bold|light|thin|regular|book|roman|normal|italic|oblique|mt|ps)$/i;

export interface FontFace {
  family: string;
  style: string;
}

export function parseFontName(pdfName: string): FontFace {
  // Subset prefix: six uppercase letters and '+'.
  const name = pdfName.replace(/^[A-Z]{6}\+/, "").trim() || "Inter";
  const [familyPart, stylePart]: [string, string] = name.includes("-")
    ? [name.slice(0, name.indexOf("-")), name.slice(name.indexOf("-") + 1)]
    : [name, ""];

  let family = familyPart;
  // Families with the style glued on ("RobotoLight", "Arial Bold") lose it repeatedly.
  for (let guard = 0; guard < 3 && STYLE_WORDS.test(family); guard++)
    family = family.replace(STYLE_WORDS, "");
  family = family.trim() || familyPart;

  const styleSource = `${stylePart} ${familyPart}`;
  const weight = WEIGHTS.find(([pattern]) => pattern.test(styleSource))?.[1] ?? 400;
  const italic = /italic|oblique/i.test(styleSource);
  const upright = STYLE_NAMES[weight] ?? "Regular";
  const style = italic ? (upright === "Regular" ? "Italic" : `${upright} Italic`) : upright;
  return { family, style };
}
