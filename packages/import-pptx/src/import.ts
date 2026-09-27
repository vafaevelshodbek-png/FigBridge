/**
 * PPTX → Scene: the importer entry point.
 *
 * For every slide: resolve layout → master → theme, draw the background, the master's and
 * layout's decoration (non-placeholder shapes, unless hidden with `showMasterSp="0"`), then
 * the slide's own shape tree.
 */
import type { Paint, Scene, Slide } from "@figbridge/scene";
import { resolveColor } from "./color.js";
import { type BlobStore, type Part, readTheme, type SlideContext } from "./context.js";
import { fillElement, paintsOf, solid, themeFill } from "./fill.js";
import { sniffImage } from "./images.js";
import { Package } from "./package.js";
import { walkTree } from "./shapes.js";
import { attr, child, childrenOf, findAll, num, path, type XmlElement } from "./xml.js";

export interface ImportOptions {
  /** Output slide width in px; height follows the slide aspect ratio. Default 1920. */
  width?: number;
  /** 1-based slide numbers to import; default all. */
  pages?: readonly number[];
  onPage?: (done: number, total: number) => void;
  /**
   * Convert Windows metafiles (EMF, WMF), which Figma cannot show, to PNG. Called once with
   * every metafile in the package; returns PNG bytes by part name. Pictures it leaves out are
   * skipped with a warning.
   */
  convertMetafiles?: (pictures: Metafile[]) => Promise<Map<string, Uint8Array>>;
}

/** A Windows metafile picture in the package. */
export interface Metafile {
  part: string;
  format: "EMF" | "WMF";
  bytes: Uint8Array;
}

export interface ImportResult {
  scene: Scene;
  blobs: BlobStore;
  warnings: string[];
}

/** Default slide size when presentation.xml omits it (16:9, 13.333 × 7.5 in). */
const DEFAULT_SIZE = { cx: 12_192_000, cy: 6_858_000 } as const;
const DEFAULT_CLR_MAP: Readonly<Record<string, string>> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

export function importPptx(
  data: Uint8Array,
  name: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  return Promise.resolve().then(async () => {
    const pkg = new Package(data);
    if (options.convertMetafiles !== undefined) {
      const metafiles = metafilesOf(pkg, options.pages);
      if (metafiles.length > 0) {
        const converted = await options.convertMetafiles(metafiles);
        for (const [part, png] of converted) pkg.replace(part, png);
      }
    }
    return convert(pkg, name, options);
  });
}

/**
 * Metafiles the imported slides can show: parts reachable from those slides through their
 * relationships (slide → layout → master, charts, diagrams). A master's other layouts and
 * speaker notes are not followed, so unused pictures are not converted.
 */
function metafilesOf(pkg: Package, pages: readonly number[] | undefined): Metafile[] {
  const slides = slidePartsOf(pkg);
  const start = pages === undefined ? slides : pages.map((n) => slides[n - 1] ?? "");
  const seen = new Set<string>();
  const queue = start.filter((p) => p !== "");
  for (let part = queue.pop(); part !== undefined; part = queue.pop()) {
    if (seen.has(part)) continue;
    seen.add(part);
    const fromMaster = part.includes("/slideMasters/");
    for (const target of pkg.rels(part).internal.values()) {
      if (target.includes("/notesSlides/") || (fromMaster && target.includes("/slideLayouts/")))
        continue;
      queue.push(target);
    }
  }
  return [...seen].flatMap((part) => {
    const bytes = pkg.bytes(part);
    if (bytes === undefined) return [];
    const sniffed = sniffImage(bytes);
    return sniffed.kind === "unsupported" && (sniffed.format === "EMF" || sniffed.format === "WMF")
      ? [{ part, format: sniffed.format, bytes }]
      : [];
  });
}

/** Slide part names in presentation order. */
function slidePartsOf(pkg: Package): string[] {
  const presentationPart = "ppt/presentation.xml";
  const rels = pkg.rels(presentationPart);
  return childrenOf(child(pkg.xml(presentationPart), "sldIdLst"), "sldId")
    .map((s) => rels.internal.get(attr(s, "r:id") ?? ""))
    .filter((p): p is string => p !== undefined);
}

function convert(pkg: Package, name: string, options: ImportOptions): ImportResult {
  const presentationPart = "ppt/presentation.xml";
  const presentation = pkg.xml(presentationPart);
  if (presentation === undefined)
    throw new TypeError("Not a presentation: ppt/presentation.xml is missing.");
  const size = child(presentation, "sldSz");
  const cx = num(size, "cx", DEFAULT_SIZE.cx);
  const cy = num(size, "cy", DEFAULT_SIZE.cy);
  const width = options.width ?? 1920;
  if (cx <= 0 || cy <= 0) throw new RangeError("Invalid slide size.");
  const scale = width / cx;
  const slideParts = slidePartsOf(pkg);

  const numbers = options.pages ?? slideParts.map((_, i) => i + 1);
  const blobs: BlobStore = new Map();
  const warnings: string[] = [];
  const slides: Slide[] = [];
  for (const [index, number] of numbers.entries()) {
    const partName = slideParts[number - 1];
    if (partName === undefined) throw new RangeError(`Slide ${String(number)} does not exist.`);
    slides.push(
      convertSlide(
        pkg,
        partName,
        number,
        scale,
        cx,
        cy,
        child(presentation, "defaultTextStyle"),
        blobs,
        warnings,
        name.replace(/\.pptx$/i, ""),
      ),
    );
    options.onPage?.(index + 1, numbers.length);
  }
  return {
    scene: {
      version: 1,
      source: { kind: "pptx", name, pages: Math.max(1, slideParts.length) },
      slides,
    },
    blobs,
    warnings: [...new Set(warnings)],
  };
}

function part(pkg: Package, name: string | undefined): Part | undefined {
  if (name === undefined) return undefined;
  const root = pkg.xml(name);
  return root === undefined ? undefined : { name, root };
}

function convertSlide(
  pkg: Package,
  slideName: string,
  number: number,
  scale: number,
  cx: number,
  cy: number,
  defaultTextStyle: XmlElement | undefined,
  blobs: BlobStore,
  warnings: string[],
  deckName: string,
): Slide {
  const slide = part(pkg, slideName);
  if (slide === undefined) throw new TypeError(`Slide ${String(number)} cannot be read.`);
  const layout = part(pkg, pkg.related(slideName, "slideLayout"));
  const master = part(
    pkg,
    layout === undefined ? undefined : pkg.related(layout.name, "slideMaster"),
  );
  const theme = readTheme(
    master === undefined ? undefined : pkg.xml(pkg.related(master.name, "theme") ?? ""),
  );
  const override = path(slide.root, "clrMapOvr/overrideClrMapping");
  const clrMap = override ?? child(master?.root, "clrMap");
  let counter = 0;
  const ctx: SlideContext = {
    pkg,
    scale,
    slideNumber: number,
    slide,
    layout,
    master,
    theme,
    colors: {
      scheme: theme.scheme,
      map: clrMap === undefined ? DEFAULT_CLR_MAP : { ...DEFAULT_CLR_MAP, ...clrMap.attrs },
    },
    defaultTextStyle,
    blobs,
    deckName,
    textStyles: new Map(),
    groupFills: [],
    warn: (message) => warnings.push(message),
    nextId: () => `s${String(number)}_${String(++counter)}`,
  };

  const children: Slide["children"] = [];
  const showMaster = attr(slide.root, "showMasterSp") !== "0";
  const layoutShowsMaster = attr(layout?.root, "showMasterSp") !== "0";
  if (showMaster && layoutShowsMaster && master !== undefined) {
    children.push(
      ...walkTree(ctx, path(master.root, "cSld/spTree"), {
        part: master.name,
        skipPlaceholders: true,
      }),
    );
  }
  if (showMaster && layout !== undefined) {
    children.push(
      ...walkTree(ctx, path(layout.root, "cSld/spTree"), {
        part: layout.name,
        skipPlaceholders: true,
      }),
    );
  }
  children.push(
    ...walkTree(ctx, path(slide.root, "cSld/spTree"), {
      part: slide.name,
      skipPlaceholders: false,
    }),
  );

  const notes = speakerNotes(pkg, slideName);
  return {
    name: String(number).padStart(2, "0"),
    width: Math.round(cx * scale * 100) / 100,
    height: Math.round(cy * scale * 100) / 100,
    background: background(ctx, [slide, layout, master]),
    children,
    ...(ctx.textStyles.size === 0 ? {} : { textStyles: [...ctx.textStyles.values()] }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * The slide's speaker notes: the text of the body placeholder of its notes slide, one line
 * per paragraph. Undefined when the slide has none.
 */
function speakerNotes(pkg: Package, slideName: string): string | undefined {
  const notesPart = pkg.related(slideName, "notesSlide");
  const tree = path(notesPart === undefined ? undefined : pkg.xml(notesPart), "cSld/spTree");
  for (const sp of childrenOf(tree, "sp")) {
    if (attr(path(sp, "nvSpPr/nvPr/ph"), "type") !== "body") continue;
    const text = childrenOf(child(sp, "txBody"), "p")
      .map((p) =>
        findAll(p, "t")
          .map((t) => t.text)
          .join(""),
      )
      .join("\n")
      .trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/** First background along slide → layout → master; white when none is defined. */
function background(ctx: SlideContext, chain: (Part | undefined)[]): Paint[] {
  for (const p of chain) {
    const bg = path(p?.root, "cSld/bg");
    if (bg === undefined || p === undefined) continue;
    const fill = fillElement(child(bg, "bgPr"));
    if (fill !== undefined) return paintsOf(ctx, p.name, fill);
    const ref = child(bg, "bgRef");
    if (ref !== undefined) {
      const paints = themeFill(ctx, p.name, ref);
      if (paints.length > 0) return paints;
      const color = resolveColor(ref, ctx.colors);
      if (color !== undefined) return [solid(color)];
    }
  }
  return [{ type: "solid", color: "#FFFFFF", opacity: 1 }];
}
