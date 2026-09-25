/**
 * Placeholder inheritance: a slide placeholder takes its position, text body properties and
 * list styles from the matching placeholder on the layout, which takes them from the master.
 */
import type { Part, SlideContext } from "./context.js";
import { attr, child, find, findAll, path, type XmlElement } from "./xml.js";

export interface PlaceholderRef {
  type: string;
  idx: string | undefined;
}

/** The `p:ph` of a shape, if it is a placeholder. */
export function placeholderOf(shape: XmlElement): PlaceholderRef | undefined {
  const ph = find(
    child(shape, "nvSpPr") ?? child(shape, "nvPicPr") ?? child(shape, "nvGraphicFramePr"),
    "ph",
  );
  if (ph === undefined) return undefined;
  return { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") };
}

/** Placeholder types that share one family for matching purposes. */
function family(type: string): string {
  if (type === "ctrTitle") return "title";
  if (type === "subTitle" || type === "obj") return "body";
  return type;
}

/** The matching placeholder shape in `part` (by idx first, then by type). */
export function matchPlaceholder(
  part: Part | undefined,
  ref: PlaceholderRef,
): XmlElement | undefined {
  const tree = path(part?.root, "cSld/spTree");
  if (tree === undefined) return undefined;
  const shapes = findAll(tree, "sp");
  let byType: XmlElement | undefined;
  for (const shape of shapes) {
    const other = placeholderOf(shape);
    if (other === undefined) continue;
    if (ref.idx !== undefined && other.idx === ref.idx) return shape;
    if (byType === undefined && family(other.type) === family(ref.type)) byType = shape;
  }
  return byType;
}

/** Layout and master placeholders a slide placeholder inherits from (master first). */
export function inheritanceChain(ctx: SlideContext, ref: PlaceholderRef | undefined): XmlElement[] {
  if (ref === undefined) return [];
  return [matchPlaceholder(ctx.master, ref), matchPlaceholder(ctx.layout, ref)].filter(
    (shape): shape is XmlElement => shape !== undefined,
  );
}

/** Master text style for a placeholder type (title/body/other). */
export function masterTextStyle(
  ctx: SlideContext,
  ref: PlaceholderRef | undefined,
): XmlElement | undefined {
  const styles = path(ctx.master?.root, "txStyles");
  if (ref === undefined) return child(styles, "otherStyle");
  const kind = family(ref.type);
  if (kind === "title") return child(styles, "titleStyle");
  if (kind === "body") return child(styles, "bodyStyle");
  return child(styles, "otherStyle");
}
