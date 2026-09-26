/**
 * Preset shapes that are drawn with arcs or bends, after the formulas in ECMA-376's
 * presetShapeDefinitions.xml: connectors (bent and curved), pie, chord, arc, block arc,
 * donut and braces. Coordinates are the shape's local box (0..w, 0..h); angles are the
 * spec's clockwise degrees.
 */
import { ellipseArcCubics } from "@figbridge/scene";

export interface PresetPath {
  d: string;
  fillRule: "nonzero" | "evenodd";
  filled: boolean;
  stroked: boolean;
}

const PERCENT = 100_000;
const DEGREE = 60_000;

const f = (n: number) => String(Math.round(n * 100) / 100);
const stroke = (d: string): PresetPath => ({
  d,
  fillRule: "nonzero",
  filled: false,
  stroked: true,
});
const shape = (d: string, fillRule: "nonzero" | "evenodd" = "nonzero"): PresetPath => ({
  d,
  fillRule,
  filled: true,
  stroked: true,
});

/** Paths of `preset`, or undefined when it is not one of these. */
export function arcPresetPaths(
  preset: string,
  w: number,
  h: number,
  adj: ReadonlyMap<string, number>,
): PresetPath[] | undefined {
  const a = (name: string, fallback: number) => adj.get(name) ?? fallback;
  const frac = (name: string, fallback: number) => a(name, fallback) / PERCENT;
  const deg = (name: string, fallback: number) => a(name, fallback) / DEGREE;
  const cx = w / 2;
  const cy = h / 2;
  const at = (rx: number, ry: number, angle: number): string => {
    const t = (angle * Math.PI) / 180;
    return `${f(cx + rx * Math.cos(t))} ${f(cy + ry * Math.sin(t))}`;
  };
  const sweepOf = (start: number, end: number) => (((end - start) % 360) + 360) % 360 || 360;

  switch (preset) {
    case "bentConnector2":
      return [stroke(`M 0 0 L ${f(w)} 0 L ${f(w)} ${f(h)}`)];
    case "bentConnector3": {
      const x1 = w * frac("adj1", 50_000);
      return [stroke(`M 0 0 L ${f(x1)} 0 L ${f(x1)} ${f(h)} L ${f(w)} ${f(h)}`)];
    }
    case "bentConnector4": {
      const x1 = w * frac("adj1", 50_000);
      const y2 = h * frac("adj2", 50_000);
      return [
        stroke(`M 0 0 L ${f(x1)} 0 L ${f(x1)} ${f(y2)} L ${f(w)} ${f(y2)} L ${f(w)} ${f(h)}`),
      ];
    }
    case "bentConnector5": {
      const x1 = w * frac("adj1", 50_000);
      const y2 = h * frac("adj2", 50_000);
      const x3 = w * frac("adj3", 50_000);
      return [
        stroke(
          `M 0 0 L ${f(x1)} 0 L ${f(x1)} ${f(y2)} L ${f(x3)} ${f(y2)} L ${f(x3)} ${f(h)} L ${f(w)} ${f(h)}`,
        ),
      ];
    }
    case "curvedConnector2":
      return [stroke(`M 0 0 C ${f(w / 2)} 0 ${f(w)} ${f(h / 2)} ${f(w)} ${f(h)}`)];
    case "curvedConnector3": {
      const x2 = w * frac("adj1", 50_000);
      const x1 = x2 / 2;
      const x3 = (w + x2) / 2;
      return [
        stroke(
          `M 0 0 C ${f(x1)} 0 ${f(x2)} ${f(h / 4)} ${f(x2)} ${f(h / 2)} C ${f(x2)} ${f((3 * h) / 4)} ${f(x3)} ${f(h)} ${f(w)} ${f(h)}`,
        ),
      ];
    }
    case "pie": {
      const start = deg("adj1", 0);
      const sweep = sweepOf(start, deg("adj2", 16_200_000));
      return [
        shape(
          `M ${f(cx)} ${f(cy)} L ${at(cx, cy, start)} ${ellipseArcCubics(cx, cy, cx, cy, start, sweep)} Z`,
        ),
      ];
    }
    case "chord": {
      const start = deg("adj1", 2_700_000);
      const sweep = sweepOf(start, deg("adj2", 16_200_000));
      return [shape(`M ${at(cx, cy, start)} ${ellipseArcCubics(cx, cy, cx, cy, start, sweep)} Z`)];
    }
    case "arc": {
      const start = deg("adj1", 16_200_000);
      const sweep = sweepOf(start, deg("adj2", 0));
      const arc = ellipseArcCubics(cx, cy, cx, cy, start, sweep);
      // The spec's arc fills the pie wedge but strokes only the curve.
      return [
        {
          d: `M ${f(cx)} ${f(cy)} L ${at(cx, cy, start)} ${arc} Z`,
          fillRule: "nonzero",
          filled: true,
          stroked: false,
        },
        stroke(`M ${at(cx, cy, start)} ${arc}`),
      ];
    }
    case "blockArc": {
      const start = deg("adj1", 10_800_000);
      const sweep = sweepOf(start, deg("adj2", 0));
      const thickness = Math.min(w, h) * frac("adj3", 25_000);
      const ix = Math.max(0, cx - thickness);
      const iy = Math.max(0, cy - thickness);
      const end = start + sweep;
      return [
        shape(
          `M ${at(cx, cy, start)} ${ellipseArcCubics(cx, cy, cx, cy, start, sweep)} L ${at(ix, iy, end)} ${ellipseArcCubics(cx, cy, ix, iy, end, -sweep)} Z`,
        ),
      ];
    }
    case "donut": {
      const thickness = Math.min(w, h) * frac("adj", 25_000);
      const ix = Math.max(0, cx - thickness);
      const iy = Math.max(0, cy - thickness);
      return [
        shape(
          `M ${at(cx, cy, 0)} ${ellipseArcCubics(cx, cy, cx, cy, 0, 360)} Z M ${at(ix, iy, 0)} ${ellipseArcCubics(cx, cy, ix, iy, 0, 360)} Z`,
          "evenodd",
        ),
      ];
    }
    case "leftBrace":
    case "rightBrace": {
      // Curl size from adj1 (of the short side), the point's height from adj2.
      const q = Math.min(Math.min(w, h) * frac("adj1", 8_333) * 2, h / 4);
      const y = h * frac("adj2", 50_000);
      const tip = preset === "leftBrace" ? 0 : w;
      const back = w - tip;
      const mid = w / 2;
      return [
        stroke(
          `M ${f(back)} 0 Q ${f(mid)} 0 ${f(mid)} ${f(q)} L ${f(mid)} ${f(y - q)} Q ${f(mid)} ${f(y)} ${f(tip)} ${f(y)} ` +
            `Q ${f(mid)} ${f(y)} ${f(mid)} ${f(y + q)} L ${f(mid)} ${f(h - q)} Q ${f(mid)} ${f(h)} ${f(back)} ${f(h)}`,
        ),
      ];
    }
    default:
      return undefined;
  }
}
