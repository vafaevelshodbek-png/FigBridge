/**
 * OPC package access: the zip container, parsed parts and relationships.
 */
import { unzipSync } from "fflate";
import { attr, childrenOf, parseXml, type XmlElement } from "./xml.js";

export interface Relationships {
  /** Internal targets, resolved to absolute part names ("ppt/media/image1.png"). */
  readonly internal: ReadonlyMap<string, string>;
  /** External targets (hyperlinks), verbatim. */
  readonly external: ReadonlyMap<string, string>;
}

/** Upper bound on total uncompressed size: a zip bomb must not exhaust memory. */
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

export class Package {
  private readonly files: Record<string, Uint8Array>;
  private readonly xmlCache = new Map<string, XmlElement | undefined>();
  private readonly relsCache = new Map<string, Relationships>();
  private readonly decoder = new TextDecoder();

  constructor(data: Uint8Array) {
    let total = 0;
    try {
      this.files = unzipSync(data, {
        filter: (file) => {
          total += file.originalSize;
          if (total > MAX_UNCOMPRESSED_BYTES) throw new RangeError("Package is too large.");
          return !file.name.endsWith("/");
        },
      });
    } catch (error) {
      throw new TypeError("Not a valid .pptx file (cannot read the zip container).", {
        cause: error,
      });
    }
  }

  /** Names of all parts in the package. */
  parts(): string[] {
    return Object.keys(this.files);
  }

  /** Swap a part's bytes (e.g. a converted picture) before slides are read. */
  replace(part: string, bytes: Uint8Array): void {
    this.files[part] = bytes;
  }

  has(part: string): boolean {
    return part in this.files;
  }

  bytes(part: string): Uint8Array | undefined {
    return this.files[part];
  }

  /** Parsed part, or undefined when missing or malformed. */
  xml(part: string): XmlElement | undefined {
    if (!this.xmlCache.has(part)) {
      const bytes = this.files[part];
      let parsed: XmlElement | undefined;
      if (bytes !== undefined) {
        try {
          parsed = parseXml(this.decoder.decode(bytes));
        } catch {
          parsed = undefined;
        }
      }
      this.xmlCache.set(part, parsed);
    }
    return this.xmlCache.get(part);
  }

  rels(part: string): Relationships {
    const cached = this.relsCache.get(part);
    if (cached !== undefined) return cached;
    const slash = part.lastIndexOf("/");
    const dir = slash < 0 ? "" : part.slice(0, slash);
    const relsPart = `${dir === "" ? "" : `${dir}/`}_rels/${part.slice(slash + 1)}.rels`;
    const internal = new Map<string, string>();
    const external = new Map<string, string>();
    for (const rel of childrenOf(this.xml(relsPart), "Relationship")) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (id === undefined || target === undefined) continue;
      if (attr(rel, "TargetMode") === "External") external.set(id, target);
      else internal.set(id, resolvePart(dir, target));
    }
    const result = { internal, external };
    this.relsCache.set(part, result);
    return result;
  }

  /** Target of the first internal relationship whose part name contains `fragment`. */
  related(part: string, fragment: string): string | undefined {
    for (const target of this.rels(part).internal.values())
      if (target.includes(fragment)) return target;
    return undefined;
  }
}

/** Resolve a relationship target against the source part's directory (POSIX semantics). */
export function resolvePart(dir: string, target: string): string {
  const segments = target.startsWith("/") ? [] : dir.split("/").filter((s) => s !== "");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(safeDecode(segment));
  }
  return segments.join("/");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
