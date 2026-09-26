/**
 * Executes requests forwarded by the UI: looks up the handler, tracks cancellation,
 * reports progress and caches results of idempotent retries.
 */
import type { MethodName, Request, Response } from "@figbridge/protocol";
import { MUTATING_METHODS } from "@figbridge/protocol/access";
import type { AccessControl, NodeSizer } from "./access.js";
import { type HandlerContext, type HandlerTable, PluginError } from "./handlers/context.js";
import type { FontLoader } from "./render/fonts.js";
import type { ImageResolver } from "./render/paints.js";
import type { UiBridge } from "./ui-bridge.js";
import type { UndoLog } from "./undo.js";

/** Results of the most recent idempotent calls, so a retry after reconnect is a no-op. */
const IDEMPOTENCY_CACHE_SIZE = 64;

export class Dispatcher {
  readonly #cancelled = new Set<string>();
  readonly #running = new Set<string>();
  readonly #idempotent = new Map<string, Response>();

  constructor(
    private readonly handlers: HandlerTable,
    private readonly ui: UiBridge,
    private readonly fonts: FontLoader,
    private readonly images: ImageResolver,
    private readonly access: AccessControl,
    private readonly undo: UndoLog,
    private readonly sizer: NodeSizer,
    private readonly notify: (message: string) => void = () => undefined,
  ) {}

  cancel(id: string): void {
    this.#cancelled.add(id);
  }

  /** Cancel everything in flight (the Stop button). */
  cancelAll(): void {
    for (const id of this.#running) this.#cancelled.add(id);
  }

  async handle(request: Request): Promise<void> {
    const key = request.idempotencyKey;
    const cached = key === undefined ? undefined : this.#idempotent.get(key);
    if (cached !== undefined) {
      this.ui.post({ kind: "response", response: { ...cached, id: request.id } });
      return;
    }
    this.#running.add(request.id);
    this.#activity(request, "running");
    const response = await this.#execute(request);
    this.#running.delete(request.id);
    this.#cancelled.delete(request.id);
    if (response.ok) {
      this.#activity(request, "done");
      if (mutates(request.method)) this.notify(`figbridge: ${request.method} done`);
    } else {
      const refused = ["READ_ONLY", "DENIED", "PAUSED"].includes(response.error.code);
      this.#activity(request, refused ? "refused" : "failed", response.error.message);
    }
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
      access: this.access,
      undo: this.undo,
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
      await this.access.authorize(request.id, request.method, request.params, this.sizer);
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

  #activity(
    request: Request,
    status: "running" | "done" | "failed" | "refused",
    detail?: string,
  ): void {
    this.ui.post({
      kind: "activity",
      entry: {
        id: request.id,
        method: request.method,
        status,
        ...(detail === undefined ? {} : { detail }),
      },
    });
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
  "READ_ONLY",
  "DENIED",
  "PAUSED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL",
]);

function mutates(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

function failure(id: string, code: string, message: string): Response {
  const safeCode = (KNOWN_CODES.has(code) ? code : "INTERNAL") as "INTERNAL";
  return { v: 1, type: "res", id, ok: false, error: { code: safeCode, message, retryable: false } };
}
