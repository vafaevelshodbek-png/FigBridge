/** Native comment reads: schema, thread-aware filters and bounded local pagination. */
import { BridgeError, NodeIdSchema } from "@figbridge/protocol";
import { z } from "zod";
import { type FigmaRestOptions, getFigmaComments } from "./figma-rest.js";

const FILE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE_CHARS = 8_000;
// Leaves room for the result envelope below the MCP tools' 60k character limit.
const MAX_PAGE_CHARS = 48_000;

export function parseFileKey(file: string): string {
  if (FILE_KEY.test(file)) return file;
  try {
    const url = new URL(file);
    const parts = url.pathname.split("/").filter(Boolean);
    const key = parts[2] === "branch" ? parts[3] : parts[1];
    if (
      url.protocol === "https:" &&
      ["figma.com", "www.figma.com"].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      ["file", "design", "board", "slides"].includes(parts[0] ?? "") &&
      key !== undefined &&
      FILE_KEY.test(key)
    )
      return key;
  } catch {
    /* Invalid URLs share the actionable validation error below. */
  }
  throw new BridgeError(
    "VALIDATION",
    "Expected a Figma file/branch key or an HTTPS figma.com file URL.",
  );
}

export const CommentsInputSchema = z.object({
  file: z
    .string()
    .min(1)
    .max(2048)
    .describe("Figma file/branch key or full file URL; required, independent of the open plugin."),
  nodeId: z
    .string()
    .transform((id) => id.replaceAll("-", ":"))
    .pipe(NodeIdSchema)
    .optional()
    .describe("Exact comment anchor node only (not descendants); includes its replies."),
  status: z.enum(["all", "open", "resolved"]).default("all"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^(0|[1-9]\d{0,8})$/)
    .optional()
    .describe(
      "Local offset from nextCursor; reuse the same file and filters. Re-fetched on each call.",
    ),
});

const Vector = z.object({ x: z.number(), y: z.number() });
const Region = {
  region_height: z.number().optional(),
  region_width: z.number().optional(),
  comment_pin_corner: z.string().max(32).optional(),
};
const CommentSchema = z.object({
  id: z.string().max(256),
  parent_id: z.string().max(256).optional(),
  message: z.string(),
  created_at: z.string().max(128),
  resolved_at: z.string().max(128).nullable().optional(),
  user: z.object({ id: z.string().max(256), handle: z.string().max(512) }),
  client_meta: z
    .union([
      z.object({ node_id: z.string().max(256), node_offset: Vector, ...Region }),
      Vector.extend(Region),
    ])
    .nullable()
    .optional(),
  order_id: z
    .union([z.string().max(256), z.number()])
    .nullable()
    .optional(),
});
type Comment = z.output<typeof CommentSchema>;
type OutputComment = Comment & { messageTruncated?: true };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CommentsResult {
  fileKey: string;
  comments: OutputComment[];
  total: number;
  nextCursor?: string;
  scope: string;
}

export class FigmaCommentsClient {
  constructor(private readonly options: FigmaRestOptions = {}) {}

  async list(
    input: z.input<typeof CommentsInputSchema>,
    signal?: AbortSignal,
  ): Promise<CommentsResult> {
    const params = CommentsInputSchema.parse(input);
    const fileKey = parseFileKey(params.file);
    const parsed = z
      .object({ comments: z.array(CommentSchema).max(100_000) })
      .safeParse(await getFigmaComments(fileKey, this.options, signal));
    if (!parsed.success)
      throw new BridgeError("DOCUMENT_INVALID", "Figma returned malformed comments data.");
    // The endpoint does not promise ordering. Stabilize offsets independently of its order.
    const all = parsed.data.comments.sort(
      (a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id),
    );
    const byId = new Map(all.map((comment) => [comment.id, comment]));
    const filtered = all.filter((comment) => {
      const thread = comment.parent_id ? byId.get(comment.parent_id) : comment;
      if (params.nodeId !== undefined) {
        const meta = thread?.client_meta;
        if (meta == null || !("node_id" in meta) || meta.node_id !== params.nodeId) return false;
      }
      if (params.status === "all") return true;
      if (thread === undefined) return false;
      return params.status === "resolved" ? Boolean(thread.resolved_at) : !thread.resolved_at;
    });
    let index = Number(params.cursor ?? 0);
    const comments: OutputComment[] = [];
    let chars = 0;
    while (index < filtered.length && comments.length < params.limit) {
      const comment = filtered[index];
      if (comment === undefined) break;
      const out: OutputComment =
        comment.message.length > MAX_MESSAGE_CHARS
          ? {
              ...comment,
              message: comment.message.slice(0, MAX_MESSAGE_CHARS),
              messageTruncated: true,
            }
          : comment;
      const size = JSON.stringify(out).length;
      if (comments.length > 0 && chars + size > MAX_PAGE_CHARS) break;
      comments.push(out);
      chars += size;
      index++;
    }
    return {
      fileKey,
      comments,
      total: filtered.length,
      ...(index < filtered.length ? { nextCursor: String(index) } : {}),
      scope:
        params.nodeId === undefined
          ? "Entire file, all pages. Canvas-coordinate pins do not identify a page."
          : "Exact anchor node and its replies; excludes descendants and unanchored comments.",
    };
  }
}
