/**
 * A strict stand-in for the part of the Figma Plugin API the renderer uses.
 *
 * It is not a mock that records calls: it enforces the rules the real API enforces, so a
 * scene that renders here without errors renders in Figma too. Every rule below comes from
 * the plugin typings/docs or from a failure seen in real Figma:
 *  - createImage: PNG/JPEG/GIF only, at most 4096 px per side ("Image is too large");
 *  - vectorPaths: only absolute M, L, Q, C, Z separated by single spaces;
 *  - resize: both sides at least 0.01;
 *  - paints: colour channels and opacity in 0..1, 2×3 finite transforms, stops in 0..1,
 *    image paints must reference an uploaded image, no unknown keys;
 *  - text: the node's font, and every font given to setRangeFontName, must be loaded first;
 *  - numbers are finite everywhere (NaN and Infinity are rejected);
 *  - setting vectorPaths moves the data so its bounds start at (0, 0) and resizes the node
 *    to those bounds (the pie charts of the first live test landed stacked in a corner).
 */
import { isFigmaPath, pathBounds } from "@figbridge/scene";

export class FigmaError extends Error {}

const MAX_IMAGE_SIDE = 4096;

function fail(message: string): never {
  throw new FigmaError(message);
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${what}: expected a finite number, got ${String(value)}`);
  return value;
}

function unit(value: unknown, what: string): number {
  const n = finite(value, what);
  if (n < 0 || n > 1) fail(`${what}: expected 0..1, got ${String(n)}`);
  return n;
}

function onlyKeys(object: object, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${what}: unrecognized key(s) ${unknown.join(", ")}`);
}

function transform(m: unknown, what: string): void {
  if (!Array.isArray(m) || m.length !== 2) fail(`${what}: expected a 2×3 matrix`);
  for (const row of m as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3) fail(`${what}: expected a 2×3 matrix`);
    for (const value of row as unknown[]) finite(value, what);
  }
}

function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      const length = view.getUint16(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  fail("Image type is unsupported");
}

/** Test switch: raster exports never settle, as seen in live Figma on 27.09.2026. */
export const exportBehaviour = { rasterHangs: false };

export class FakeFigma {
  readonly mixed = Symbol("mixed");
  editorType: "figma" | "slides" = "figma";
  /**
   * Average glyph advance, as a share of the font size, used to lay text out when a text
   * node sizes itself (textAutoResize). Raise it to simulate a wider replacement font.
   */
  textAdvance = 0.5;
  readonly images = new Map<string, { width: number; height: number }>();
  readonly availableFonts = new Set([
    "Inter\u0000Regular",
    "Inter\u0000Bold",
    "Inter\u0000Italic",
    "Inter\u0000Bold Italic",
    "Inter\u0000Medium",
    "Inter\u0000Light",
    "Inter\u0000Semi Bold",
  ]);
  readonly loadedFonts = new Set<string>();
  readonly #nodes = new Map<string, FakeNode>();
  #nextId = 1;
  readonly root: FakeNode;
  currentPage: FakeNode;

  constructor() {
    this.root = new FakeNode(this, "DOCUMENT");
    this.root.name = "Untitled";
    this.currentPage = new FakeNode(this, "PAGE");
    this.currentPage.name = "Page 1";
    this.root.appendChild(this.currentPage);
  }

  register(node: FakeNode): string {
    const id = `${String(this.#nextId++)}:1`;
    this.#nodes.set(id, node);
    return id;
  }

  /** Every node on the page, depth first. */
  all(): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this.currentPage);
    return out;
  }

  readonly textStyles: FakeTextStyle[] = [];
  readonly collections: FakeVariableCollection[] = [];
  readonly localVariables: FakeVariable[] = [];

  readonly variables = {
    getLocalVariableCollectionsAsync: () => Promise.resolve([...this.collections]),
    getLocalVariablesAsync: (type?: string) =>
      Promise.resolve(
        this.localVariables.filter((v) => type === undefined || v.resolvedType === type),
      ),
    createVariableCollection: (name: string) => {
      const collection = new FakeVariableCollection(`VC:${String(this.#nextId++)}`, name);
      this.collections.push(collection);
      return collection;
    },
    createVariable: (name: string, collection: FakeVariableCollection, type: string) => {
      if (!this.collections.includes(collection)) fail("createVariable: unknown collection");
      const variable = new FakeVariable(`V:${String(this.#nextId++)}`, name, collection, type);
      this.localVariables.push(variable);
      return variable;
    },
    setBoundVariableForPaint: (paint: { type: string }, field: string, variable: FakeVariable) => {
      if (paint.type !== "SOLID" || field !== "color")
        fail("setBoundVariableForPaint: SOLID color only");
      return { ...paint, boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } } };
    },
  };

  createTextStyle = () => {
    const style = new FakeTextStyle(this, `S:${String(this.#nextId++)}`);
    this.textStyles.push(style);
    return style;
  };

  getLocalTextStylesAsync = () => Promise.resolve([...this.textStyles]);

  createFrame = () => new FakeNode(this, "FRAME");
  /** Figma Slides only: a 1920 × 1080 slide appended to the presentation. */
  createSlide = () => {
    if (this.editorType !== "slides") fail("createSlide is only available in Figma Slides");
    const slide = new FakeNode(this, "SLIDE");
    slide.resize(1920, 1080);
    this.currentPage.appendChild(slide);
    return slide;
  };
  createRectangle = () => new FakeNode(this, "RECTANGLE");
  createEllipse = () => new FakeNode(this, "ELLIPSE");
  /** Like Figma's, a new vector has a 1 px black stroke until told otherwise. */
  createVector = () => {
    const vector = new FakeNode(this, "VECTOR");
    vector.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
    return vector;
  };
  createText = () => {
    const text = new FakeNode(this, "TEXT");
    text.fontNameValue = { family: "Inter", style: "Regular" };
    return text;
  };

  createImage = (bytes: Uint8Array) => {
    const size = imageSize(bytes);
    if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) fail("Image is too large");
    const hash = `img${String(this.images.size + 1)}`;
    this.images.set(hash, size);
    return { hash, getSizeAsync: () => Promise.resolve(size) };
  };

  /** Images whose bytes the renderer has loaded; raster exports draw the others blank. */
  readonly loadedImages = new Set<string>();
  /** Raster exports taken while an image in the node was not loaded yet. */
  blankRasterExports = 0;

  getImageByHash = (hash: string) =>
    this.images.has(hash)
      ? {
          hash,
          getBytesAsync: () => {
            this.loadedImages.add(hash);
            return Promise.resolve(new Uint8Array());
          },
        }
      : null;

  group = (children: readonly FakeNode[], parent: FakeNode) => {
    if (children.length === 0) fail("Grouping zero nodes");
    const group = new FakeNode(this, "GROUP");
    parent.appendChild(group);
    for (const child of children) group.appendChild(child);
    return group;
  };

  loadFontAsync = (font: { family: string; style: string }) => {
    const key = `${font.family}\u0000${font.style}`;
    if (!this.availableFonts.has(key))
      return Promise.reject(
        new FigmaError(`The font "${font.family} ${font.style}" could not be loaded`),
      );
    this.loadedFonts.add(key);
    return Promise.resolve();
  };

  undoSteps = 0;
  commitUndo = () => {
    this.undoSteps++;
  };
  notify = () => ({ cancel: () => undefined });
  /** Removed nodes are gone for good, as in Figma. */
  getNodeByIdAsync = (id: string) => {
    const node = this.#nodes.get(id);
    return Promise.resolve(node === undefined || node.removed ? null : node);
  };

  /** Messages the main thread posted to the UI iframe. */
  readonly posted: unknown[] = [];
  readonly ui = {
    postMessage: (message: unknown) => {
      this.posted.push(message);
    },
    onmessage: undefined as ((message: unknown) => void) | undefined,
  };

  readonly storage = new Map<string, unknown>();
  readonly clientStorage = {
    getAsync: (key: string) => Promise.resolve(this.storage.get(key)),
    setAsync: (key: string, value: unknown) => {
      this.storage.set(key, value);
      return Promise.resolve();
    },
  };

  shown = false;
  showUI = () => {
    this.shown = true;
  };

  addPage(name: string): FakeNode {
    const page = new FakeNode(this, "PAGE");
    page.name = name;
    this.root.appendChild(page);
    return page;
  }

  setCurrentPageAsync = (page: FakeNode) => {
    if (page.type !== "PAGE") fail("setCurrentPageAsync expects a page");
    this.currentPage = page;
    return Promise.resolve();
  };

  requireFont(font: { family: string; style: string }, what: string): void {
    if (!this.loadedFonts.has(`${font.family}\u0000${font.style}`)) {
      fail(
        `${what}: unloaded font "${font.family} ${font.style}". Please call figma.loadFontAsync first.`,
      );
    }
  }
}

const PAINT_KEYS: Record<string, readonly string[]> = {
  SOLID: ["type", "color", "opacity", "visible", "blendMode", "boundVariables"],
  GRADIENT_LINEAR: [
    "type",
    "gradientTransform",
    "gradientStops",
    "opacity",
    "visible",
    "blendMode",
  ],
  GRADIENT_RADIAL: [
    "type",
    "gradientTransform",
    "gradientStops",
    "opacity",
    "visible",
    "blendMode",
  ],
  IMAGE: [
    "type",
    "imageHash",
    "scaleMode",
    "imageTransform",
    "scalingFactor",
    "opacity",
    "visible",
    "blendMode",
    "filters",
    "rotation",
  ],
};

export class FakeNode {
  readonly id: string;
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;
  name = "";
  visible = true;
  clipsContent = false;
  #width = 100;
  #height = 100;
  #x = 0;
  #y = 0;
  #opacity = 1;
  #fills: readonly unknown[] = [];
  #strokes: readonly unknown[] = [];
  #vectorPaths: readonly { windingRule: string; data: string }[] = [];
  #characters = "";
  fontNameValue: { family: string; style: string } | undefined;
  readonly props: Record<string, unknown> = {};

  constructor(
    private readonly figma: FakeFigma,
    readonly type: string,
  ) {
    this.id = figma.register(this);
  }

  appendChild(child: FakeNode): void {
    if (child === this) fail("Cannot append a node to itself");
    for (let p = this.parent; p !== null; p = p.parent)
      if (p === child) fail("Cannot append a node to its own descendant");
    if (child.parent !== null)
      child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }

  removed = false;
  selection: FakeNode[] = [];
  readonly pluginData = new Map<string, string>();
  annotations: readonly { label?: string }[] = [];
  locked = false;
  #fontSize = 12;
  get fontSize(): number {
    return this.#fontSize;
  }
  set fontSize(value: number) {
    if (finite(value, "fontSize") < 1) fail("fontSize must be >= 1");
    this.#fontSize = value;
  }

  /** Scale the node and its content (Figma's rescale): here size, and children's boxes. */
  rescale(scale: number): void {
    if (finite(scale, "rescale") < 0.01) fail("rescale must be >= 0.01");
    this.resize(this.width * scale, this.height * scale);
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        child.x *= scale;
        child.y *= scale;
        child.resize(Math.max(0.01, child.width * scale), Math.max(0.01, child.height * scale));
        walk(child);
      }
    };
    walk(this);
  }

  getPluginData(key: string): string {
    return this.pluginData.get(key) ?? "";
  }

  setPluginData(key: string, value: string): void {
    if (typeof value !== "string") fail("setPluginData expects a string");
    this.pluginData.set(key, value);
  }
  rotation = 0;

  remove(): void {
    if (this.parent !== null) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    const mark = (node: FakeNode) => {
      node.removed = true;
      node.children.forEach(mark);
    };
    mark(this);
  }

  /** Descendants matching `predicate`, depth first (Figma's findAll). */
  findAll(predicate: (node: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (predicate(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** Bounds on the canvas (translation only: enough for the handlers' summaries). */
  get absoluteBoundingBox(): { x: number; y: number; width: number; height: number } | null {
    if (this.type === "PAGE" || this.type === "DOCUMENT") return null;
    let x = this.x;
    let y = this.y;
    for (let p = this.parent; p !== null && p.type !== "PAGE"; p = p.parent) {
      x += p.x;
      y += p.y;
    }
    return { x, y, width: this.width, height: this.height };
  }

  /** A copy in the same parent, right after the original (Figma's clone). */
  clone(): FakeNode {
    if (this.type === "PAGE" || this.type === "DOCUMENT") fail("Cannot clone a page");
    const copy = new FakeNode(this.figma, this.type);
    copy.name = this.name;
    copy.resize(this.width, this.height);
    copy.x = this.x;
    copy.y = this.y;
    copy.fills = this.fills;
    if (this.parent !== null) this.parent.appendChild(copy);
    return copy;
  }

  exportAsync(settings: {
    format: string;
    constraint?: { type: string; value: number };
  }): Promise<Uint8Array> {
    if (!["PNG", "JPG", "SVG", "PDF"].includes(settings.format))
      fail(`export format ${settings.format}`);
    if (settings.format === "PNG" || settings.format === "JPG") {
      const unloaded = (n: FakeNode): boolean =>
        (Array.isArray(n.fills) &&
          (n.fills as { type: string; imageHash?: string }[]).some(
            (f) => f.type === "IMAGE" && !this.figma.loadedImages.has(f.imageHash ?? ""),
          )) ||
        n.children.some(unloaded);
      if (unloaded(this)) this.figma.blankRasterExports++;
    }
    if (exportBehaviour.rasterHangs && (settings.format === "PNG" || settings.format === "JPG"))
      return new Promise<Uint8Array>(() => undefined);
    return Promise.resolve(new TextEncoder().encode(`${settings.format}:${this.id}`));
  }

  getRangeAllFontNames(start: number, end: number): { family: string; style: string }[] {
    if (start < 0 || end < start) fail("getRangeAllFontNames: bad range");
    return [this.fontName];
  }

  resize(width: number, height: number): void {
    if (finite(width, "resize width") < 0.01) fail(`Expected width >= 0.01, got ${String(width)}`);
    if (finite(height, "resize height") < 0.01)
      fail(`Expected height >= 0.01, got ${String(height)}`);
    this.#width = width;
    this.#height = height;
  }

  get width(): number {
    return this.#width;
  }
  get height(): number {
    return this.#height;
  }
  get x(): number {
    return this.#x;
  }
  set x(value: number) {
    this.#x = finite(value, "x");
  }
  get y(): number {
    return this.#y;
  }
  set y(value: number) {
    this.#y = finite(value, "y");
  }
  get opacity(): number {
    return this.#opacity;
  }
  set opacity(value: number) {
    this.#opacity = unit(value, "opacity");
  }

  #matrix: [[number, number, number], [number, number, number]] | undefined;

  set relativeTransform(m: [[number, number, number], [number, number, number]]) {
    transform(m, "relativeTransform");
    this.#matrix = m;
    this.#x = m[0][2];
    this.#y = m[1][2];
  }

  /** A local point of this node in its parent's coordinates. */
  toParent(x: number, y: number): [number, number] {
    const m = this.#matrix ?? [
      [1, 0, this.#x],
      [0, 1, this.#y],
    ];
    return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
  }

  get fills(): readonly unknown[] {
    return this.#fills;
  }
  set fills(paints: readonly unknown[]) {
    this.#fills = Object.freeze(
      paints.map((paint, i) => this.#checkPaint(paint, `fills[${String(i)}]`)),
    );
  }
  get strokes(): readonly unknown[] {
    return this.#strokes;
  }
  set strokes(paints: readonly unknown[]) {
    this.#strokes = Object.freeze(
      paints.map((paint, i) => this.#checkPaint(paint, `strokes[${String(i)}]`)),
    );
  }

  set strokeWeight(value: number) {
    if (finite(value, "strokeWeight") < 0) fail("strokeWeight must be >= 0");
  }
  set dashPattern(values: readonly number[]) {
    for (const value of values)
      if (finite(value, "dashPattern") < 0) fail("dashPattern must be >= 0");
  }
  set strokeAlign(value: string) {
    if (!["INSIDE", "CENTER", "OUTSIDE"].includes(value)) fail(`strokeAlign: ${value}`);
  }
  set strokeJoin(value: string) {
    if (!["MITER", "ROUND", "BEVEL"].includes(value)) fail(`strokeJoin: ${value}`);
  }
  set strokeCap(value: string) {
    if (!["NONE", "ROUND", "SQUARE"].includes(value)) fail(`strokeCap: ${value}`);
  }

  #cornerRadius = 0;
  get cornerRadius(): number {
    return this.#cornerRadius;
  }
  set cornerRadius(value: number) {
    if (finite(value, "cornerRadius") < 0) fail("cornerRadius must be >= 0");
    this.#cornerRadius = value;
  }
  set topLeftRadius(value: number) {
    this.cornerRadius = value;
  }
  set topRightRadius(value: number) {
    this.cornerRadius = value;
  }
  set bottomLeftRadius(value: number) {
    this.cornerRadius = value;
  }
  set bottomRightRadius(value: number) {
    this.cornerRadius = value;
  }

  get vectorPaths(): readonly { windingRule: string; data: string }[] {
    return this.#vectorPaths;
  }
  set vectorPaths(paths: readonly { windingRule: string; data: string }[]) {
    if (this.type !== "VECTOR") fail("vectorPaths is only settable on vectors");
    for (const path of paths) {
      if (!["NONZERO", "EVENODD", "NONE"].includes(path.windingRule))
        fail(`windingRule: ${path.windingRule}`);
      if (!isFigmaPath(path.data))
        fail(`Failed to set vectorPaths: invalid path data "${path.data.slice(0, 60)}"`);
    }
    // Figma normalises the geometry: data moves so its bounds start at the origin.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
      const b = pathBounds(path.data);
      if (b === undefined) continue;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (!Number.isFinite(minX)) {
      this.#vectorPaths = paths;
      return;
    }
    const shift = (data: string) => {
      const tokens = data.split(" ");
      let axis = 0;
      return tokens
        .map((token) => {
          if (/^[A-Z]$/.test(token)) {
            axis = 0;
            return token;
          }
          const value = Number(token) - (axis++ % 2 === 0 ? minX : minY);
          return String(Math.round(value * 1000) / 1000);
        })
        .join(" ");
    };
    this.#vectorPaths = paths.map((path) => ({ ...path, data: shift(path.data) }));
    this.#width = Math.max(maxX - minX, 0.01);
    this.#height = Math.max(maxY - minY, 0.01);
  }

  // ── text ────────────────────────────────────────────────────────────────────

  get fontName(): { family: string; style: string } {
    return this.fontNameValue ?? fail("not a text node");
  }
  set fontName(font: { family: string; style: string }) {
    this.figma.requireFont(font, "fontName");
    this.fontNameValue = font;
  }
  get characters(): string {
    return this.#characters;
  }
  set characters(value: string) {
    this.figma.requireFont(this.fontName, "characters");
    this.#characters = value;
  }

  #range(start: number, end: number, what: string): void {
    finite(start, what);
    finite(end, what);
    if (start < 0 || end > this.#characters.length || start >= end) {
      fail(
        `${what}: range ${String(start)}..${String(end)} outside 0..${String(this.#characters.length)}`,
      );
    }
    this.figma.requireFont(this.fontName, what);
  }
  /** Text style ids linked with setRangeTextStyleIdAsync, by range. */
  readonly styleRanges: { start: number; end: number; id: string }[] = [];

  setRangeTextStyleIdAsync(start: number, end: number, id: string): Promise<void> {
    this.#range(start, end, "setRangeTextStyleIdAsync");
    const style = this.figma.textStyles.find((s) => s.id === id);
    if (style === undefined) fail(`setRangeTextStyleIdAsync: no style ${id}`);
    this.figma.requireFont(style.fontName, "setRangeTextStyleIdAsync");
    this.styleRanges.push({ start, end, id });
    return Promise.resolve();
  }

  setRangeFontName(start: number, end: number, font: { family: string; style: string }): void {
    this.#range(start, end, "setRangeFontName");
    this.figma.requireFont(font, "setRangeFontName");
  }
  #largestSize = 0;

  setRangeFontSize(start: number, end: number, size: number): void {
    this.#range(start, end, "setRangeFontSize");
    this.#largestSize = Math.max(this.#largestSize, size);
    if (finite(size, "fontSize") < 1) fail(`fontSize must be >= 1, got ${String(size)}`);
  }
  setRangeFills(start: number, end: number, paints: readonly unknown[]): void {
    this.#range(start, end, "setRangeFills");
    for (const [i, paint] of paints.entries())
      this.#checkPaint(paint, `setRangeFills[${String(i)}]`);
  }
  setRangeLetterSpacing(start: number, end: number, value: { unit: string; value: number }): void {
    this.#range(start, end, "setRangeLetterSpacing");
    finite(value.value, "letterSpacing");
  }
  setRangeLineHeight(start: number, end: number, value: { unit: string; value?: number }): void {
    this.#range(start, end, "setRangeLineHeight");
    if (value.unit !== "AUTO" && finite(value.value, "lineHeight") < 0)
      fail("lineHeight must be >= 0");
  }
  setRangeTextCase(start: number, end: number): void {
    this.#range(start, end, "setRangeTextCase");
  }
  setRangeTextDecoration(start: number, end: number): void {
    this.#range(start, end, "setRangeTextDecoration");
  }
  setRangeHyperlink(start: number, end: number): void {
    this.#range(start, end, "setRangeHyperlink");
  }
  setRangeListOptions(start: number, end: number, options: { type: string }): void {
    this.#range(start, end, "setRangeListOptions");
    if (!["ORDERED", "UNORDERED", "NONE"].includes(options.type)) fail(`list type ${options.type}`);
  }
  setRangeIndentation(start: number, end: number, level: number): void {
    this.#range(start, end, "setRangeIndentation");
    if (!Number.isInteger(level) || level < 0) fail("indentation must be a non-negative integer");
  }
  set paragraphSpacing(value: number) {
    finite(value, "paragraphSpacing");
  }
  set listSpacing(value: number) {
    finite(value, "listSpacing");
  }
  set textAlignHorizontal(value: string) {
    if (!["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(value))
      fail(`textAlignHorizontal: ${value}`);
  }
  set textAlignVertical(value: string) {
    if (!["TOP", "CENTER", "BOTTOM"].includes(value)) fail(`textAlignVertical: ${value}`);
  }
  /** Rough layout: lines by character count, 1.2 × the largest size per line. */
  #layOut(mode: string): void {
    const size = this.#largestSize || this.#fontSize;
    const lines = this.#characters.split("\n");
    const advance = size * this.figma.textAdvance;
    if (mode === "WIDTH_AND_HEIGHT") {
      this.#width = Math.max(0.01, Math.max(...lines.map((l) => l.length)) * advance);
      this.#height = Math.max(0.01, lines.length * size * 1.2);
    } else if (mode === "HEIGHT") {
      const perLine = Math.max(1, Math.floor(this.#width / advance));
      const count = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / perLine)), 0);
      this.#height = Math.max(0.01, count * size * 1.2);
    }
  }

  set textAutoResize(value: string) {
    this.#layOut(value);
    if (!["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"].includes(value))
      fail(`textAutoResize: ${value}`);
  }

  #checkPaint(paint: unknown, what: string): unknown {
    if (typeof paint !== "object" || paint === null) fail(`${what}: not a paint`);
    const p = paint as Record<string, unknown>;
    const type = String(p["type"]);
    const keys = PAINT_KEYS[type] ?? fail(`${what}: unsupported paint type ${type}`);
    onlyKeys(p, keys, what);
    if (p["opacity"] !== undefined) unit(p["opacity"], `${what}.opacity`);
    if (type === "SOLID") {
      const color = p["color"] as Record<string, unknown>;
      onlyKeys(color, ["r", "g", "b"], `${what}.color`);
      for (const c of ["r", "g", "b"]) unit(color[c], `${what}.color.${c}`);
    } else if (type === "IMAGE") {
      const hash = p["imageHash"];
      if (typeof hash !== "string" || !this.figma.images.has(hash))
        fail(`${what}: unknown imageHash ${String(hash)}`);
      if (p["imageTransform"] !== undefined)
        transform(p["imageTransform"], `${what}.imageTransform`);
      if (
        p["scalingFactor"] !== undefined &&
        finite(p["scalingFactor"], `${what}.scalingFactor`) <= 0
      )
        fail(`${what}: scalingFactor must be > 0`);
    } else {
      transform(p["gradientTransform"], `${what}.gradientTransform`);
      const stops = p["gradientStops"];
      if (!Array.isArray(stops) || stops.length < 2)
        fail(`${what}: a gradient needs at least two stops`);
      for (const stop of stops as { position: unknown; color: Record<string, unknown> }[]) {
        unit(stop.position, `${what}.gradientStops.position`);
        for (const c of ["r", "g", "b", "a"])
          unit(stop.color[c], `${what}.gradientStops.color.${c}`);
      }
    }
    return paint;
  }
}

/** Install a fresh fake as the global `figma` and return it. */
export class FakeVariableCollection {
  readonly defaultModeId = "M:1";
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
}

export class FakeVariable {
  readonly valuesByMode: Record<string, unknown> = {};
  readonly variableCollectionId: string;
  constructor(
    readonly id: string,
    readonly name: string,
    collection: FakeVariableCollection,
    readonly resolvedType: string,
  ) {
    this.variableCollectionId = collection.id;
  }

  setValueForMode(mode: string, value: { r: number; g: number; b: number }): void {
    for (const c of [value.r, value.g, value.b])
      if (!(c >= 0 && c <= 1)) fail("setValueForMode: colour channels must be in [0, 1]");
    this.valuesByMode[mode] = value;
  }
}

/** A local text style; its font must be loaded before it is set, as in Figma. */
export class FakeTextStyle {
  name = "";
  #fontName = { family: "Inter", style: "Regular" };
  fontSize = 12;
  letterSpacing: { unit: string; value: number } = { unit: "PERCENT", value: 0 };
  lineHeight: { unit: string; value?: number } = { unit: "AUTO" };
  textCase = "ORIGINAL";

  constructor(
    private readonly figma: FakeFigma,
    readonly id: string,
  ) {}

  get fontName(): { family: string; style: string } {
    return this.#fontName;
  }

  set fontName(font: { family: string; style: string }) {
    this.figma.requireFont(font, "TextStyle.fontName");
    this.#fontName = font;
  }
}

export function installFakeFigma(): FakeFigma {
  const fake = new FakeFigma();
  (globalThis as { figma?: unknown }).figma = fake;
  return fake;
}
