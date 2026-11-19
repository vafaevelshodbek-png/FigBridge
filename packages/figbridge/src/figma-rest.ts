/** Fixed-origin, read-only Figma REST transport. Credentials never enter the plugin wire. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { BridgeError } from "@figbridge/protocol";
import { stateDir } from "./config.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FigmaRestOptions {
  token?: (() => string | Promise<string>) | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** Prefer the process environment; the optional local file supports clients without env setup. */
export async function loadFigmaToken(): Promise<string> {
  const env = process.env["FIGMA_ACCESS_TOKEN"];
  if (env !== undefined) return env.trim();
  try {
    return (await readFile(join(stateDir(), "figma-token"), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function getFigmaComments(
  fileKey: string,
  options: FigmaRestOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const token = (await (options.token ?? loadFigmaToken)()).trim();
  if (!token || /\s/.test(token)) {
    throw new BridgeError(
      "UNAUTHORIZED",
      "Set FIGMA_ACCESS_TOKEN or save a personal access token in FIGBRIDGE_HOME/figma-token " +
        "(default ~/.figbridge/figma-token), with file_comments:read and access to this file. " +
        "Do not send the token as a tool argument.",
    );
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    combined.throwIfAborted();
    const response = await (options.fetch ?? fetch)(
      `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/comments`,
      { headers: { "X-Figma-Token": token }, redirect: "error", signal: combined },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      const retryAfter = response.headers.get("retry-after")?.slice(0, 128);
      const guidance =
        status === 401 || status === 403
          ? "Check the token expiry, file_comments:read scope, and access to the file."
          : status === 404
            ? "Check the file or branch key and your access to it."
            : status === 429
              ? "Figma rate limit reached. Wait for Retry-After before trying again."
              : "Figma could not serve comments. Try again later.";
      throw new BridgeError(
        status === 401 || status === 403 ? "UNAUTHORIZED" : "INTERNAL",
        `Figma comments request failed (HTTP ${status}). ${guidance}`,
        {
          retryable: status === 429 || status >= 500,
          data: { status, ...(retryAfter === undefined ? {} : { retryAfter }) },
        },
      );
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined)
      throw new BridgeError("DOCUMENT_INVALID", "Figma returned an empty response.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        combined.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new BridgeError("PAYLOAD_TOO_LARGE", "Figma comments response exceeds 8 MiB.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new BridgeError("DOCUMENT_INVALID", "Figma returned invalid comments JSON.");
    }
  } catch (error) {
    if (signal?.aborted) throw new BridgeError("CANCELLED", "Figma comments request cancelled.");
    if (timeout.aborted) throw new BridgeError("TIMEOUT", "Figma comments request timed out.");
    if (error instanceof BridgeError) throw error;
    // Never include fetch errors or upstream bodies: they may contain credentials.
    throw new BridgeError(
      "INTERNAL",
      "Could not reach Figma comments API. Check your connection.",
      { retryable: true },
    );
  }
}
