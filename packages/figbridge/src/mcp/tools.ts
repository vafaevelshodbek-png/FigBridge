/**
 * MCP tool definitions. Each tool is a plain object — schema, annotations and a `run`
 * function over a {@link HubClient} — so it can be unit-tested without an MCP transport.
 *
 * Design rules (docs/research/02-mcp.md):
 *  - few, workflow-shaped tools with a `figma_` prefix;
 *  - descriptions say WHEN to use the tool, not just what it does;
 *  - responses stay small (outline is paged, texts truncated, images capped);
 *  - errors tell the agent what to do next.
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { METHODS, NodeIdSchema } from "@figbridge/protocol";
import { SceneNodeSchema } from "@figbridge/scene";
import { z } from "zod";
import type { HubClient } from "../client.js";
import { compareNode } from "../compare-node.js";
import { importDeck } from "../import-deck.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolRunContext {
  client: HubClient;
  signal?: AbortSignal | undefined;
  progress?: ((done: number, total?: number) => void) | undefined;
}

interface ToolSpec<I extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: I;
  annotations: ToolAnnotations;
  run: (args: z.output<I>, ctx: ToolRunContext) => Promise<ToolContent[]>;
}

/** A tool with its input type erased: `invoke` validates raw arguments before running. */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly invoke: (rawArgs: unknown, ctx: ToolRunContext) => Promise<ToolContent[]>;
}

/** Keep single tool responses well under common client limits (Claude Code: 25k tokens). */
export const MAX_TEXT_CHARS = 60_000;
/** Inline images larger than this are saved to disk instead (base64 inflates by 33 %). */
export const MAX_INLINE_IMAGE_BYTES = 1_500_000;

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const Session = z
  .string()
  .optional()
  .describe("Session id from figma_sessions. Needed only when several Figma files are connected.");

/** JSON as compact text, truncated with an explicit marker the agent can act on. */
export function jsonText(value: unknown): ToolContent {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TEXT_CHARS) return { type: "text", text };
  return {
    type: "text",
    text: `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated ${String(text.length - MAX_TEXT_CHARS)} characters — narrow the request (smaller depth/limit, a subtree id)]`,
  };
}

function define<I extends z.ZodObject>(spec: ToolSpec<I>): ToolDefinition {
  const { run, ...rest } = spec;
  return { ...rest, invoke: (rawArgs, ctx) => run(spec.input.parse(rawArgs), ctx) };
}

export const TOOLS: readonly ToolDefinition[] = [
  define({
    name: "figma_sessions",
    title: "List connected Figma files",
    description:
      "List Figma files whose figbridge plugin is connected. Call first when a tool reports AMBIGUOUS_SESSION or NO_SESSION.",
    input: z.object({}),
    annotations: READ,
    run: async (_args, { client }) => [jsonText({ sessions: await client.sessions() })],
  }),

  define({
    name: "figma_file_info",
    title: "Current file, page and selection",
    description:
      "File name, editor type (figma/slides), current page, how many nodes are selected, and the agent access mode the user chose in the plugin (read-only, ask, auto, unrestricted) and whether they paused the agent.",
    input: z.object({ session: Session }),
    annotations: READ,
    run: async ({ session }, { client, signal }) => [
      jsonText(await client.call("session.info", {}, { session, signal })),
    ],
  }),

  define({
    name: "figma_pages",
    title: "List or switch pages",
    description: "List the document's pages, or switch the current page when `pageId` is given.",
    input: z.object({ pageId: z.string().optional(), session: Session }),
    annotations: READ,
    run: async ({ pageId, session }, { client, signal }) => [
      jsonText(
        pageId === undefined
          ? await client.call("page.list", {}, { session, signal })
          : await client.call("page.set", { pageId }, { session, signal }),
      ),
    ],
  }),

  define({
    name: "figma_outline",
    title: "Outline of the page or a subtree",
    description:
      "Breadth-first outline (id, name, type, box, child count, text preview). Start with depth 1 on the page, then drill into a subtree with rootId. Pass nextCursor back to get the next page of results.",
    input: METHODS["document.outline"].params.extend({ session: Session }),
    annotations: READ,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("document.outline", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_selection",
    title: "Selected nodes",
    description:
      "Nodes the user currently has selected in Figma — use when the user says 'this', 'the selected frame'.",
    input: z.object({ session: Session }),
    annotations: READ,
    run: async ({ session }, { client, signal }) => [
      jsonText(await client.call("selection.get", {}, { session, signal })),
    ],
  }),

  define({
    name: "figma_get_node",
    title: "Node details",
    description:
      "Properties of one node: geometry, fills, strokes, corner radius, auto-layout, text and font. depth > 0 includes children.",
    input: METHODS["node.get"].params.extend({ session: Session }),
    annotations: READ,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("node.get", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_find",
    title: "Find nodes",
    description:
      "Find nodes by name substring (case-insensitive) and/or Figma type (FRAME, TEXT, INSTANCE…).",
    input: METHODS["node.find"].params.extend({ session: Session }),
    annotations: READ,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("node.find", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_export",
    title: "Export a node as an image",
    description:
      "Render a node to PNG/JPG/SVG. Returns the image inline so you can look at it; pass `saveTo` (absolute path) to write the file instead, e.g. for large exports.",
    input: METHODS["node.export"].params.extend({
      saveTo: z.string().optional().describe("Absolute file path to write the export to."),
      session: Session,
    }),
    annotations: READ,
    run: async ({ session, saveTo, ...params }, { client, signal }) => {
      const exported = await client.call("node.export", params, {
        session,
        signal,
        timeoutMs: METHODS["node.export"].timeoutMs,
      });
      const { bytes, mimeType } = await client.getBlob(exported.blob);
      const meta = { width: exported.width, height: exported.height, mimeType };
      if (saveTo !== undefined) {
        if (!isAbsolute(saveTo)) throw new Error("saveTo must be an absolute path.");
        const path = resolve(saveTo);
        await writeFile(path, bytes);
        return [jsonText({ ...meta, savedTo: path, bytes: bytes.byteLength })];
      }
      if (mimeType === "image/svg+xml")
        return [jsonText(meta), { type: "text", text: new TextDecoder().decode(bytes) }];
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new Error(
          `The export is ${String(bytes.byteLength)} bytes — too large to return inline. Lower \`scale\` or pass \`saveTo\`.`,
        );
      }
      return [
        jsonText(meta),
        { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
      ];
    },
  }),

  define({
    name: "figma_compare",
    title: "Compare a layer with an image",
    description:
      "Pixel-compare a Figma layer with an image file — a screenshot of the implementation of a design, or the source a layer was built from. Exports the layer at the image's width and returns the share of differing pixels, a verdict and a diff map (red = differs). For pixel-perfect work, fix the largest red areas and compare again until the verdict is identical or close. `tolerance` is per colour channel, 0–255 (default 40; about 10 for strict checks). Pass `saveDiffTo` (absolute path) to write the diff map instead of returning it.",
    input: z.object({
      nodeId: NodeIdSchema,
      imagePath: z.string().describe("Absolute path to a PNG or JPEG on this computer."),
      tolerance: z.number().int().min(0).max(255).optional(),
      saveDiffTo: z.string().optional().describe("Absolute file path for the diff PNG."),
      session: Session,
    }),
    annotations: READ,
    run: async ({ nodeId, imagePath, tolerance, saveDiffTo, session }, { client, signal }) => {
      if (!isAbsolute(imagePath)) throw new Error("imagePath must be an absolute path.");
      const { diff, ...result } = await compareNode(client, {
        nodeId,
        imagePath,
        tolerance,
        session,
        signal,
      });
      if (saveDiffTo !== undefined) {
        if (!isAbsolute(saveDiffTo)) throw new Error("saveDiffTo must be an absolute path.");
        await writeFile(resolve(saveDiffTo), diff);
        return [jsonText({ ...result, diffSavedTo: resolve(saveDiffTo) })];
      }
      if (diff.byteLength > MAX_INLINE_IMAGE_BYTES) {
        return [jsonText({ ...result, diff: "too large to return inline — pass saveDiffTo" })];
      }
      return [
        jsonText(result),
        { type: "image", data: diff.toString("base64"), mimeType: "image/png" },
      ];
    },
  }),

  define({
    name: "figma_import_deck",
    title: "Import a PDF or PPTX deck as editable slides",
    description:
      "Convert a PDF (presentation, report, any document) or a PowerPoint .pptx into editable Figma frames (one per page): backgrounds as fills, cards as rounded rectangles, logos/icons as vectors, photos as image layers, text as editable paragraphs. Frames are laid out in a grid starting at (x, y) on the current page — pick a spot below existing content. Large decks take a while; pass `pages` to try a few first.",
    input: z.object({
      path: z.string().describe("Absolute path to a .pdf or .pptx file on this computer."),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe("1-based page numbers; default all."),
      x: z.number().default(0),
      y: z.number().default(0),
      columns: z.number().int().min(1).max(20).default(6),
      session: Session,
    }),
    annotations: WRITE,
    run: async ({ path, pages, x, y, columns, session }, { client, signal, progress }) => {
      if (!isAbsolute(path)) throw new Error("path must be absolute.");
      return [
        jsonText(
          await importDeck(client, {
            path,
            pages,
            x,
            y,
            columns,
            session,
            signal,
            onProgress: progress,
          }),
        ),
      ];
    },
  }),

  define({
    name: "figma_create",
    title: "Create layers",
    description:
      "Create layers from Scene nodes (rect, ellipse, vector, image, text, group) inside a frame or on the current page. Coordinates are relative to the parent.",
    input: z.object({
      nodes: z.array(SceneNodeSchema).min(1),
      parentId: NodeIdSchema.optional(),
      session: Session,
    }),
    annotations: WRITE,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("nodes.create", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_update",
    title: "Update a layer",
    description:
      "Change name, position, size, rotation, opacity, visibility, solid fill, text or corner radius of one layer.",
    input: METHODS["node.update"].params.extend({ session: Session }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("node.update", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_clone",
    title: "Duplicate a layer",
    description:
      "Duplicate a layer (with its children), optionally into another parent and position.",
    input: METHODS["node.clone"].params.extend({ session: Session }),
    annotations: WRITE,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("node.clone", params, { session, signal })),
    ],
  }),

  define({
    name: "figma_delete",
    title: "Delete layers",
    description:
      "Delete layers by id. Irreversible for the agent (the user can still undo in Figma). Confirm with the user first.",
    input: METHODS["node.delete"].params.extend({ session: Session }),
    annotations: DESTRUCTIVE,
    run: async ({ session, ...params }, { client, signal }) => [
      jsonText(await client.call("node.delete", params, { session, signal })),
    ],
  }),
];
