import type { Page } from "playwright";
export interface BrowserCapture {
  slide: { name: string; width: number; height: number; children: unknown[] };
  warnings: string[];
  sourceWarnings?: string[];
  assetCache?: Record<string, string>;
  preparation?: { warnings: string[] };
  cdpSnapshot?: unknown;
  [key: string]: unknown;
}
export interface BrowserCaptureOptions {
  maxAssets?: number;
  maxAssetBytes?: number;
  maxTotalAssetBytes?: number;
  fullPage?: boolean | undefined;
  selector?: string | undefined;
  name?: string | undefined;
  maxScrollSteps?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  captureCdp?: boolean | undefined;
}
export function capturePage(page: Page, options?: BrowserCaptureOptions): Promise<BrowserCapture>;
