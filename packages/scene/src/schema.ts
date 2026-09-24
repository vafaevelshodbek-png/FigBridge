/**
 * Scene IR — the editable layer tree exchanged between importers and the Figma renderer.
 *
 * Coordinates are slide pixels with a top-left origin. A node's `x/y/w/h` describe its
 * unrotated box; `rotation` (degrees, clockwise) and flips are applied around the box centre.
 * Colours are sRGB hex (`#RRGGBB`) with a separate `opacity` in [0, 1].
 */
import { z } from "zod";

/** Major version of the IR. Renderers reject unknown majors. */
export const SCENE_VERSION = 1 as const;

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "expected #RRGGBB");
const Unit = z.number().min(0).max(1);
const Finite = z.number();
const NonNegative = z.number().nonnegative();

/** Blob reference: the id of binary data sent alongside the scene (images). */
export const BlobRefSchema = z
  .string()
  .regex(/^[a-z0-9]+:[A-Za-z0-9_-]{8,}$/, "expected <kind>:<id>");

// ── Paints ────────────────────────────────────────────────────────────────────

export const SolidPaintSchema = z.object({
  type: z.literal("solid"),
  color: HexColor,
  opacity: Unit.default(1),
});

export const GradientStopSchema = z.object({
  position: Unit,
  color: HexColor,
  opacity: Unit.default(1),
});

/** Linear gradient from `from` to `to`, both in the node's unit square ([0,0] top-left, [1,1] bottom-right). */
export const LinearGradientPaintSchema = z.object({
  type: z.literal("linear-gradient"),
  from: z.tuple([Finite, Finite]),
  to: z.tuple([Finite, Finite]),
  stops: z.array(GradientStopSchema).min(2),
  opacity: Unit.default(1),
});

/** Radial gradient centred at `center` (unit square) with radius `radius` (fraction of width/height). */
export const RadialGradientPaintSchema = z.object({
  type: z.literal("radial-gradient"),
  center: z.tuple([Finite, Finite]),
  radius: z.tuple([NonNegative, NonNegative]),
  stops: z.array(GradientStopSchema).min(2),
  opacity: Unit.default(1),
});

/** Image fill. `crop` is the visible sub-rectangle of the image in its own unit square. */
export const ImagePaintSchema = z.object({
  type: z.literal("image"),
  blob: BlobRefSchema,
  scaleMode: z.enum(["fill", "fit", "crop", "tile"]).default("fill"),
  crop: z.object({ x: Unit, y: Unit, w: Unit, h: Unit }).optional(),
  tileScale: z.number().positive().optional(),
  opacity: Unit.default(1),
});

export const PaintSchema = z.discriminatedUnion("type", [
  SolidPaintSchema,
  LinearGradientPaintSchema,
  RadialGradientPaintSchema,
  ImagePaintSchema,
]);
export type Paint = z.infer<typeof PaintSchema>;

export const StrokeSchema = z.object({
  paint: PaintSchema,
  weight: z.number().positive(),
  align: z.enum(["inside", "center", "outside"]).default("center"),
  dash: z.array(NonNegative).optional(),
  cap: z.enum(["none", "round", "square"]).default("none"),
  join: z.enum(["miter", "round", "bevel"]).default("miter"),
});
export type Stroke = z.infer<typeof StrokeSchema>;

/** Corner radii in pixels, clockwise from top-left. */
export const CornerRadiiSchema = z.tuple([NonNegative, NonNegative, NonNegative, NonNegative]);
export type CornerRadii = z.infer<typeof CornerRadiiSchema>;

// ── Nodes ─────────────────────────────────────────────────────────────────────

const NodeBase = {
  id: z.string().min(1),
  name: z.string(),
  x: Finite,
  y: Finite,
  w: NonNegative,
  h: NonNegative,
  rotation: Finite.default(0),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  opacity: Unit.default(1),
  visible: z.boolean().default(true),
};

export const RectNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("rect"),
  fills: z.array(PaintSchema).default([]),
  strokes: z.array(StrokeSchema).default([]),
  radii: CornerRadiiSchema.default([0, 0, 0, 0]),
});

export const EllipseNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("ellipse"),
  fills: z.array(PaintSchema).default([]),
  strokes: z.array(StrokeSchema).default([]),
});

/** Vector path in the node's local coordinates (0..w, 0..h), SVG path syntax. */
export const VectorPathSchema = z.object({
  d: z.string().min(1),
  fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
});

export const VectorNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("vector"),
  paths: z.array(VectorPathSchema).min(1),
  fills: z.array(PaintSchema).default([]),
  strokes: z.array(StrokeSchema).default([]),
});

export const ImageNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("image"),
  image: ImagePaintSchema,
  radii: CornerRadiiSchema.default([0, 0, 0, 0]),
  strokes: z.array(StrokeSchema).default([]),
});

/** Style applied to characters `[start, end)` of a text node. */
export const TextRunSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  fontFamily: z.string().min(1),
  /** Figma style name, e.g. "Regular", "Semi Bold", "Bold Italic". */
  fontStyle: z.string().min(1),
  fontSize: z.number().positive(),
  fill: PaintSchema,
  letterSpacing: Finite.default(0),
  textCase: z.enum(["original", "upper", "lower", "title"]).default("original"),
  decoration: z.enum(["none", "underline", "strikethrough"]).default("none"),
  link: z.url().optional(),
});

export const LineHeightSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("auto") }),
  z.object({ unit: z.literal("pixels"), value: z.number().positive() }),
  /** Percent of the font size (Figma semantics, not "single line spacing"). */
  z.object({ unit: z.literal("percent"), value: z.number().positive() }),
]);

/** Paragraph `[start, end)`; `end` excludes the separating newline. */
export const ParagraphSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  lineHeight: LineHeightSchema.default({ unit: "auto" }),
  spaceBefore: NonNegative.default(0),
  spaceAfter: NonNegative.default(0),
  list: z.enum(["none", "bullet", "ordered"]).default("none"),
  indentLevel: z.number().int().nonnegative().default(0),
});

export const TextNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("text"),
  /** Characters; paragraphs separated by "\n", soft line breaks by "\u2028". */
  characters: z.string(),
  runs: z.array(TextRunSchema).min(1),
  paragraphs: z.array(ParagraphSchema).default([]),
  align: z.enum(["left", "center", "right", "justified"]).default("left"),
  verticalAlign: z.enum(["top", "center", "bottom"]).default("top"),
  /** `fixed` keeps w×h; `width` grows horizontally (no wrapping); `height` wraps at `w`. */
  sizing: z.enum(["fixed", "width", "height"]).default("fixed"),
});

export type RectNode = z.infer<typeof RectNodeSchema>;
export type EllipseNode = z.infer<typeof EllipseNodeSchema>;
export type VectorNode = z.infer<typeof VectorNodeSchema>;
export type ImageNode = z.infer<typeof ImageNodeSchema>;
export type TextRun = z.infer<typeof TextRunSchema>;
export type Paragraph = z.infer<typeof ParagraphSchema>;
export type TextNode = z.infer<typeof TextNodeSchema>;

/** A group has no geometry of its own: its bounds are the union of its children. */
export const GroupNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.literal("group"),
  opacity: Unit.default(1),
  visible: z.boolean().default(true),
  // Getter + explicit return type: zod v4's way to declare a recursive schema that
  // TypeScript can infer without collapsing children to `unknown`.
  get children(): z.ZodArray<typeof SceneNodeSchema> {
    return z.array(SceneNodeSchema).min(1);
  },
});

export const SceneNodeSchema = z.discriminatedUnion("type", [
  RectNodeSchema,
  EllipseNodeSchema,
  VectorNodeSchema,
  ImageNodeSchema,
  TextNodeSchema,
  GroupNodeSchema,
]);

export type GroupNode = z.infer<typeof GroupNodeSchema>;
export type SceneNode = z.infer<typeof SceneNodeSchema>;

export const SlideSchema = z.object({
  name: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  background: z.array(PaintSchema).default([]),
  children: z.array(SceneNodeSchema).default([]),
});
export type Slide = z.infer<typeof SlideSchema>;

/** A converted document. `source` records provenance for reports and golden files. */
export const SceneSchema = z.object({
  version: z.literal(SCENE_VERSION),
  source: z.object({
    kind: z.enum(["pdf", "pptx"]),
    name: z.string(),
    pages: z.number().int().positive(),
  }),
  slides: z.array(SlideSchema),
});
export type Scene = z.infer<typeof SceneSchema>;
