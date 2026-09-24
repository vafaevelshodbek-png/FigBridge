/**
 * Executes requests forwarded by the UI: looks up the handler, tracks cancellation,
 * reports progress and caches results of idempotent retries.
 */
import type { MethodName, Request, Response } from "@figbridge/protocol";
import { type HandlerContext, type HandlerTable, PluginError } from "./handlers/context.js";
import type { FontLoader } from "./render/fonts.js";
import type { ImageResolver } from "./render/paints.js";
import type { UiBridge } from "./ui-bridge.js";

/** Results of the most recent idempotent calls, so a retry after reconnect is a no-op. */
const IDEMPOTENCY_CACHE_SIZE = 64;

export class Dispatcher {
  readonly #cancelled = new Set<string>();
  readonly #idempotent = new Map<string, Response>();

  constructor(
    private readonly handlers: HandlerTable,
    private readonly ui: UiBridge,
    private readonly fonts: FontLoader,
    private readonly images: ImageResolver,
  ) {}

  cancel(id: string): void {
    this.#cancelled.add(id);
  }

  async handle(request: Request): Promise<void> {
    const key = request.idempotencyKey;
    const cached = key === undefined ? undefined : this.#idempotent.get(key);
    if (cached !== undefined) {
      this.ui.post({ kind: "response", response: { ...cached, id: request.id } });
      return;
    }
    const response = await this.#execute(request);
    this.#cancelled.delete(request.id);
    if (key !== undefined && response.ok) this.#remember(key, response);
    this.ui.post({ kind: "response", response });
  }

  async #execute(request: Request): Promise<Response> {
    const handler = (this.handlers as Record<string, HandlerTable[MethodName] | undefined>)[
      request.method
    ];
    if (handler === undefined) {
      return failure(request.id, "METHOD_NOT_FOUND", `Unknown method "${request.method}".`);
    }
    const ctx: HandlerContext = {
      ui: this.ui,
      fonts: this.fonts,
      images: this.images,
      checkCancelled: () => {
        if (this.#cancelled.has(request.id))
          throw new PluginError("CANCELLED", `${request.method} was cancelled.`);
      },
      progress: (done, total) => {
        this.ui.post({
          kind: "progress",
          id: request.id,
          done,
          ...(total === undefined ? {} : { total }),
        });
      },
    };
    try {
      // Parameters were validated by the hub against the same catalog.
      const result = await (handler as (params: unknown, ctx: HandlerContext) => Promise<unknown>)(
        request.params,
        ctx,
      );
      return { v: 1, type: "res", id: request.id, ok: true, result };
    } catch (error) {
      if (error instanceof PluginError) return failure(request.id, error.code, error.message);
      const message = error instanceof Error ? error.message : String(error);
      // Figma reports missing fonts as plain errors; give them a stable code.
      if (/font/i.test(message) && /load/i.test(message))
        return failure(request.id, "FONT_MISSING", message);
      return failure(request.id, "INTERNAL", message);
    }
  }

  #remember(key: string, response: Response): void {
    this.#idempotent.set(key, response);
    if (this.#idempotent.size > IDEMPOTENCY_CACHE_SIZE) {
      const oldest = this.#idempotent.keys().next().value;
      if (oldest !== undefined) this.#idempotent.delete(oldest);
    }
  }
}

const KNOWN_CODES = new Set([
  "CANCELLED",
  "VALIDATION",
  "METHOD_NOT_FOUND",
  "NODE_NOT_FOUND",
  "FONT_MISSING",
  "IMAGE_INVALID",
  "UNSUPPORTED_IN_EDITOR",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL",
]);

function failure(id: string, code: string, message: string): Response {
  const safeCode = (KNOWN_CODES.has(code) ? code : "INTERNAL") as "INTERNAL";
  return { v: 1, type: "res", id, ok: false, error: { code: safeCode, message, retryable: false } };
}
