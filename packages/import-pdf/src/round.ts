/** Round to hundredths of a pixel: stable JSON and no sub-pixel noise in the Scene. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
