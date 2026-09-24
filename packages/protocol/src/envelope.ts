import { z } from "zod";
import { WireErrorSchema } from "./errors.js";

/** Protocol versions this build understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Correlation id: a ULID (26 Crockford base32 chars), sortable by creation time. */
export const MessageIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID");

/** Opaque session id assigned by the hub in `welcome`. */
export const SessionIdSchema = z.string().min(1).max(64);

/** Editors a Figma plugin can run in. */
export const EditorTypeSchema = z.enum(["figma", "figjam", "slides", "dev", "buzz"]);
export type EditorType = z.infer<typeof EditorTypeSchema>;

/** Plugin → hub, first frame on every connection. */
export const HelloSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  token: z.string().min(1),
  protocols: z.array(z.number().int().positive()).min(1),
  plugin: z.object({ version: z.string() }),
  file: z.object({ name: z.string(), editorType: EditorTypeSchema }),
  /** Random id kept for the lifetime of the plugin window; lets the hub rebind a session after reconnect. */
  instance: z.string().min(8).max(64),
});
export type Hello = z.infer<typeof HelloSchema>;

/** Hub → plugin, reply to a valid `hello`. */
export const WelcomeSchema = z.object({
  v: z.literal(1),
  type: z.literal("welcome"),
  protocol: z.number().int().positive(),
  session: SessionIdSchema,
  heartbeatMs: z.number().int().positive(),
  maxChunkBytes: z.number().int().positive(),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

/** A call. `session` is set by the hub when it forwards the call to a plugin. */
export const RequestSchema = z.object({
  v: z.literal(1),
  type: z.literal("req"),
  id: MessageIdSchema,
  method: z.string().min(1),
  params: z.unknown(),
  session: SessionIdSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Mutating calls may carry a key; a retry with the same key returns the first result. */
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type Request = z.infer<typeof RequestSchema>;

export const SuccessResponseSchema = z.object({
  v: z.literal(1),
  type: z.literal("res"),
  id: MessageIdSchema,
  ok: z.literal(true),
  result: z.unknown(),
});
export const ErrorResponseSchema = z.object({
  v: z.literal(1),
  type: z.literal("res"),
  id: MessageIdSchema,
  ok: z.literal(false),
  error: WireErrorSchema,
});
export const ResponseSchema = z.discriminatedUnion("ok", [
  SuccessResponseSchema,
  ErrorResponseSchema,
]);
export type Response = z.infer<typeof ResponseSchema>;

/** Out-of-band notification (progress of a long call, selection change, …). */
export const EventSchema = z.object({
  v: z.literal(1),
  type: z.literal("evt"),
  event: z.string().min(1),
  data: z.unknown(),
});
export type Event = z.infer<typeof EventSchema>;

/** Ask the other side to stop working on request `id`. */
export const CancelSchema = z.object({
  v: z.literal(1),
  type: z.literal("cancel"),
  id: MessageIdSchema,
});
export type Cancel = z.infer<typeof CancelSchema>;

/** Every JSON text frame after the handshake. */
export const MessageSchema = z.union([RequestSchema, ResponseSchema, EventSchema, CancelSchema]);
export type Message = z.infer<typeof MessageSchema>;

/** Progress payload carried by `evt` messages with `event: "progress"`. */
export const ProgressDataSchema = z.object({
  id: MessageIdSchema,
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type ProgressData = z.infer<typeof ProgressDataSchema>;

/**
 * Pick the protocol version to speak: the highest one both sides support.
 * @returns `undefined` when there is no overlap.
 */
export function negotiateProtocol(offered: readonly number[]): ProtocolVersion | undefined {
  return SUPPORTED_PROTOCOL_VERSIONS.find((version) => offered.includes(version));
}
