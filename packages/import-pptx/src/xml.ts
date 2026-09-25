/**
 * A minimal ordered XML DOM over fast-xml-parser.
 *
 * OOXML meaning depends on element order (paint order in a shape tree, path commands, the
 * first fill child wins), so the parser runs in `preserveOrder` mode. Element names are
 * reduced to their local part (`a:solidFill` → `solidFill`): DrawingML and PresentationML
 * never reuse a local name with a different meaning inside one part. Attributes in the
 * relationships namespace keep an `r:` prefix, because `id` and `r:id` coexist on one element.
 */
import { XMLParser } from "fast-xml-parser";

export interface XmlElement {
  /** Local name, e.g. `sp`, `solidFill`. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content (significant for `a:t`). */
  readonly text: string;
}

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  ignoreDeclaration: true,
  ignorePiTags: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

type RawNode = Record<string, unknown>;

/** Parse an XML document and return its root element. */
export function parseXml(source: string): XmlElement {
  const nodes = parser.parse(source) as unknown;
  const root = Array.isArray(nodes) ? convertAll(nodes as RawNode[], new Map())[0] : undefined;
  if (root === undefined) throw new SyntaxError("XML document has no root element.");
  return root;
}

function convertAll(nodes: readonly RawNode[], scope: ReadonlyMap<string, string>): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of nodes) {
    const element = convert(node, scope);
    if (element !== undefined) out.push(element);
  }
  return out;
}

function convert(node: RawNode, parentScope: ReadonlyMap<string, string>): XmlElement | undefined {
  const tag = Object.keys(node).find((key) => key !== ":@" && key !== "#text");
  if (tag === undefined) return undefined;
  const rawAttrs = (node[":@"] ?? {}) as Record<string, unknown>;
  let scope = parentScope;
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (key.startsWith("xmlns:")) {
      if (scope === parentScope) scope = new Map(parentScope);
      (scope as Map<string, string>).set(key.slice(6), String(value));
    }
  }
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (key.startsWith("xmlns")) continue;
    const colon = key.indexOf(":");
    if (colon < 0) {
      attrs[key] = String(value);
      continue;
    }
    const local = key.slice(colon + 1);
    const ns = scope.get(key.slice(0, colon));
    attrs[ns === RELATIONSHIPS_NS ? `r:${local}` : local] = String(value);
  }
  const rawChildren = Array.isArray(node[tag]) ? (node[tag] as RawNode[]) : [];
  let text = "";
  for (const child of rawChildren) {
    const value = child["#text"];
    if (typeof value === "string" || typeof value === "number") text += String(value);
  }
  return {
    name: tag.slice(tag.indexOf(":") + 1),
    attrs,
    children: convertAll(rawChildren, scope),
    text,
  };
}

// ── queries ─────────────────────────────────────────────────────────────────

/** First direct child named `name`. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** All direct children named `name`. */
export function childrenOf(el: XmlElement | undefined, name: string): XmlElement[] {
  return el === undefined ? [] : el.children.filter((c) => c.name === name);
}

/** Follow a `/`-separated chain of direct children: `path(sp, "txBody/bodyPr")`. */
export function path(el: XmlElement | undefined, chain: string): XmlElement | undefined {
  let current = el;
  for (const name of chain.split("/")) current = child(current, name);
  return current;
}

/** First descendant (depth-first, document order) named `name`. */
export function find(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (el === undefined) return undefined;
  for (const c of el.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep !== undefined) return deep;
  }
  return undefined;
}

/** All descendants named `name`, in document order. */
export function findAll(el: XmlElement | undefined, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  if (el !== undefined) walk(el);
  return out;
}

export function attr(el: XmlElement | undefined, name: string): string | undefined {
  return el?.attrs[name];
}

/** Integer/decimal attribute, or `fallback` when absent or malformed. */
export function num(el: XmlElement | undefined, name: string, fallback: number): number {
  const raw = el?.attrs[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** OOXML boolean attribute ("1"/"true"/"0"/"false"), or undefined when absent. */
export function bool(el: XmlElement | undefined, name: string): boolean | undefined {
  const raw = el?.attrs[name];
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true" || raw === "on";
}
