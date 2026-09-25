/**
 * Shape transforms: `a:xfrm` boxes and group coordinate spaces.
 *
 * Scene groups have no geometry, so a child's box is mapped out of every enclosing group
 * (`chOff`/`chExt` child space → group box, then the group's flips and rotation) into slide
 * coordinates. Rotation is clockwise degrees around the box centre, as in both OOXML and Scene.
 */
import { bool, child, num, type XmlElement } from "./xml.js";

/** OOXML angles: 60000ths of a degree. */
const DEGREE = 60_000;

/** A placed box in output pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise, [0, 360). */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/** A group's box plus the child coordinate space its children are expressed in. */
export interface GroupFrame extends Box {
  chX: number;
  chY: number;
  chW: number;
  chH: number;
}

/** Read `xfrm` (DrawingML `a:xfrm` or PresentationML `p:xfrm`) in output pixels. */
export function readXfrm(xfrm: XmlElement | undefined, scale: number): Box | undefined {
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  if (off === undefined) return undefined;
  return {
    x: num(off, "x", 0) * scale,
    y: num(off, "y", 0) * scale,
    w: Math.max(0, num(ext, "cx", 0) * scale),
    h: Math.max(0, num(ext, "cy", 0) * scale),
    rot: normalizeAngle(num(xfrm, "rot", 0) / DEGREE),
    flipH: bool(xfrm, "flipH") ?? false,
    flipV: bool(xfrm, "flipV") ?? false,
  };
}

/** Read a group's `a:xfrm` including its child space; identity when absent. */
export function readGroupFrame(xfrm: XmlElement | undefined, scale: number): GroupFrame {
  const box = readXfrm(xfrm, scale) ?? {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rot: 0,
    flipH: false,
    flipV: false,
  };
  const chOff = child(xfrm, "chOff");
  const chExt = child(xfrm, "chExt");
  return {
    ...box,
    chX: num(chOff, "x", 0) * scale,
    chY: num(chOff, "y", 0) * scale,
    chW: num(chExt, "cx", 0) * scale,
    chH: num(chExt, "cy", 0) * scale,
  };
}

/** Map a box from a group's child space into the group's parent space. */
export function mapThroughGroup(t: Box, g: GroupFrame): Box {
  // An empty child extent (degenerate groups written by some tools) means identity scale.
  const sx = g.chW > 0 ? g.w / g.chW : 1;
  const sy = g.chH > 0 ? g.h / g.chH : 1;
  let cx = g.x + (t.x + t.w / 2 - g.chX) * sx;
  let cy = g.y + (t.y + t.h / 2 - g.chY) * sy;
  let rot = t.rot;
  let flipH = t.flipH;
  let flipV = t.flipV;
  const gcx = g.x + g.w / 2;
  const gcy = g.y + g.h / 2;
  if (g.flipH) {
    cx = 2 * gcx - cx;
    rot = -rot;
    flipH = !flipH;
  }
  if (g.flipV) {
    cy = 2 * gcy - cy;
    rot = -rot;
    flipV = !flipV;
  }
  if (g.rot !== 0) {
    [cx, cy] = rotateAround(cx, cy, gcx, gcy, g.rot);
    rot += g.rot;
  }
  const w = t.w * sx;
  const h = t.h * sy;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: normalizeAngle(rot), flipH, flipV };
}

/** Map through all enclosing groups (outermost first in `groups`). */
export function mapThroughGroups(t: Box, groups: readonly GroupFrame[]): Box {
  let out = t;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group !== undefined) out = mapThroughGroup(out, group);
  }
  return out;
}

/** Rotate point (x, y) clockwise by `degrees` around (cx, cy), in y-down coordinates. */
export function rotateAround(
  x: number,
  y: number,
  cx: number,
  cy: number,
  degrees: number,
): [number, number] {
  const a = (degrees * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Map a point in a box's local space (0..w, 0..h) to slide space, applying flips and rotation. */
export function localToSlide(box: Box, lx: number, ly: number): [number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = box.flipH ? box.w - lx : lx;
  const y = box.flipV ? box.h - ly : ly;
  return rotateAround(box.x + x, box.y + y, cx, cy, box.rot);
}

export function normalizeAngle(degrees: number): number {
  const a = degrees % 360;
  return Math.round((a < 0 ? a + 360 : a) * 1000) / 1000;
}
