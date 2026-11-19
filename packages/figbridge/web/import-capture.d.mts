export interface CaptureClient {
  sessions(): Promise<{ id: string; file: string }[]>;
  invoke(
    method: "session.info" | "scene.render",
    params: unknown,
    options?: {
      session?: string | undefined;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    },
  ): Promise<unknown>;
  putBlob(bytes: Uint8Array, mimeType: string): Promise<string>;
}

export interface ImportCaptureOptions {
  key?: string | undefined;
  pageId?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  file: string;
  session?: string | undefined;
  strict?: boolean | undefined;
  originalSize?: boolean | undefined;
  staticAssetOrigin?: string | undefined;
  requireUnrestricted?: boolean | undefined;
  client?: CaptureClient | undefined;
  signal?: AbortSignal | undefined;
}
export interface CaptureImportResult {
  frameId: string;
  created: number;
  warnings: string[];
  sourceWarnings: string[];
  session: string;
  key: string;
  sourceCapture?: string;
}
export function importCapture(
  path: string,
  options: ImportCaptureOptions,
): Promise<CaptureImportResult>;
export function importCaptureData(
  data: unknown,
  options: ImportCaptureOptions,
): Promise<CaptureImportResult>;
