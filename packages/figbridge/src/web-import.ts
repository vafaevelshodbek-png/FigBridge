/** Browser capture, bounded state discovery and sequential native Figma import. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeError } from "@figbridge/protocol";
import { type Browser, chromium } from "playwright";
import { z } from "zod";
import { type BrowserCapture, capturePage } from "../web/browser-capture.mjs";
import {
  type BrowserAction,
  type BrowserRecipe,
  type Exploration,
  explorePage,
} from "../web/explore.mjs";
import { type CaptureImportResult, importCaptureData } from "../web/import-capture.mjs";
import type { HubClient, InvokeOptions } from "./client.js";

const WebUrl = z
  .url()
  .trim()
  .refine(
    (v) => ["http:", "https:", "file:"].includes(new URL(v).protocol),
    "Use an http, https or file URL",
  );
const Action = z.object({
  action: z.enum(["click", "hover", "fill", "select", "press", "scroll", "wait"]),
  selector: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  ms: z.number().int().min(0).max(30_000).optional(),
});
export const WebCaptureInputSchema = z.object({
  url: WebUrl,
  outDir: z.string().min(1),
  width: z.number().int().min(100).max(10_000).default(1440),
  height: z.number().int().min(100).max(10_000).default(900),
  fullPage: z.boolean().default(true),
  selector: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  locale: z.string().optional(),
  storageState: z.string().min(1).optional(),
  cdpUrl: z.url().optional(),
  channel: z.enum(["chromium", "chrome", "msedge"]).optional(),
  executablePath: z.string().optional(),
  captureCdp: z.boolean().default(true),
  explore: z.boolean().default(false),
  maxStates: z.number().int().min(1).max(200).default(20),
  maxDepth: z.number().int().min(0).max(20).default(3),
  maxActions: z.number().int().min(1).max(2000).default(80),
  maxScrollSteps: z.number().int().min(0).max(100).default(10),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  maxDurationMs: z.number().int().min(100).max(900_000).default(180_000),
  recipes: z
    .array(z.object({ name: z.string(), steps: z.array(Action).max(100) }))
    .max(100)
    .optional(),
});
export const WebImportInputSchema = WebCaptureInputSchema.extend({
  file: z.string().min(1),
  session: z.string().optional(),
  pageId: z.string().optional(),
  strict: z.boolean().default(false),
  x: z.number().optional(),
  y: z.number().optional(),
  columns: z.number().int().min(1).max(20).default(3),
  gap: z.number().min(0).max(1000).default(80),
});
export type WebCaptureInput = z.input<typeof WebCaptureInputSchema>;
export type WebImportInput = z.input<typeof WebImportInputSchema>;
export interface WebState {
  id: string;
  index: number;
  url: string;
  name: string;
  capturePath: string;
  referencePath: string;
  cdpPath?: string;
  width: number;
  height: number;
  warnings: string[];
  recipe: BrowserRecipe;
  figma?: CaptureImportResult;
}
export interface WebCaptureResult {
  jobId: string;
  status: "captured" | "imported" | "failed";
  url: string;
  outDir: string;
  manifestPath: string;
  states: WebState[];
  coverage: Exploration["coverage"];
  edges: Exploration["edges"];
  scope: Record<string, unknown>;
  error?: string;
}
interface RunOptions {
  signal?: AbortSignal | undefined;
  progress?: ((done: number, total?: number) => void) | undefined;
}

function publicAction(action: BrowserAction): BrowserAction {
  return action.action === "fill"
    ? { ...action, value: "[redacted: supply input to replay]" }
    : { ...action };
}

export async function captureWebsite(
  raw: WebCaptureInput,
  options: RunOptions = {},
): Promise<WebCaptureResult> {
  const input = WebCaptureInputSchema.parse(raw);
  if (input.cdpUrl && input.storageState) throw new Error("Use cdpUrl or storageState, not both");
  options.signal?.throwIfAborted();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(input.maxDurationMs)])
    : AbortSignal.timeout(input.maxDurationMs);
  const outDir = resolve(input.outDir);
  await mkdir(outDir, { recursive: true });
  const lockPath = join(outDir, ".web-capture.lock");
  const lock = await open(lockPath, "wx").catch(() => {
    throw new Error("The output directory is in use; choose an empty directory");
  });
  try {
    if ((await readdir(outDir)).some((entry) => entry !== ".web-capture.lock"))
      throw new Error("The output directory contains files; choose an empty directory");
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  const result: WebCaptureResult = {
    jobId: randomUUID(),
    status: "captured",
    url: input.url,
    outDir,
    manifestPath: join(outDir, "manifest.json"),
    states: [],
    edges: [],
    scope: {
      origin: new URL(input.url).origin,
      width: input.width,
      height: input.height,
      fullPage: input.fullPage,
      selector: input.selector,
      colorScheme: input.colorScheme,
      locale: input.locale,
      maxStates: input.maxStates,
      maxDepth: input.maxDepth,
      maxActions: input.maxActions,
      maxScrollSteps: input.maxScrollSteps,
      timeoutMs: input.timeoutMs,
      maxDurationMs: input.maxDurationMs,
      exploration: input.explore || Boolean(input.recipes?.length),
      authenticatedStateProvided: Boolean(input.storageState),
      cdpAttached: Boolean(input.cdpUrl),
    },
    coverage: {
      actions: 0,
      counts: { captured: 0, duplicate: 0, blocked: 0, failed: 0, pending: 0 },
      limited: false,
      exhaustive: false,
    },
  };
  let manifestOwned = false;
  const persist = async () => {
    await writeFile(result.manifestPath, JSON.stringify(result, null, 2), {
      flag: manifestOwned ? "w" : "wx",
    });
    manifestOwned = true;
  };
  let browser: Browser | undefined;
  let closePage: (() => Promise<void>) | undefined;
  const abort = () => {
    void closePage?.().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    browser = input.cdpUrl
      ? await chromium.connectOverCDP(input.cdpUrl, { timeout: input.timeoutMs })
      : await chromium.launch({
          headless: true,
          ...(input.channel ? { channel: input.channel } : {}),
          ...(input.executablePath ? { executablePath: input.executablePath } : {}),
        });
    signal.throwIfAborted();
    const context = input.cdpUrl
      ? browser.contexts()[0]
      : await browser.newContext({
          viewport: { width: input.width, height: input.height },
          deviceScaleFactor: 1,
          colorScheme: input.colorScheme,
          ...(input.locale ? { locale: input.locale } : {}),
          ...(input.storageState ? { storageState: resolve(input.storageState) } : {}),
        });
    if (!context) throw new Error("The CDP browser has no context");
    const page = await context.newPage();
    closePage = () => page.close();
    page.setDefaultTimeout(input.timeoutMs);
    await page.setViewportSize({ width: input.width, height: input.height });
    signal.throwIfAborted();
    const capture = async () => {
      if (input.selector) await page.locator(input.selector).first().scrollIntoViewIfNeeded();
      return capturePage(page, {
        fullPage: input.fullPage,
        selector: input.selector,
        name: input.name,
        maxScrollSteps: input.maxScrollSteps,
        timeoutMs: input.timeoutMs,
        captureCdp: input.captureCdp,
        signal,
      });
    };
    const save = async (
      data: BrowserCapture,
      state: { id: string; index: number; url: string; recipe: BrowserRecipe },
    ) => {
      signal.throwIfAborted();
      const stem = String(state.index + 1).padStart(3, "0");
      const capturePath = join(outDir, `${stem}.capture.json`);
      const referencePath = join(outDir, `${stem}.reference.png`);
      const { cdpSnapshot, ...captureData } = data;
      captureData.slide.name ||= input.name || `Web screen ${state.index + 1}`;
      const cdpPath = cdpSnapshot ? join(outDir, `${stem}.cdp.json`) : undefined;
      let reference: Buffer;
      if (input.selector) {
        const box = await page.locator(input.selector).first().boundingBox();
        if (!box) throw new Error("Capture element is not visible");
        const scroll = await page.evaluate<{ x: number; y: number }>("({x:scrollX,y:scrollY})");
        // Locator screenshots expand fractional bounds; explicit dimensions keep the
        // reference on the same CSS-pixel canvas as the captured Scene.
        reference = await page.screenshot({
          scale: "css",
          animations: "disabled",
          clip: {
            x: box.x + scroll.x,
            y: box.y + scroll.y,
            width: data.slide.width,
            height: data.slide.height,
          },
        });
      } else
        reference = await page.screenshot({
          fullPage: input.fullPage,
          scale: "css",
          animations: "disabled",
        });
      await writeFile(referencePath, reference, { flag: "wx" });
      await writeFile(capturePath, JSON.stringify(captureData, null, 2), { flag: "wx" });
      if (cdpPath) await writeFile(cdpPath, JSON.stringify(cdpSnapshot), { flag: "wx" });
      const item: WebState = {
        ...state,
        recipe: state.recipe.map(publicAction),
        name: data.slide.name || `Web screen ${state.index + 1}`,
        capturePath,
        referencePath,
        width: data.slide.width,
        height: data.slide.height,
        warnings: [...new Set(data.warnings)],
        ...(cdpPath ? { cdpPath } : {}),
      };
      result.states.push(item);
      options.progress?.(result.states.length);
      await persist();
      return { capturePath, referencePath };
    };
    if (input.explore || input.recipes?.length) {
      const graph = await explorePage(page, {
        url: input.url,
        maxStates: input.maxStates,
        maxDepth: input.maxDepth,
        maxActions: input.maxActions,
        maxScrollSteps: input.maxScrollSteps,
        timeoutMs: input.timeoutMs,
        signal,
        capture,
        onState: save,
        recipes: input.recipes,
      });
      result.edges = graph.edges.map((edge) => ({ ...edge, action: publicAction(edge.action) }));
      result.coverage = graph.coverage;
    } else {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      await save(await capture(), { id: "state-0", index: 0, url: page.url(), recipe: [] });
      result.coverage.counts["captured"] = 1;
    }
    signal.throwIfAborted();
    await persist();
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = signal.aborted ? String(signal.reason) : String(error);
    await persist();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await closePage?.().catch(() => {});
    await browser?.close().catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

/** Exact destination is checked before browser work, and rechecked by every import. */
export async function importWebsite(
  client: HubClient,
  raw: WebImportInput,
  options: RunOptions = {},
): Promise<WebCaptureResult> {
  const input = WebImportInputSchema.parse(raw);
  const session = await resolveWebTarget(client, input.file, input.session, options);
  const result = await captureWebsite(input, options);
  try {
    const captures: BrowserCapture[] = [];
    for (const state of result.states) {
      const data = JSON.parse(await readFile(state.capturePath, "utf8")) as BrowserCapture;
      if (input.strict && (data.warnings.length || data.preparation?.warnings.length))
        throw new Error(
          `Source capture has losses: ${[...data.warnings, ...(data.preparation?.warnings ?? [])].join("; ")}`,
        );
      captures.push(data);
    }
    let bottom = 0;
    let cursor: string | undefined;
    do {
      const outline = await client.call(
        "document.outline",
        {
          depth: 0,
          limit: 500,
          ...(input.pageId ? { rootId: input.pageId } : {}),
          ...(cursor ? { cursor } : {}),
        },
        { session, signal: options.signal },
      );
      bottom = Math.max(bottom, ...outline.nodes.map((n) => (n.box?.y ?? 0) + (n.box?.h ?? 0)));
      cursor = outline.nextCursor;
    } while (cursor);
    const originY = input.y ?? (bottom ? bottom + input.gap : 0);
    const cellWidth = Math.max(1, ...result.states.map((s) => s.width));
    let rowY = originY;
    let rowHeight = 0;
    for (const [index, data] of captures.entries()) {
      options.signal?.throwIfAborted();
      const state = result.states[index];
      if (!state) continue;
      if (index && index % input.columns === 0) {
        rowY += rowHeight + input.gap;
        rowHeight = 0;
      }
      state.figma = await importCaptureData(data, {
        client,
        file: input.file,
        session,
        pageId: input.pageId,
        strict: input.strict,
        requireUnrestricted: true,
        signal: options.signal,
        key: `web:${result.jobId}:${state.id}`,
        x: (input.x ?? 0) + (index % input.columns) * (cellWidth + input.gap),
        y: rowY,
      });
      rowHeight = Math.max(rowHeight, state.height);
      await writeFile(result.manifestPath, JSON.stringify(result, null, 2));
      options.progress?.(index + 1, captures.length);
    }
    result.status = "imported";
  } catch (error) {
    result.status = "failed";
    result.error = String(error);
    throw error;
  } finally {
    await writeFile(result.manifestPath, JSON.stringify(result, null, 2));
  }
  return result;
}

async function resolveWebTarget(
  client: HubClient,
  file: string,
  requested: string | undefined,
  options: InvokeOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  let session = requested;
  if (!session) {
    const matches = (await client.sessions()).filter((s) => s.file === file);
    if (matches.length !== 1)
      throw new BridgeError(
        "NO_SESSION",
        `Expected exactly one connected ${file} session; supply its session id`,
      );
    session = matches[0]?.id;
  }
  if (!session) throw new BridgeError("NO_SESSION", "No matching session");
  const info = await client.call("session.info", {}, { session, signal: options.signal });
  if (info.file !== file || info.paused || info.access !== "unrestricted")
    throw new BridgeError(
      "VALIDATION",
      `Expected unrestricted, active file ${file}; connected to ${info.file}`,
    );
  return session;
}
