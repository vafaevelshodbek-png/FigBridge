/**
 * Typeface names in PPTX ("Inter SemiBold", "Montserrat Bold", "Calibri Light") → Figma
 * family + style. Bold/italic run flags are applied on top of the name's own weight.
 */
const WEIGHTS: readonly (readonly [RegExp, number])[] = [
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*light|ultra\s*light/i, 200],
  [/black|heavy/i, 900],
  [/medium/i, 500],
  [/bold/i, 700],
  [/light/i, 300],
  [/thin/i, 100],
];

const STYLE_NAMES: Readonly<Record<number, string>> = {
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

const STYLE_SUFFIX =
  /\s+(extra\s*bold|ultra\s*bold|semi\s*bold|demi\s*bold|extra\s*light|ultra\s*light|black|heavy|medium|bold|light|thin|regular|italic)$/i;

export function parseFontStyle(
  typeface: string,
  bold: boolean,
  italic: boolean,
): { family: string; style: string } {
  let family = typeface.trim() || "Inter";
  for (let guard = 0; guard < 3 && STYLE_SUFFIX.test(family); guard++)
    family = family.replace(STYLE_SUFFIX, "");
  let weight = WEIGHTS.find(([pattern]) => pattern.test(typeface))?.[1] ?? 400;
  if (bold && weight < 600) weight = 700;
  const upright = STYLE_NAMES[weight] ?? "Regular";
  const isItalic = italic || /italic/i.test(typeface);
  return {
    family,
    style: isItalic ? (upright === "Regular" ? "Italic" : `${upright} Italic`) : upright,
  };
}
