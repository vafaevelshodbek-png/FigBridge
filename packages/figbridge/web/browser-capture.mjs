import { randomUUID } from "node:crypto";
import { captureDOM, prepareDOM } from "./capture-dom.mjs";
import {
  clearPseudoHosts,
  markPseudoHosts,
  pseudoGeometryFromSnapshot,
} from "./pseudo-capture.mjs";

/** Capture measured native layers and materialize resources in their authenticated frame. */
export async function capturePage(page, options = {}) {
  // Validate before touching frames, DOM or resource requests. Both byte checks
  // must remain finite: NaN would make every comparison in the stream false.
  for (const [key, minimum, maximum] of [
    ["timeoutMs", 1, 120000],
    ["maxAssets", 1, 1000],
    ["maxAssetBytes", 1, 64 * 1024 * 1024],
    ["maxTotalAssetBytes", 1, 256 * 1024 * 1024],
    ["maxScrollSteps", 0, 1000],
  ]) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum))
      throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  const { signal, timeoutMs = 15000, captureCdp = true } = options;
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw Error("Browser capture timeout");
  };
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("Browser capture timeout")), timeoutMs);
    abort = () => reject(signal.reason || Error("Capture aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  const run = async () => {
    const attribute = `data-figbridge-${randomUUID()}`;
    const handles = [];
    const mapping = new Map();
    const warnings = [];
    const assetCache = {};
    let remaining = options.maxTotalAssetBytes ?? 32 * 1024 * 1024;
    let assetCount = 0;
    const frames = page.frames();
    try {
      // Mark hosts in each parent realm, including hosts inside open shadow trees.
      for (const frame of frames.slice(1)) {
        check();
        try {
          const handle = await frame.frameElement();
          const id = String(handles.length);
          await handle.evaluate((el, { attribute, id }) => el.setAttribute(attribute, id), {
            attribute,
            id,
          });
          handles.push(handle);
          mapping.set(id, frame);
        } catch (error) {
          warnings.push(`iframe unavailable: ${error.message}`);
        }
      }
      const materialize = async (frame, urls) => {
        for (const url of urls) {
          check();
          if (assetCache[url]) continue;
          if (++assetCount > (options.maxAssets ?? 200)) {
            warnings.push("asset count budget exceeded");
            break;
          }
          const budget = Math.min(options.maxAssetBytes ?? 8 * 1024 * 1024, remaining);
          let result = await frame.evaluate(
            async ({ url, budget, timeout }) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeout);
              try {
                const response = await fetch(url, {
                  credentials: "include",
                  signal: controller.signal,
                });
                if (!response.ok) throw Error(`HTTP ${response.status}`);
                if (Number(response.headers.get("content-length")) > budget)
                  throw Error("asset byte budget exceeded");
                const reader = response.body.getReader();
                const chunks = [];
                let size = 0;
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > budget) throw Error("asset byte budget exceeded");
                    chunks.push(value);
                  }
                } finally {
                  await reader.cancel().catch(() => {});
                }
                const blob = new Blob(chunks, {
                  type: response.headers.get("content-type") || "application/octet-stream",
                });
                const data = await new Promise((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(r.result);
                  r.onerror = () => reject(Error("asset encoding failed"));
                  r.readAsDataURL(blob);
                });
                return { data, size };
              } catch (error) {
                return { error: error.message, publicFallback: error instanceof TypeError };
              } finally {
                clearTimeout(timer);
              }
            },
            { url, budget, timeout: Math.max(1, deadline - Date.now()) },
          );
          if (result.publicFallback && /^https?:/.test(url)) {
            check();
            // Anonymous public-resource fallback only. Do not copy browser cookies,
            // authorization or arbitrary request headers across this boundary.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
            const fallbackSignal = signal
              ? AbortSignal.any([signal, controller.signal])
              : controller.signal;
            let response;
            try {
              let next = new URL(url);
              const visited = new Set();
              for (let redirects = 0; ; redirects++) {
                check();
                if (!["http:", "https:"].includes(next.protocol) || next.username || next.password)
                  throw Error("public asset redirect requires anonymous HTTP(S) URL");
                next.hash = "";
                if (visited.has(next.href)) throw Error("public asset redirect loop");
                visited.add(next.href);
                response = await fetch(next, { redirect: "manual", signal: fallbackSignal });
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                const location = response.headers.get("location");
                await response.body?.cancel().catch(() => {});
                if (!location) throw Error("public asset redirect missing Location");
                if (redirects >= 5) throw Error("public asset redirect limit exceeded (5)");
                next = new URL(location, next);
              }
              if (!response.ok) throw Error(`HTTP ${response.status}`);
              if (Number(response.headers.get("content-length")) > budget)
                throw Error("asset byte budget exceeded");
              const reader = response.body.getReader();
              const chunks = [];
              let size = 0;
              try {
                while (true) {
                  check();
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.byteLength;
                  if (size > budget) throw Error("asset byte budget exceeded");
                  chunks.push(value);
                }
              } finally {
                await reader.cancel().catch(() => {});
              }
              result = {
                size,
                data: `data:${response.headers.get("content-type") || "application/octet-stream"};base64,${Buffer.concat(chunks, size).toString("base64")}`,
              };
            } catch (error) {
              check();
              result = {
                error: `browser fetch failed; anonymous public fallback: ${error.message}`,
              };
            } finally {
              clearTimeout(timer);
              if (response?.body && !response.body.locked)
                await response.body.cancel().catch(() => {});
            }
          }
          if (result.error)
            warnings.push(`asset unavailable ${url.slice(0, 160)}: ${result.error}`);
          else {
            assetCache[url] = result.data;
            remaining -= result.size;
          }
        }
      };
      const captureFrame = async (frame, main = false) => {
        check();
        const opts = {
          fullPage: main && options.fullPage,
          selector: main ? options.selector : undefined,
          name: options.name,
          maxScrollSteps: options.maxScrollSteps,
          timeoutMs: Math.max(1, deadline - Date.now()),
          frameAttribute: attribute,
        };
        const preparation = await frame.evaluate(prepareDOM, opts);
        check();
        let marked;
        let data;
        try {
          // Measure generated boxes in the same finished animation state as DOM extraction.
          await frame.evaluate(() => {
            for (const animation of document.getAnimations())
              try {
                if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
                else animation.pause();
              } catch {}
          });
          marked = await markPseudoHosts(frame, {
            selector: opts.selector,
            fullPage: Boolean(opts.fullPage),
          });
          if (marked.hosts.length) {
            let cdp;
            try {
              cdp = await page
                .context()
                .newCDPSession(frame)
                .catch(() => page.context().newCDPSession(page));
              const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
                computedStyles: [],
                includeDOMRects: true,
                includePaintOrder: true,
              });
              opts.pseudoGeometry = pseudoGeometryFromSnapshot(snapshot, marked.attribute);
              const urls = [
                ...new Set(
                  marked.hosts.flatMap((host) =>
                    host.backgroundUrls
                      .filter(({ pseudo, clip }) => {
                        const entry = opts.pseudoGeometry[host.key + pseudo];
                        if (!entry?.hasLayout) return false;
                        const [x, y, w, h] = entry.bounds;
                        return (
                          w > 0 &&
                          h > 0 &&
                          (!clip ||
                            (x + w > clip[0] && y + h > clip[1] && x < clip[2] && y < clip[3]))
                        );
                      })
                      .map((item) => item.url),
                  ),
                ),
              ];
              await materialize(frame, urls);
              for (const host of marked.hosts)
                for (const { pseudo, url } of host.backgroundUrls) {
                  const entry = opts.pseudoGeometry[host.key + pseudo];
                  const resource = assetCache[url];
                  if (
                    entry &&
                    resource?.startsWith("data:image/svg+xml") &&
                    resource.includes(";base64,")
                  )
                    entry.svg = Buffer.from(
                      resource.slice(resource.indexOf(",") + 1),
                      "base64",
                    ).toString("utf8");
                }
            } catch (error) {
              check();
              warnings.push(`pseudo geometry unavailable: ${error.message}`);
            } finally {
              await cdp?.detach().catch(() => {});
            }
          }
          check();
          data = await frame.evaluate(captureDOM, opts);
        } finally {
          if (marked) await clearPseudoHosts(frame, marked.attribute).catch(() => {});
        }
        warnings.push(...preparation.warnings, ...data.warnings);
        await materialize(frame, data.assets);
        const visit = async (node) => {
          if ("browserFrame" in node) {
            const child = mapping.get(node.browserFrame);
            delete node.browserFrame;
            if (!child) {
              warnings.push(`${node.id}: iframe unavailable`);
              return;
            }
            try {
              const geometry = await (await child.frameElement()).evaluate((el) => {
                const s = getComputedStyle(el);
                return {
                  x: el.clientLeft,
                  y: el.clientTop,
                  w: el.clientWidth,
                  h: el.clientHeight,
                  transform: s.transform,
                  zoom: s.zoom,
                };
              });
              if (geometry.transform !== "none" || Number(geometry.zoom) !== 1)
                warnings.push(`${node.id}: transformed iframe requires visual review`);
              const captured = await captureFrame(child);
              const prefix = (n) => {
                if (n.id) n.id = `${node.id}/document/${n.id}`;
                if (n.source?.startsWith("root")) n.source = `${node.id}/document/${n.source}`;
                n.children?.forEach(prefix);
              };
              captured.slide.children.forEach(prefix);
              node.children.push({
                type: "frame",
                id: `${node.id}/viewport`,
                name: "iframe viewport",
                x: geometry.x,
                y: geometry.y,
                w: geometry.w,
                h: geometry.h,
                clip: true,
                fills: captured.slide.background,
                children: captured.slide.children,
              });
            } catch (error) {
              check();
              warnings.push(`${node.id}: iframe capture failed: ${error.message}`);
            }
          } else for (const child of node.children || []) await visit(child);
        };
        for (const node of data.slide.children) await visit(node);
        return { ...data, preparation };
      };
      const data = await captureFrame(page.mainFrame(), true);
      let cdpSnapshot;
      if (captureCdp) {
        let cdp;
        try {
          check();
          cdp = await page.context().newCDPSession(page);
          cdpSnapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
            computedStyles: ["display", "visibility", "overflow", "clip-path"],
            includeDOMRects: true,
            includePaintOrder: true,
          });
        } catch (error) {
          check();
          warnings.push(`CDP snapshot unavailable: ${error.message}`);
        } finally {
          await cdp?.detach().catch(() => {});
        }
      }
      if (
        cdpSnapshot?.documents.some((document) =>
          document.nodes.shadowRootType?.value.some(
            (index) => cdpSnapshot.strings[index] === "closed",
          ),
        )
      )
        warnings.push("closed shadow DOM contents are unavailable to native capture");
      // With captureCdp:false, closed-shadow diagnostic coverage is unavailable.
      // DOMSnapshot includes raw inputValue and attribute strings. Remove password
      // strings before returning the optional diagnostic artifact.
      if (cdpSnapshot)
        for (const document of cdpSnapshot.documents) {
          const { nodes } = document;
          for (let i = 0; i < nodes.attributes.length; i++) {
            const attributes = nodes.attributes[i] || [];
            let password = false;
            for (let j = 0; j < attributes.length; j += 2)
              if (
                cdpSnapshot.strings[attributes[j]] === "type" &&
                cdpSnapshot.strings[attributes[j + 1]].toLowerCase() === "password"
              )
                password = true;
            if (!password) continue;
            const valueIndex = nodes.inputValue?.index.indexOf(i) ?? -1;
            if (valueIndex >= 0)
              cdpSnapshot.strings[nodes.inputValue.value[valueIndex]] = "[password redacted]";
            for (let j = 0; j < attributes.length; j += 2)
              if (cdpSnapshot.strings[attributes[j]] === "value")
                cdpSnapshot.strings[attributes[j + 1]] = "[password redacted]";
          }
        }
      check();
      return {
        ...data,
        warnings: [...new Set(warnings)],
        sourceWarnings: [...new Set(warnings)],
        assetCache,
        cdpSnapshot,
        browser: {
          url: page.url(),
          frameCount: frames.length,
          capturedAt: new Date().toISOString(),
        },
      };
    } finally {
      for (const handle of handles) {
        await handle
          .evaluate((el, attribute) => el.removeAttribute(attribute), attribute)
          .catch(() => {});
        await handle.dispose().catch(() => {});
      }
    }
  };
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
