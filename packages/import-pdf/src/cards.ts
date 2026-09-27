/**
 * Groups every node that lies inside a card (a filled rectangle painted before it) with that
 * card, so moving the card moves its content. Tags (small pills) group the same way.
 */
import type { GroupNode, SceneNode } from "@figbridge/scene";

interface Placed {
  node: SceneNode;
  order: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Containers must be at most this fraction of the slide (full-page panels are not cards). */
const MAX_CARD_FRACTION = 0.9;
/** Containment tolerance in px (strokes and anti-aliasing overhang). */
const SLACK = 1.5;

function boxOf(node: SceneNode): Placed["box"] | undefined {
  if (node.type === "group") return undefined;
  return { x0: node.x, y0: node.y, x1: node.x + node.w, y1: node.y + node.h };
}

const area = (b: Placed["box"]) => (b.x1 - b.x0) * (b.y1 - b.y0);

function contains(outer: Placed["box"], inner: Placed["box"]): boolean {
  return (
    inner.x0 >= outer.x0 - SLACK &&
    inner.y0 >= outer.y0 - SLACK &&
    inner.x1 <= outer.x1 + SLACK &&
    inner.y1 <= outer.y1 + SLACK
  );
}

function overlaps(a: Placed["box"], b: Placed["box"]): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function reordersPaint(card: Placed, child: Placed, all: readonly Placed[]): boolean {
  return all.some(
    (other) =>
      other.order > card.order &&
      other.order < child.order &&
      overlaps(other.box, child.box) &&
      !contains(card.box, other.box),
  );
}

function isContainer(node: SceneNode): boolean {
  return (node.type === "rect" && node.fills.length > 0) || node.type === "image";
}

export function groupCards(
  nodes: readonly SceneNode[],
  slideArea: number,
  nextId: () => string,
): SceneNode[] {
  const placed: Placed[] = [];
  nodes.forEach((node, order) => {
    const box = boxOf(node);
    if (box !== undefined) placed.push({ node, order, box });
  });
  const parent = new Map<number, number>();
  for (const child of placed) {
    let best: Placed | undefined;
    for (const candidate of placed) {
      if (candidate.order >= child.order || !isContainer(candidate.node)) continue;
      if (area(candidate.box) > MAX_CARD_FRACTION * slideArea) continue;
      if (area(candidate.box) <= area(child.box) * 1.02) continue;
      if (!contains(candidate.box, child.box)) continue;
      if (best === undefined || area(candidate.box) < area(best.box)) best = candidate;
    }
    // Grouping moves the child next to its card in z-order. That is only safe when nothing
    // painted between the card and the child overlaps the child from outside the card.
    if (best !== undefined && !reordersPaint(best, child, placed))
      parent.set(child.order, best.order);
  }

  // Grouping must never change which of two overlapping layers is on top. The check above
  // only looks at each child alone; this one checks the whole result and ungroups offenders
  // (e.g. a panel the size of the card, painted between the card and its content).
  const byOrder = new Map(placed.map((p) => [p.order, p]));
  for (;;) {
    const sequence = flatten(
      nodes.map((_, order) => order).filter((o) => !parent.has(o)),
      parent,
    );
    const offender = firstSwap(sequence, byOrder, parent);
    if (offender === undefined) break;
    parent.delete(offender);
  }

  const build = (order: number): SceneNode => {
    const node = nodes[order];
    if (node === undefined) throw new Error(`node ${String(order)} missing`);
    const children = [...parent.entries()]
      .filter(([, p]) => p === order)
      .map(([c]) => c)
      .sort((a, b) => a - b);
    if (children.length === 0) return node;
    const group: GroupNode = {
      id: nextId(),
      name: node.type === "rect" && node.h < 48 ? "tag" : "card",
      type: "group",
      opacity: 1,
      visible: true,
      children: [node, ...children.map(build)],
    };
    return group;
  };

  return nodes
    .map((_, order) => order)
    .filter((order) => !parent.has(order))
    .map(build);
}

/** Paint order of the output: each root followed by its descendants, depth first. */
function flatten(roots: readonly number[], parent: ReadonlyMap<number, number>): number[] {
  const out: number[] = [];
  const visit = (order: number) => {
    out.push(order);
    [...parent.entries()]
      .filter(([, p]) => p === order)
      .map(([c]) => c)
      .sort((a, b) => a - b)
      .forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/**
 * A grouped node that now paints below something it used to cover (or above something that
 * used to cover it), or undefined when the output keeps every overlapping pair in order.
 */
function firstSwap(
  sequence: readonly number[],
  byOrder: ReadonlyMap<number, Placed>,
  parent: ReadonlyMap<number, number>,
): number | undefined {
  for (let i = 0; i < sequence.length; i++) {
    const a = byOrder.get(sequence[i] ?? -1);
    if (a === undefined) continue;
    for (let j = i + 1; j < sequence.length; j++) {
      const b = byOrder.get(sequence[j] ?? -1);
      if (b === undefined || a.order < b.order || !overlaps(a.box, b.box)) continue;
      if (parent.has(a.order)) return a.order;
      if (parent.has(b.order)) return b.order;
    }
  }
  return undefined;
}
