/**
 * Builds minimal .pptx packages in memory, so a test can state the few lines of DrawingML
 * it is about and nothing else. Parts are plain XML strings; the importer ignores namespace
 * prefixes, so fragments can use `p:`/`a:`/`c:` without declaring them.
 */
import { strToU8, zipSync } from "fflate";

export interface SlideSpec {
  /** Children of `p:spTree`. */
  shapes: string;
  /** Extra `Relationship` elements for this slide (media, charts). */
  rels?: string;
  /** `p:bg` element, if any. */
  background?: string;
}

export interface DeckSpec {
  slides: SlideSpec[];
  /** Extra parts: path → XML string or bytes (media, charts). */
  parts?: Record<string, string | Uint8Array>;
  /** Children of the master's `p:txStyles` (titleStyle, bodyStyle, otherStyle). */
  masterTextStyles?: string;
  /** `a:clrScheme` children; defaults to Office colours. */
  colors?: string;
  width?: number;
  height?: number;
}

const OFFICE_COLORS = `
  <a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
  <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
  <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>`;

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Namespaces real parts declare on their root (r:id is namespace-bound; other readers need all). */
const NAMESPACES = [
  `xmlns:r="${RELATIONSHIPS_NS}"`,
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"',
  'xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"',
].join(" ");

function withRelationshipsNs(xml: string): string {
  if (xml.startsWith("<Types") || xml.startsWith("<Relationships")) return xml;
  return xml.replace(/^<([\w:]+)/, `<$1 ${NAMESPACES}`);
}

const OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const PRESENTATIONML = "application/vnd.openxmlformats-officedocument.presentationml";
const CONTENT_TYPES: Record<string, string> = {
  "ppt/presentation.xml": `${PRESENTATIONML}.presentation.main+xml`,
  slides: `${PRESENTATIONML}.slide+xml`,
  slideLayouts: `${PRESENTATIONML}.slideLayout+xml`,
  slideMasters: `${PRESENTATIONML}.slideMaster+xml`,
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  charts: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
};

function contentTypes(parts: string[]): string {
  const overrides = parts
    .filter((p) => p.endsWith(".xml") && !p.includes("_rels"))
    .flatMap((p) => {
      const type = CONTENT_TYPES[p] ?? CONTENT_TYPES[p.split("/")[1] ?? ""];
      return type === undefined ? [] : [`<Override PartName="/${p}" ContentType="${type}"/>`];
    });
  return (
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="gif" ContentType="image/gif"/>` +
    `${overrides.join("")}</Types>`
  );
}

function rels(entries: string): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

export function buildPptx(spec: DeckSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, content: string | Uint8Array) => {
    files[path] = typeof content === "string" ? strToU8(withRelationshipsNs(content)) : content;
  };
  const ids = spec.slides.map(
    (_, i) => `<p:sldId id="${String(256 + i)}" r:id="rId${String(i + 1)}"/>`,
  );
  put(
    "ppt/presentation.xml",
    `<p:presentation><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rMaster"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${ids.join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${String(spec.width ?? 12_192_000)}" cy="${String(spec.height ?? 6_858_000)}"/></p:presentation>`,
  );
  put(
    "ppt/_rels/presentation.xml.rels",
    rels(
      spec.slides
        .map(
          (_, i) =>
            `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${String(i + 1)}.xml"/>`,
        )
        .join("") +
        `<Relationship Id="rMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
    ),
  );
  put(
    "ppt/theme/theme1.xml",
    `<a:theme><a:themeElements><a:clrScheme name="t">${spec.colors ?? OFFICE_COLORS}</a:clrScheme>` +
      `<a:fontScheme><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill></a:fillStyleLst>` +
      `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
      `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `<p:sldMaster><p:cSld><p:spTree/></p:cSld>${spec.masterTextStyles === undefined ? "" : `<p:txStyles>${spec.masterTextStyles}</p:txStyles>`}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rLayout"/></p:sldLayoutIdLst></p:sldMaster>`,
  );
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `<Relationship Id="rLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ),
  );
  put(
    "ppt/slideLayouts/slideLayout1.xml",
    `<p:sldLayout><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
  );
  put(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`,
    ),
  );
  spec.slides.forEach((slide, i) => {
    const n = String(i + 1);
    put(
      `ppt/slides/slide${n}.xml`,
      `<p:sld><p:cSld>${slide.background ?? ""}<p:spTree>${slide.shapes}</p:spTree></p:cSld></p:sld>`,
    );
    put(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      rels(
        `<Relationship Id="rLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${slide.rels ?? ""}`,
      ),
    );
  });
  for (const [path, content] of Object.entries(spec.parts ?? {})) put(path, content);
  // Package plumbing other readers (PowerPoint, LibreOffice) require.
  put(
    "_rels/.rels",
    rels(`<Relationship Id="rDoc" Type="${OFFICE_DOCUMENT}" Target="ppt/presentation.xml"/>`),
  );
  put("[Content_Types].xml", contentTypes(Object.keys(files)));
  return zipSync(files);
}

/** A `p:sp` rectangle at (x, y) EMU with the given `spPr` body and optional text. */
export function shape(
  name: string,
  spPr: string,
  options: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    prst?: string;
    text?: string;
    style?: string;
  } = {},
): string {
  const { x = 914_400, y = 914_400, w = 1_828_800, h = 914_400, prst = "rect" } = options;
  const geometry = spPr.includes("Geom")
    ? ""
    : `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
  const text =
    options.text === undefined
      ? ""
      : `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${options.text}</a:t></a:r></a:p></p:txBody>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(w)}" cy="${String(h)}"/></a:xfrm>${geometry}${spPr}</p:spPr>` +
    `${options.style ?? ""}${text}</p:sp>`
  );
}
