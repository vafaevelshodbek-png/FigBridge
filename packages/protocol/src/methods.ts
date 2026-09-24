/**
 * Method catalog: every call the hub can send to the plugin.
 *
 * Each entry declares its parameter and result schemas, whether it mutates the document
 * (read-only mode rejects those) and its default timeout. The plugin implements exactly
 * this set — there is deliberately no "evaluate arbitrary code" method.
 */
import { SceneNodeSchema, SlideSchema } from "@figbridge/scene";
import { z } from "zod";

/** Figma node id, e.g. "12:34" (URL form "12-34" is normalized by the hub). */
export const NodeIdSchema = z
  .string()
  .regex(/^I?\d+:\d+(;\d+:\d+)*$/, "expected a Figma node id like 12:34");

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Compact node description used by outline and search results. */
export const NodeSummarySchema = z.object({
  id: NodeIdSchema,
  name: z.string(),
  type: z.string(),
  box: Box.optional(),
  childCount: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

const Page = z.object({ id: z.string(), name: z.string(), current: z.boolean() });

const Cursor = z.string().max(256);

/** Timeouts (ms), innermost shortest: plugin work < hub request < MCP call. */
export const TIMEOUTS = {
  read: 15_000,
  write: 30_000,
  export: 60_000,
  renderSlide: 120_000,
} as const;

/** Declaration of one method. */
export interface MethodSpec {
  readonly summary: string;
  readonly params: z.ZodType;
  readonly result: z.ZodType;
  /** Rejected in read-only mode. */
  readonly mutates: boolean;
  readonly timeoutMs: number;
}

export const METHODS = {
  "session.info": {
    summary: "File, editor, current page and selection size of the connected plugin.",
    params: z.object({}),
    result: z.object({
      file: z.string(),
      editorType: z.string(),
      page: Page,
      selectionCount: z.number().int().nonnegative(),
    }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "page.list": {
    summary: "Pages of the document.",
    params: z.object({}),
    result: z.object({ pages: z.array(Page) }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "page.set": {
    summary: "Switch the current page.",
    params: z.object({ pageId: z.string() }),
    result: Page,
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "document.outline": {
    summary: "Paged, depth-limited outline of a subtree (the current page by default).",
    params: z.object({
      rootId: NodeIdSchema.optional(),
      depth: z.number().int().min(0).max(8).default(1),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: Cursor.optional(),
    }),
    result: z.object({
      nodes: z.array(NodeSummarySchema.extend({ depth: z.number().int() })),
      nextCursor: Cursor.optional(),
    }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "selection.get": {
    summary: "Currently selected nodes.",
    params: z.object({}),
    result: z.object({ nodes: z.array(NodeSummarySchema) }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "node.get": {
    summary: "Detailed properties of one node (geometry, fills, strokes, text, layout).",
    params: z.object({ nodeId: NodeIdSchema, depth: z.number().int().min(0).max(4).default(0) }),
    result: z.object({ node: z.record(z.string(), z.unknown()) }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "node.find": {
    summary: "Find nodes by name (substring, case-insensitive) and/or type.",
    params: z.object({
      name: z.string().optional(),
      types: z.array(z.string()).optional(),
      withinId: NodeIdSchema.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    result: z.object({ nodes: z.array(NodeSummarySchema), truncated: z.boolean() }),
    mutates: false,
    timeoutMs: TIMEOUTS.read,
  },

  "node.export": {
    summary: "Export a node as PNG, JPG or SVG. Binary data returns as a blob.",
    params: z.object({
      nodeId: NodeIdSchema,
      format: z.enum(["png", "jpg", "svg"]).default("png"),
      scale: z.number().min(0.05).max(4).default(1),
    }),
    result: z.object({
      blob: z.string(),
      mimeType: z.string(),
      width: z.number(),
      height: z.number(),
    }),
    mutates: false,
    timeoutMs: TIMEOUTS.export,
  },

  "scene.render": {
    summary:
      "Render a Scene slide as a new frame (or replace an existing one) — the importer output path.",
    params: z.object({
      slide: SlideSchema,
      x: z.number(),
      y: z.number(),
      parentId: NodeIdSchema.optional(),
      replaceId: NodeIdSchema.optional(),
    }),
    result: z.object({
      frameId: NodeIdSchema,
      created: z.number().int().nonnegative(),
      warnings: z.array(z.string()),
    }),
    mutates: true,
    timeoutMs: TIMEOUTS.renderSlide,
  },

  "nodes.create": {
    summary: "Create Scene nodes inside a parent frame (or the current page).",
    params: z.object({ nodes: z.array(SceneNodeSchema).min(1), parentId: NodeIdSchema.optional() }),
    result: z.object({ ids: z.array(NodeIdSchema), warnings: z.array(z.string()) }),
    mutates: true,
    timeoutMs: TIMEOUTS.write,
  },

  "node.update": {
    summary: "Change properties of an existing node.",
    params: z.object({
      nodeId: NodeIdSchema,
      props: z
        .object({
          name: z.string(),
          x: z.number(),
          y: z.number(),
          w: z.number().nonnegative(),
          h: z.number().nonnegative(),
          rotation: z.number(),
          opacity: z.number().min(0).max(1),
          visible: z.boolean(),
          fill: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
          text: z.string(),
          cornerRadius: z.number().nonnegative(),
        })
        .partial()
        .refine((props) => Object.keys(props).length > 0, "props must not be empty"),
    }),
    result: NodeSummarySchema,
    mutates: true,
    timeoutMs: TIMEOUTS.write,
  },

  "node.delete": {
    summary: "Delete nodes.",
    params: z.object({ nodeIds: z.array(NodeIdSchema).min(1).max(500) }),
    result: z.object({ deleted: z.array(NodeIdSchema), missing: z.array(NodeIdSchema) }),
    mutates: true,
    timeoutMs: TIMEOUTS.write,
  },

  "node.clone": {
    summary: "Duplicate a node (with children) into a parent at a position.",
    params: z.object({
      nodeId: NodeIdSchema,
      parentId: NodeIdSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    result: NodeSummarySchema,
    mutates: true,
    timeoutMs: TIMEOUTS.write,
  },
} as const satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodParamsParsed<M extends MethodName> = z.output<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;

/** Type guard for method names received from the wire. */
export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(METHODS, name);
}
