/**
 * EMF and WMF pictures → PNG through LibreOffice, when it is installed. Figma cannot show
 * Windows metafiles, and drawing them faithfully is a renderer of its own; LibreOffice has one.
 * All pictures of a deck go through one LibreOffice run, which is what makes this affordable.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Metafile } from "@figbridge/import-pptx";
import { stateDir } from "./config.js";

/** A whole batch must finish within this, or its pictures stay skipped. */
export const CONVERT_TIMEOUT_MS = 30_000;

const CANDIDATES: Record<string, readonly string[]> = {
  win32: [
    "C:/Program Files/LibreOffice/program/soffice.exe",
    "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  ],
  darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
  linux: ["/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice", "/snap/bin/libreoffice"],
};

/** Path of LibreOffice's `soffice`: $SOFFICE, then PATH, then the usual install folders. */
export function findSoffice(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env["SOFFICE"];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const names = process.platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir !== "" && existsSync(candidate)) return candidate;
    }
  }
  return (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
}

/**
 * Convert metafiles to PNG in one LibreOffice run. Returns PNG bytes by part name; pictures
 * LibreOffice could not convert are missing from the map.
 */
export async function convertMetafiles(
  soffice: string,
  pictures: readonly Metafile[],
  timeoutMs = CONVERT_TIMEOUT_MS,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (pictures.length === 0) return out;
  const dir = await mkdtemp(join(tmpdir(), "figbridge-metafile-"));
  try {
    const inputs = await Promise.all(
      pictures.map(async (picture, i) => {
        const file = join(dir, `p${String(i)}.${picture.format.toLowerCase()}`);
        await writeFile(file, picture.bytes);
        return file;
      }),
    );
    await run(
      soffice,
      [
        // Our own profile: works while the user has LibreOffice open and leaves theirs alone.
        // It is kept between imports because creating one costs LibreOffice several seconds.
        `-env:UserInstallation=${pathToFileURL(join(stateDir(), "libreoffice-profile")).href}`,
        "--headless",
        "--convert-to",
        "png",
        "--outdir",
        dir,
        ...inputs,
      ],
      timeoutMs,
    );
    await Promise.all(
      pictures.map(async (picture, i) => {
        try {
          out.set(picture.part, new Uint8Array(await readFile(join(dir, `p${String(i)}.png`))));
        } catch {
          // Not converted: the importer keeps its warning for this picture.
        }
      }),
    );
  } catch {
    // LibreOffice failed or timed out: every picture stays skipped with a warning.
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return out;
}

function run(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
      if (error === null) resolve();
      else reject(new Error("LibreOffice conversion failed", { cause: error }));
    });
  });
}
