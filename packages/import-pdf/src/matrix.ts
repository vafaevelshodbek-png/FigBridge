/**
 * 2D affine matrices in PDF order [a, b, c, d, e, f]:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer ∘ inner`: apply `inner` first, then `outer` (PDF's `cm` is `multiply(ctm, m)`). */
export function multiply(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Uniform scale factor of a matrix (geometric mean of the axis scales); used for line widths. */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function toMatrix(values: ArrayLike<number>): Matrix {
  return [
    values[0] ?? 1,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 1,
    values[4] ?? 0,
    values[5] ?? 0,
  ];
}
