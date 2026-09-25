/**
 * Renders Scene IR into Figma nodes.
 *
 * Invariants learned the hard way:
 *  - Append a node to its final parent BEFORE setting its position. In Figma Slides files a
 *    node created on the page and moved into a frame later is shifted by the slide-grid offset.
 *  - Write `relativeTransform` for rotation/flips (Figma's `rotation` pivots on the corner).
 *  - Yield to the event loop periodically: the sandbox only flushes postMessage (progress,
 *    cancellation) between tasks, and long synchronous loops freeze the UI.
 */
import type { SceneNode as SceneNodeIR, Slide } from "@figbridge/scene";
import type { FontLoader } from "./fonts.js";
import { needsMatrix, type Placement, placementTransform, safeSize } from "./geometry.js";
import { applyStrokes, type ImageResolver, toFigmaPaints } from "./paints.js";
import { writeText } from "./text.js";

export interface RenderContext {
  fonts: FontLoader;
  images: ImageResolver;
  /** Checked between nodes; throw to abort. */
  readonly checkCancelled: () => void;
  readonly onNode?: () => void;
  warnings: string[];
}

/** Yield every this many nodes so progress/cancel messages get through. */
const YIELD_EVERY = 25;

export class SceneRenderer {
  #count = 0;

  constructor(private readonly ctx: RenderContext) {}

  get created(): number {
    return this.#count;
  }

  /** Create a frame for `slide` inside `parent` at (x, y). */
  async renderSlide(
    slide: Slide,
    parent: BaseNode & ChildrenMixin,
    x: number,
    y: number,
  ): Promise<FrameNode> {
    const frame = figma.createFrame();
    parent.appendChild(frame);
    frame.name = slide.name;
    frame.resize(slide.width, slide.height);
    frame.x = x;
    frame.y = y;
    frame.clipsContent = true;
    frame.fills = await toFigmaPaints(slide.background, this.ctx.images);
    await this.renderChildren(slide.children, frame);
    return frame;
  }

  async renderChildren(
    nodes: readonly SceneNodeIR[],
    parent: BaseNode & ChildrenMixin,
  ): Promise<SceneNode[]> {
    const created: SceneNode[] = [];
    for (const node of nodes) {
      const result = await this.#render(node, parent);
      if (result !== undefined) created.push(result);
    }
    return created;
  }

  async #render(
    node: SceneNodeIR,
    parent: BaseNode & ChildrenMixin,
  ): Promise<SceneNode | undefined> {
    this.ctx.checkCancelled();
    if (++this.#count % YIELD_EVERY === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    this.ctx.onNode?.();

    if (node.type === "group") {
      const children = await this.renderChildren(node.children, parent);
      if (children.length === 0) return undefined;
      const group =
        children.length === 1 && children[0] !== undefined
          ? children[0]
          : figma.group(children, parent);
      group.name = node.name;
      if (node.opacity < 1 && "opacity" in group) group.opacity *= node.opacity;
      if (!node.visible) group.visible = false;
      return group;
    }

    // The leaf is appended before it is configured (see the invariants above); if configuring
    // fails, remove it rather than leave an empty placeholder in the frame.
    const attached: { node?: SceneNode } = {};
    try {
      const created = await this.#renderLeaf(node, parent, attached);
      created.name = node.name;
      if (node.opacity < 1 && "opacity" in created) created.opacity = node.opacity;
      if (!node.visible) created.visible = false;
      return created;
    } catch (error) {
      attached.node?.remove();
      this.ctx.warnings.push(
        `${node.type} "${node.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async #renderLeaf(
    node: Exclude<SceneNodeIR, { type: "group" }>,
    parent: BaseNode & ChildrenMixin,
    attached: { node?: SceneNode },
  ): Promise<SceneNode> {
    const { images } = this.ctx;
    const attach = <T extends SceneNode>(created: T): T => {
      parent.appendChild(created);
      attached.node = created;
      return created;
    };
    switch (node.type) {
      case "rect": {
        const rect = attach(figma.createRectangle());
        rect.resize(safeSize(node.w), safeSize(node.h));
        rect.fills = await toFigmaPaints(node.fills, images);
        setRadii(rect, node.radii);
        await applyStrokes(rect, node.strokes, images);
        place(rect, node);
        return rect;
      }
      case "ellipse": {
        const ellipse = attach(figma.createEllipse());
        ellipse.resize(safeSize(node.w), safeSize(node.h));
        ellipse.fills = await toFigmaPaints(node.fills, images);
        await applyStrokes(ellipse, node.strokes, images);
        place(ellipse, node);
        return ellipse;
      }
      case "image": {
        const rect = attach(figma.createRectangle());
        rect.resize(safeSize(node.w), safeSize(node.h));
        rect.fills = await toFigmaPaints([node.image], images);
        setRadii(rect, node.radii);
        await applyStrokes(rect, node.strokes, images);
        place(rect, node);
        return rect;
      }
      case "vector": {
        const vector = attach(figma.createVector());
        vector.vectorPaths = node.paths.map((path) => ({
          windingRule: path.fillRule === "evenodd" ? "EVENODD" : "NONZERO",
          data: path.d,
        }));
        vector.fills = await toFigmaPaints(node.fills, images);
        await applyStrokes(vector, node.strokes, images);
        place(vector, { ...node, w: vector.width, h: vector.height });
        return vector;
      }
      case "text": {
        const text = attach(figma.createText());
        await writeText(text, node, this.ctx.fonts);
        if (node.sizing === "fixed") text.resize(safeSize(node.w), safeSize(node.h));
        else if (node.sizing === "height") text.resize(safeSize(node.w), text.height);
        place(text, { ...node, w: text.width, h: text.height });
        return text;
      }
    }
  }
}

function place(node: SceneNode & LayoutMixin, p: Placement): void {
  if (needsMatrix(p)) node.relativeTransform = placementTransform(p);
  else {
    node.x = p.x;
    node.y = p.y;
  }
}

function setRadii(rect: RectangleNode, radii: readonly [number, number, number, number]): void {
  const [tl, tr, br, bl] = radii;
  if (tl === tr && tr === br && br === bl) {
    rect.cornerRadius = tl;
    return;
  }
  rect.topLeftRadius = tl;
  rect.topRightRadius = tr;
  rect.bottomRightRadius = br;
  rect.bottomLeftRadius = bl;
}
