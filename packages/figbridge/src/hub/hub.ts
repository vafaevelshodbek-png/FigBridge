/**
 * The hub: registry of plugin sessions and the single entry point for calls into Figma.
 *
 * Callers (MCP tools, the HTTP API used by the CLI and relays) go through {@link Hub.call};
 * it validates parameters against the method catalog, enforces read-only mode, picks the
 * session and applies the method's timeout.
 */
import {
  BridgeError,
  type Hello,
  METHODS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ProgressData,
} from "@figbridge/protocol";
import { ulid } from "ulid";
import { Session, type SessionSocket } from "./session.js";

export interface HubOptions {
  /** Reject every mutating method. */
  readOnly?: boolean;
}

export interface HubCallOptions {
  /** Target session; required when more than one plugin is connected. */
  session?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Overrides the catalog timeout (e.g. a large import). */
  timeoutMs?: number | undefined;
  idempotencyKey?: string | undefined;
  onProgress?: ((progress: ProgressData) => void) | undefined;
}

export interface SessionSummary {
  id: string;
  file: string;
  editorType: string;
  pluginVersion: string;
  connectedAt: string;
  lastSeen: string;
  inFlight: number;
}

export class Hub {
  readonly #sessions = new Map<string, Session>();
  readonly #readOnly: boolean;

  constructor(options: HubOptions = {}) {
    this.#readOnly = options.readOnly ?? false;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  /** Register a plugin after a valid handshake; a reconnect with the same instance reuses its session. */
  attach(hello: Hello, socket: SessionSocket): Session {
    const existing = [...this.#sessions.values()].find((s) => s.info.instance === hello.instance);
    if (existing !== undefined) {
      existing.rebind(socket);
      return existing;
    }
    const session = new Session(
      {
        id: `s_${ulid().slice(-10).toLowerCase()}`,
        instance: hello.instance,
        file: hello.file.name,
        editorType: hello.file.editorType,
        pluginVersion: hello.plugin.version,
        connectedAt: new Date(),
      },
      socket,
    );
    this.#sessions.set(session.info.id, session);
    return session;
  }

  /** Forget a session whose socket closed. Pending calls fail as retryable. */
  detach(session: Session, reason: string): void {
    if (this.#sessions.get(session.info.id) !== session) return;
    this.#sessions.delete(session.info.id);
    session.failAll(
      new BridgeError("SESSION_NOT_FOUND", `Plugin disconnected: ${reason}`, { retryable: true }),
    );
  }

  sessions(): SessionSummary[] {
    return [...this.#sessions.values()].map((s) => ({
      id: s.info.id,
      file: s.info.file,
      editorType: s.info.editorType,
      pluginVersion: s.info.pluginVersion,
      connectedAt: s.info.connectedAt.toISOString(),
      lastSeen: s.lastSeen.toISOString(),
      inFlight: s.inFlight,
    }));
  }

  /** Call a plugin method with typed parameters; resolves with the validated result. */
  async call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: HubCallOptions = {},
  ): Promise<MethodResult<M>> {
    return (await this.invoke(method, params, options)) as MethodResult<M>;
  }

  /**
   * Call a method with parameters of unknown shape (HTTP API, relays). Parameters and the
   * plugin's result are validated against the catalog, so the result is safe to return.
   */
  async invoke(
    method: MethodName,
    params: unknown,
    options: HubCallOptions = {},
  ): Promise<unknown> {
    const spec = METHODS[method];
    if (spec.mutates && this.#readOnly) {
      throw new BridgeError(
        "READ_ONLY",
        `${method} modifies the document and the hub runs read-only.`,
      );
    }
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      throw new BridgeError(
        "VALIDATION",
        `Invalid parameters for ${method}: ${parsed.error.message}`,
        {
          data: parsed.error.issues,
        },
      );
    }
    const session = this.#resolve(options.session);
    const raw = await session.call(method, parsed.data, {
      timeoutMs: options.timeoutMs ?? spec.timeoutMs,
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
      onProgress: options.onProgress,
    });
    const result = spec.result.safeParse(raw);
    if (!result.success) {
      throw new BridgeError("INTERNAL", `The plugin returned a malformed result for ${method}.`, {
        data: result.error.issues,
      });
    }
    return result.data;
  }

  /** Close every session (hub shutdown). */
  closeAll(reason: string): void {
    for (const session of this.#sessions.values()) session.close(reason);
    this.#sessions.clear();
  }

  #resolve(sessionId: string | undefined): Session {
    if (sessionId !== undefined) {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) {
        throw new BridgeError("SESSION_NOT_FOUND", `No plugin session "${sessionId}".`, {
          data: { sessions: this.sessions() },
        });
      }
      return session;
    }
    const all = [...this.#sessions.values()];
    const [only] = all;
    if (only === undefined) {
      throw new BridgeError(
        "NO_SESSION",
        "No Figma file is connected. Open the file in Figma Desktop and run Plugins → Development → figbridge.",
      );
    }
    if (all.length > 1) {
      throw new BridgeError(
        "AMBIGUOUS_SESSION",
        "Several Figma files are connected; pass `session` with one of the listed ids.",
        { data: { sessions: this.sessions() } },
      );
    }
    return only;
  }
}
