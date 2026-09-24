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

/** Candidate fonts to try, in order, for one request. Pure — unit-tested. */
export function fontCandidates(request: FontRequest, fallbackFamily = "Inter"): FontRequest[] {
  const styles = [request.style, ...(STYLE_ALIASES[request.style] ?? [])];
  const italic = /italic/i.test(request.style);
  const upright = request.style.replace(/\s*italic/i, "").trim() || "Regular";
  const candidates: FontRequest[] = styles.map((style) => ({ family: request.family, style }));
  if (italic) candidates.push({ family: request.family, style: upright });
  candidates.push({ family: fallbackFamily, style: request.style });
  if (italic) candidates.push({ family: fallbackFamily, style: upright });
  candidates.push({ family: fallbackFamily, style: "Regular" });
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
