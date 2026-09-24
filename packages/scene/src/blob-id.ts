/**
 * Content addressing for binary payloads. Importers and the hub derive the same id from the
 * same bytes, so an importer can reference images before they are uploaded, and a logo used
 * on every slide is stored once.
 */
import { createHash } from "node:crypto";

export function contentBlobId(bytes: Uint8Array, kind = "img"): string {
  return `${kind}:${createHash("sha256").update(bytes).digest("base64url").slice(0, 32)}`;
}
