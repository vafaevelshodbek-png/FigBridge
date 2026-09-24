/**
 * In-memory store for binary payloads (images going to the plugin, exports coming back).
 *
 * Blobs are addressed as `<kind>:<id>` (see `BlobRefSchema` in @figbridge/scene), live for a
 * bounded time and the store has a total size cap, so an abandoned import cannot exhaust memory.
 */
import { createHash } from "node:crypto";
import { BridgeError } from "@figbridge/protocol";

export interface BlobEntry {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly createdAt: number;
}

export interface BlobStoreOptions {
  /** Maximum total bytes held; oldest blobs are evicted first. */
  maxTotalBytes?: number;
  /** Maximum size of one blob. */
  maxBlobBytes?: number;
  /** Blobs older than this are evicted. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULTS = {
  maxTotalBytes: 512 * 1024 * 1024,
  maxBlobBytes: 64 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
} as const;

export class BlobStore {
  readonly #entries = new Map<string, BlobEntry>();
  #totalBytes = 0;
  readonly #options: Required<Omit<BlobStoreOptions, "now">>;
  readonly #now: () => number;

  constructor(options: BlobStoreOptions = {}) {
    this.#options = {
      maxTotalBytes: options.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
      maxBlobBytes: options.maxBlobBytes ?? DEFAULTS.maxBlobBytes,
      ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
    };
    this.#now = options.now ?? Date.now;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /**
   * Store bytes and return their reference. The id is content-addressed, so storing the
   * same image twice (a logo on every slide) costs nothing and yields the same reference.
   */
  put(bytes: Uint8Array, mimeType: string, kind = "img"): string {
    if (bytes.byteLength > this.#options.maxBlobBytes) {
      throw new BridgeError(
        "PAYLOAD_TOO_LARGE",
        `Blob of ${bytes.byteLength} bytes exceeds the ${this.#options.maxBlobBytes}-byte limit.`,
      );
    }
    const id = `${kind}:${createHash("sha256").update(bytes).digest("base64url").slice(0, 32)}`;
    if (!this.#entries.has(id)) {
      this.#entries.set(id, { bytes, mimeType, createdAt: this.#now() });
      this.#totalBytes += bytes.byteLength;
      this.#evict();
    }
    return id;
  }

  get(id: string): BlobEntry | undefined {
    this.#evict();
    return this.#entries.get(id);
  }

  delete(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#totalBytes -= entry.bytes.byteLength;
  }

  #evict(): void {
    const cutoff = this.#now() - this.#options.ttlMs;
    // Map iteration order is insertion order: oldest first.
    for (const [id, entry] of this.#entries) {
      const expired = entry.createdAt < cutoff;
      const overBudget = this.#totalBytes > this.#options.maxTotalBytes;
      if (!expired && !overBudget) break;
      this.delete(id);
    }
  }
}
