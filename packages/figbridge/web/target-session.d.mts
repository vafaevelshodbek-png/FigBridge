export function resolveCaptureSession(
  client: { sessions(): Promise<Array<{ id: string; file: string }>> },
  file: string,
  session?: string,
): Promise<string>;
export function assertCaptureTarget(
  info: { file: string; access?: string; paused?: boolean },
  file: string,
  requireUnrestricted?: boolean,
): void;
