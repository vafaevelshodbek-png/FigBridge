import type { Page } from "playwright";
import type { BrowserCapture } from "./browser-capture.mjs";
export interface BrowserAction {
  action: "click" | "hover" | "fill" | "select" | "press" | "scroll" | "wait";
  selector?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  key?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  ms?: number | undefined;
}
export type BrowserRecipe = BrowserAction[];
export interface Exploration {
  states: {
    id: string;
    index: number;
    url: string;
    recipe: BrowserRecipe;
    fingerprint: string;
    result?: unknown;
  }[];
  edges: { from: string; to?: string; action: BrowserAction; status: string; reason?: string }[];
  coverage: {
    actions: number;
    counts: Record<string, number>;
    limited: boolean;
    exhaustive: false;
  };
  scope: unknown;
}
export interface ExplorerOptions {
  url: string;
  maxStates?: number;
  maxDepth?: number;
  maxActions?: number;
  maxScrollSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  capture: (page: Page) => Promise<BrowserCapture>;
  onState?: (data: BrowserCapture, state: Exploration["states"][number]) => Promise<unknown>;
  recipes?: { name: string; steps: BrowserRecipe }[] | undefined;
}
export function explorePage(page: Page, options: ExplorerOptions): Promise<Exploration>;
