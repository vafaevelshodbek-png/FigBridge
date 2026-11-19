/** Scale the editable geometry, retaining original image bytes and SVG path data. */
export function scaleCapture(slide, factor) {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Scale must be positive and finite");
  const result = structuredClone(slide);
  const scale = (n) => {
    for (const k of ["x", "y", "w", "h"]) if (typeof n[k] === "number") n[k] *= factor;
    n.radii = n.radii?.map((x) => x * factor);
    for (const e of n.effects || []) {
      e.radius *= factor;
      if (e.spread !== undefined) e.spread *= factor;
      if (e.offset) {
        e.offset.x *= factor;
        e.offset.y *= factor;
      }
    }
    for (const s of n.strokes || []) {
      s.weight *= factor;
      if (s.dash) s.dash = s.dash.map((x) => x * factor);
    }
    for (const r of n.runs || []) {
      r.fontSize *= factor;
      if (r.letterSpacing) r.letterSpacing *= factor;
    }
    for (const p of n.paragraphs || []) {
      if (p.lineHeight?.unit === "pixels") p.lineHeight.value *= factor;
      for (const k of ["spaceBefore", "spaceAfter"]) if (p[k]) p[k] *= factor;
    }
    n.children?.forEach(scale);
  };
  result.width *= factor;
  result.height *= factor;
  result.children.forEach(scale);
  return result;
}
