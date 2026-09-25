import { z } from "zod";

/**
 * Closed set of error codes shared by the hub, the plugin, the CLI and MCP tools.
 * Adding a code is a protocol change: document it in docs/adr/0002-websocket-hub-and-protocol.md.
 */
export const ERROR_CODES = [
  /** Pairing token missing or wrong. */
  "UNAUTHORIZED",
  /** No protocol version supported by both sides. */
  "PROTOCOL_UNSUPPORTED",
  /** No plugin is connected. */
  "NO_SESSION",
  /** Several plugins are connected and the call did not name one. */
  "AMBIGUOUS_SESSION",
  /** The named session does not exist (plugin closed or file switched). */
  "SESSION_NOT_FOUND",
  /** The call did not complete within its timeout. */
  "TIMEOUT",
  /** The call was cancelled by the caller. */
  "CANCELLED",
  /** Parameters failed schema validation. */
  "VALIDATION",
  /** Unknown method name. */
  "METHOD_NOT_FOUND",
  /** A referenced node does not exist in the document. */
  "NODE_NOT_FOUND",
  /** A font required by the operation is not available. */
  "FONT_MISSING",
  /** An image exceeds Figma limits (4096 px per side) or is not decodable. */
  "IMAGE_INVALID",
  /** The operation is not available in this editor (e.g. createPage in Figma Slides). */
  "UNSUPPORTED_IN_EDITOR",
  /** The method mutates the document and the hub or the file is read-only for agents. */
  "READ_ONLY",
  /** The user declined the change in the plugin, or did not answer in time. */
  "DENIED",
  /** The user paused the agent in the plugin; nothing runs until they resume. */
  "PAUSED",
  /** A message or blob exceeds the configured size limit. */
  "PAYLOAD_TOO_LARGE",
  /** The input document could not be parsed. */
  "DOCUMENT_INVALID",
  /** Unexpected failure; see `message` and logs. */
  "INTERNAL",
] as const;

/** One of {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes that are worth retrying unchanged (transient conditions). */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "TIMEOUT",
  "NO_SESSION",
  "SESSION_NOT_FOUND",
]);

/** Wire representation of an error. */
export const WireErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  data: z.unknown().optional(),
});
export type WireError = z.infer<typeof WireErrorSchema>;

/**
 * The single error type thrown across figbridge.
 *
 * Never throw strings or generic `Error`s from library code: wrap them in a
 * `BridgeError` so callers can branch on `code` and agents get an actionable message.
 */
export class BridgeError extends Error {
  override readonly name = "BridgeError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly data: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { data?: unknown; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.data = options.data;
  }

  /** Serialize for the wire. `cause` stays local: it may contain paths or stack traces. */
  toWire(): WireError {
    const wire: WireError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.data !== undefined) wire.data = this.data;
    return wire;
  }

  /** Rebuild an error received from the other side. */
  static fromWire(error: WireError): BridgeError {
    return new BridgeError(error.code, error.message, {
      data: error.data,
      retryable: error.retryable,
    });
  }

  /** Normalize anything thrown into a `BridgeError` (schema errors → `VALIDATION`, unknown → `INTERNAL`). */
  static from(thrown: unknown): BridgeError {
    if (thrown instanceof BridgeError) return thrown;
    if (thrown instanceof z.ZodError) {
      return new BridgeError("VALIDATION", z.prettifyError(thrown), {
        data: thrown.issues,
        cause: thrown,
      });
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return new BridgeError("INTERNAL", message, { cause: thrown });
  }
}
