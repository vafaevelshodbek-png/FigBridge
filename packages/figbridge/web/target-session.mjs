/** Resolve only an unambiguous expected file; never fall through to another active tab. */
export async function resolveCaptureSession(client, file, session) {
  if (session) return session;
  const matches = (await client.sessions()).filter((s) => s.file === file);
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one connected ${file} session, found ${matches.length}; supply its session id explicitly`,
    );
  return matches[0].id;
}
export function assertCaptureTarget(info, file, requireUnrestricted = false) {
  if (info.file !== file) throw new Error(`Expected ${file}, connected to ${info.file}`);
  if (requireUnrestricted && (info.access !== "unrestricted" || info.paused))
    throw new Error(
      "Batch import stopped: Unrestricted access is required and the plugin must not be paused",
    );
}
