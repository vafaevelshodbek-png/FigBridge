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
import { pathBounds } from "@figbridge/scene/path";
import { ColorVariables } from "./color-variables.js";
import type { FontLoader } from "./fonts.js";
import {
  needsMatrix,
  type Placement,
  placementTransform,
  safeSize,
  translateLocal,
} from "./geometry.js";
import { applyStrokes, type ImageResolver, toFigmaPaints } from "./paints.js";
import { type StyleLinks, writeText } from "./text.js";
import { TextStyles } from "./text-styles.js";

export interface RenderContext {
  fonts: FontLoader;
  images: ImageResolver;
  /** Checked between nodes; throw to abort. */
  readonly checkCancelled: () => void;
  readonly onNode?: () => void;
  readonly yieldControl?: () => Promise<void>;
  warnings: string[];
}

/** Yield every this many nodes so progress/cancel messages get through. */
const YIELD_EVERY = 25;

export class SceneRenderer {
  #count = 0;
  #links: StyleLinks | undefined;
  #variables: ColorVariables | undefined;

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
    try {
      frame.name = slide.name;
      frame.resize(slide.width, slide.height);
      frame.x = x;
      frame.y = y;
      frame.clipsContent = true;
      this.#variables =
        slide.colorVariables === undefined
          ? undefined
          : new ColorVariables(slide.colorVariables, this.ctx.warnings);
      frame.fills = await toFigmaPaints(slide.background, this.ctx.images, this.#variables);
      const defs = slide.textStyles ?? [];
      this.#links =
        defs.length === 0
          ? undefined
          : {
              styles: new TextStyles(this.ctx.fonts, this.ctx.warnings),
              defs: new Map(defs.map((d) => [d.name, d])),
            };
      await this.renderChildren(slide.children, frame);
      return frame;
    } catch (error) {
      if (!frame.removed) frame.remove();
      throw error;
    }
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
    if (++this.#count % YIELD_EVERY === 0) {
      if (this.ctx.yieldControl) await this.ctx.yieldControl();
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
      created.setPluginData("figbridge.sourceId", node.id);
      if (node.source !== undefined) created.setPluginData("figbridge.source", node.source);
      if (node.opacity < 1 && "opacity" in created) created.opacity = node.opacity;
      if (!node.visible) created.visible = false;
      if (node.type === "text" && node.effects !== undefined && "effects" in created)
        created.effects = node.effects;
      return created;
    } catch (error) {
      if (attached.node && !attached.node.removed) attached.node.remove();
      this.ctx.warnings.push(
        `${node.type} "${node.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Measure, with the fonts Figma actually used, whether text still fits the room the source
   * gave it; a replacement font often runs longer. Fixed boxes are measured by letting the
   * height follow the content for a moment.
   */
  #checkOverflow(text: TextNode, node: Extract<SceneNodeIR, { type: "text" }>): void {
    let needed: number;
    let box: number;
    let axis: "height" | "width";
    if (node.sizing === "fixed") {
      text.textAutoResize = "HEIGHT";
      needed = text.height;
      text.textAutoResize = "NONE";
      text.resize(safeSize(node.w), safeSize(node.h));
      box = node.h;
      axis = "height";
    } else if (node.sizing === "height") {
      needed = text.height;
      box = node.h;
      axis = "height";
    } else {
      needed = text.width;
      box = node.w;
      axis = "width";
    }
    if (!overflows(needed, box)) return;
    this.ctx.warnings.push(
      `text "${node.name}" overflows: needs ${String(Math.round(needed))} px of ${axis}, the source gave ${String(Math.round(box))} px (a replacement font runs longer)`,
    );
    text.setPluginData("figbridge.overflow", String(Math.round(needed - box)));
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
      case "frame": {
        const frame = attach(node.component ? figma.createComponent() : figma.createFrame());
        frame.resize(safeSize(node.w), safeSize(node.h));
        frame.fills =
          node.mask === undefined ? await toFigmaPaints(node.fills, images, this.#variables) : [];
        setRadii(frame, node.radii);
        if (node.mask === undefined)
          await applyStrokes(frame, node.strokes, images, this.#variables);
        frame.clipsContent = node.clip;
        frame.overflowDirection = node.overflow;
        frame.effects = node.effects.map(
          (effect): Effect => ("color" in effect ? effect : { ...effect, blurType: "NORMAL" }),
        );
        if (node.blendMode !== undefined) frame.blendMode = node.blendMode;
        place(frame, node);
        if (node.mask !== undefined) {
          const mask = figma.createRectangle();
          frame.appendChild(mask);
          mask.resize(safeSize(node.w), safeSize(node.h));
          mask.x = 0;
          mask.y = 0;
          mask.name = "CSS alpha mask";
          mask.fills = await toFigmaPaints(node.mask, images, this.#variables);
          mask.isMask = true;
          mask.maskType = "ALPHA";
          // A Figma child mask does not mask its parent's own fills/border. CSS
          // masks cover those too, so paint them as the first masked child.
          if (node.fills.length > 0 || node.strokes.length > 0) {
            const background = figma.createRectangle();
            frame.appendChild(background);
            background.name = "CSS masked background";
            background.resize(safeSize(node.w), safeSize(node.h));
            background.x = 0;
            background.y = 0;
            background.fills = await toFigmaPaints(node.fills, images, this.#variables);
            setRadii(background, node.radii);
            await applyStrokes(background, node.strokes, images, this.#variables);
          }
        }
        await this.renderChildren(node.children, frame);
        if (node.mask !== undefined && frame.children.length > 1) {
          const content = figma.group(frame.children.slice(1), frame);
          content.name = "CSS masked contents";
        }
        return frame;
      }
      case "svg": {
        const frame = attach(figma.createNodeFromSvg(node.svg));
        frame.rescale(safeSize(node.w) / frame.width);
        if (Math.abs(frame.height - node.h) > 0.01)
          frame.resize(safeSize(node.w), safeSize(node.h));
        place(frame, node);
        return frame;
      }
      case "rect": {
        const rect = attach(figma.createRectangle());
        rect.resize(safeSize(node.w), safeSize(node.h));
        rect.fills = await toFigmaPaints(node.fills, images, this.#variables);
        setRadii(rect, node.radii);
        await applyStrokes(rect, node.strokes, images, this.#variables);
        place(rect, node);
        return rect;
      }
      case "ellipse": {
        const ellipse = attach(figma.createEllipse());
        ellipse.resize(safeSize(node.w), safeSize(node.h));
        ellipse.fills = await toFigmaPaints(node.fills, images, this.#variables);
        await applyStrokes(ellipse, node.strokes, images, this.#variables);
        place(ellipse, node);
        return ellipse;
      }
      case "image": {
        const rect = attach(figma.createRectangle());
        rect.resize(safeSize(node.w), safeSize(node.h));
        rect.fills = await toFigmaPaints([node.image], images, this.#variables);
        setRadii(rect, node.radii);
        await applyStrokes(rect, node.strokes, images, this.#variables);
        place(rect, node);
        return rect;
      }
      case "vector": {
        const vector = attach(figma.createVector());
        vector.vectorPaths = node.paths.map((path) => ({
          windingRule: path.fillRule === "evenodd" ? "EVENODD" : "NONZERO",
          data: path.d,
        }));
        vector.fills = await toFigmaPaints(node.fills, images, this.#variables);
        await applyStrokes(vector, node.strokes, images, this.#variables);
        // Figma moves path data so its bounds start at the node's origin: shift the node by
        // the same amount, in local coordinates so rotation still pivots on the Scene box.
        const offset = vectorOffset(node.paths);
        vector.relativeTransform = translateLocal(placementTransform(node), offset.x, offset.y);
        return vector;
      }
      case "text": {
        const text = attach(figma.createText());
        await writeText(text, node, this.ctx.fonts, this.#links, this.#variables);
        if (node.sizing === "fixed") text.resize(safeSize(node.w), safeSize(node.h));
        else if (node.sizing === "height") text.resize(safeSize(node.w), text.height);
        this.#checkOverflow(text, node);
        place(text, { ...node, w: text.width, h: text.height });
        return text;
      }
    }
  }
}

/** Text is reported when it needs this much more room than the source gave it. */
const OVERFLOW_RATIO = 1.08;
const OVERFLOW_MIN_PX = 4;

function overflows(needed: number, box: number): boolean {
  return needed > box * OVERFLOW_RATIO && needed - box > OVERFLOW_MIN_PX;
}

function place(node: SceneNode & LayoutMixin, p: Placement): void {
  if (needsMatrix(p)) node.relativeTransform = placementTransform(p);
  else {
    node.x = p.x;
    node.y = p.y;
  }
}

/** Top-left of the union of the paths' bounds, where Figma will put the node's origin. */
function vectorOffset(paths: readonly { d: string }[]): { x: number; y: number } {
  let x = Infinity;
  let y = Infinity;
  for (const path of paths) {
    const bounds = pathBounds(path.d);
    if (bounds === undefined) continue;
    x = Math.min(x, bounds.minX);
    y = Math.min(y, bounds.minY);
  }
  return Number.isFinite(x) ? { x, y } : { x: 0, y: 0 };
}

function setRadii(
  rect: RectangleNode | FrameNode | ComponentNode,
  radii: readonly [number, number, number, number],
): void {
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
