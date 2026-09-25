/**
 * Font resolution: load the requested font, or the closest available substitute.
 *
 * Imported decks name fonts the user may not have (brand fonts). Rendering must not fail
 * because of that: we fall back to Inter with the same weight/style and report the
 * substitution, so the agent can tell the user which fonts to install.
 */

export interface FontRequest {
  family: string;
  style: string;
}

/** Alternative spellings of style names across foundries ("SemiBold" vs "Semi Bold"). */
const STYLE_ALIASES: Record<string, string[]> = {
  "Semi Bold": ["SemiBold", "Semibold", "Demi Bold", "DemiBold"],
  "Extra Bold": ["ExtraBold", "Extrabold", "Ultra Bold"],
  "Extra Light": ["ExtraLight", "Extralight", "Ultra Light"],
};

/**
 * Drop-in replacements with the same advance widths, so text keeps its line breaks. The
 * replacements are Google Fonts, which Figma always has.
 */
const METRIC_TWINS: Readonly<Record<string, readonly string[]>> = {
  arial: ["Arimo", "Liberation Sans"],
  helvetica: ["Arimo", "Liberation Sans"],
  "helvetica neue": ["Arimo"],
  calibri: ["Carlito"],
  cambria: ["Caladea"],
  "times new roman": ["Tinos", "Liberation Serif"],
  times: ["Tinos"],
  georgia: ["Gelasio"],
  "courier new": ["Cousine", "Liberation Mono"],
  courier: ["Cousine"],
};

/** When no twin is known: the closest kind of face, judged by the name. */
function kindFallback(family: string): string | undefined {
  const name = family.toLowerCase();
  if (/mono|code|courier|consol/.test(name)) return "Roboto Mono";
  if (/condensed|narrow|compressed/.test(name)) return "Roboto Condensed";
  if (
    !/sans/.test(name) &&
    /serif|times|garamond|georgia|minion|baskerville|caslon|palatino|antiqua|cambria/.test(name)
  )
    return "Noto Serif";
  return undefined;
}

/** Family name as the twin table spells it: lower case, without PostScript suffixes. */
function twinKey(family: string): string {
  return family
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s*(mt|ps|pro|std)$/, "")
    .trim();
}

/**
 * Candidate fonts to try, in order, for one request: the family itself (with style
 * spellings, then upright), a metric-compatible twin, a face of the same kind, then Inter.
 * Pure — unit-tested.
 */
export function fontCandidates(request: FontRequest, fallbackFamily = "Inter"): FontRequest[] {
  const styles = [request.style, ...(STYLE_ALIASES[request.style] ?? [])];
  const italic = /italic/i.test(request.style);
  const upright = request.style.replace(/\s*italic/i, "").trim() || "Regular";
  const withStyles = (family: string): FontRequest[] => [
    ...styles.map((style) => ({ family, style })),
    ...(italic ? [{ family, style: upright }] : []),
  ];
  const families = [
    request.family,
    ...(METRIC_TWINS[twinKey(request.family)] ?? []),
    ...[kindFallback(request.family)].filter((f): f is string => f !== undefined),
    fallbackFamily,
  ];
  const candidates = [
    ...families.flatMap(withStyles),
    { family: fallbackFamily, style: "Regular" },
  ];
  // De-duplicate while keeping order.
  const seen = new Set<string>();
  return candidates.filter((font) => {
    const key = `${font.family}\u0000${font.style}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Loads fonts once per plugin run and records substitutions. */
export class FontLoader {
  readonly #resolved = new Map<string, Promise<FontName>>();
  readonly substitutions = new Map<string, string>();

  constructor(private readonly load: (font: FontName) => Promise<void>) {}

  resolve(request: FontRequest): Promise<FontName> {
    const key = `${request.family}\u0000${request.style}`;
    let pending = this.#resolved.get(key);
    if (pending === undefined) {
      pending = this.#firstLoadable(request);
      this.#resolved.set(key, pending);
    }
    return pending;
  }

  async #firstLoadable(request: FontRequest): Promise<FontName> {
    for (const candidate of fontCandidates(request)) {
      try {
        await this.load(candidate);
        if (candidate.family !== request.family || candidate.style !== request.style) {
          this.substitutions.set(
            `${request.family} ${request.style}`,
            `${candidate.family} ${candidate.style}`,
          );
        }
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    throw new Error(
      `No usable font for ${request.family} ${request.style}; Inter Regular is also unavailable.`,
    );
  }
}
