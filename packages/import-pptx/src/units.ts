/**
 * DrawingML units (ECMA-376 §20.1.10). Coordinates are EMU (English Metric Units): integers
 * that divide evenly into inches, centimetres and points.
 */

/** EMU per inch. */
export const EMU_PER_INCH = 914_400;
/** EMU per typographic point (1/72 in). */
export const EMU_PER_POINT = 12_700;
/** Percentages (ST_Percentage and friends) are thousandths of a percent: 100 000 = 100 %. */
export const PERCENT = 100_000;
/** Angles (ST_Angle) are 60 000ths of a degree. */
export const DEGREE = 60_000;

/**
 * Average advance width of a glyph as a fraction of the font size, for sans-serif Latin text
 * (Arial, Calibri and similar average close to half an em). Used where layout has to be
 * estimated without measuring text: table row heights and chart label columns.
 */
export const AVERAGE_GLYPH_ADVANCE = 0.5;
