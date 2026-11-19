import { randomUUID } from "node:crypto";

/** Mark composed-tree hosts with their capture source path. Call after preparation. */
export async function markPseudoHosts(
  frame,
  { selector, fullPage = false, attribute = `data-figbridge-pseudo-${randomUUID()}` } = {},
) {
  const hosts = await frame.evaluate(
    ({ selector, fullPage, attribute }) => {
      const root = document.querySelector(selector || "body");
      if (!root) throw Error("Capture root not found");
      const hosts = [];
      const parent = (el) =>
        el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
      const walk = (el, key) => {
        const style = getComputedStyle(el);
        if (style.display === "none" || Number(style.opacity) === 0) return;
        const backgroundUrls = [];
        let present = false;
        for (const pseudo of ["::before", "::after"]) {
          const s = getComputedStyle(el, pseudo);
          if (
            s.content === "none" ||
            s.content === "normal" ||
            s.display === "none" ||
            s.visibility !== "visible" ||
            Number(s.opacity) === 0
          )
            continue;
          present = true;
          const rootRect = root.getBoundingClientRect();
          const clip = selector
            ? [
                rootRect.left + scrollX,
                rootRect.top + scrollY,
                rootRect.right + scrollX,
                rootRect.bottom + scrollY,
              ]
            : fullPage
              ? [
                  0,
                  0,
                  Math.max(innerWidth, document.documentElement.scrollWidth),
                  Math.max(innerHeight, document.documentElement.scrollHeight),
                ]
              : [scrollX, scrollY, scrollX + innerWidth, scrollY + innerHeight];
          let escapes = s.position === "fixed";
          for (let ancestor = el; ancestor; ancestor = parent(ancestor)) {
            const a = getComputedStyle(ancestor),
              rect = ancestor.getBoundingClientRect();
            if (a.display === "none" || Number(a.opacity) === 0) {
              clip[2] = clip[0];
              break;
            }
            if (
              a.transform !== "none" ||
              a.filter !== "none" ||
              a.perspective !== "none" ||
              /paint|layout|strict|content/.test(a.contain)
            )
              escapes = false;
            if (!escapes) {
              if (/hidden|clip|scroll|auto/.test(a.overflowX)) {
                clip[0] = Math.max(clip[0], rect.left + scrollX + ancestor.clientLeft);
                clip[2] = Math.min(
                  clip[2],
                  rect.left + scrollX + ancestor.clientLeft + ancestor.clientWidth,
                );
              }
              if (/hidden|clip|scroll|auto/.test(a.overflowY)) {
                clip[1] = Math.max(clip[1], rect.top + scrollY + ancestor.clientTop);
                clip[3] = Math.min(
                  clip[3],
                  rect.top + scrollY + ancestor.clientTop + ancestor.clientHeight,
                );
              }
            }
          }
          for (const match of s.backgroundImage.matchAll(
            /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/g,
          ))
            backgroundUrls.push({ pseudo, url: match[1] ?? match[2] ?? match[3].trim(), clip });
        }
        if (present) {
          el.setAttribute(attribute, key);
          hosts.push({ key, backgroundUrls });
        }
        const children =
          el.tagName === "SLOT"
            ? el.assignedNodes().length
              ? el.assignedNodes()
              : [...el.childNodes]
            : [...(el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)];
        children.forEach((child, i) => {
          if (child.nodeType === 1) walk(child, `${key}/${i}`);
        });
      };
      walk(root, "root");
      return hosts;
    },
    { selector, fullPage, attribute },
  );
  return { attribute, hosts };
}

/** Decode measured border boxes. A unique attribute separates frames in a snapshot. */
export function pseudoGeometryFromSnapshot(snapshot, attribute) {
  const result = {};
  const str = (i) => snapshot.strings[i];
  for (const doc of snapshot.documents) {
    const { nodes, layout } = doc,
      hosts = new Map();
    for (let i = 0; i < nodes.attributes.length; i++) {
      const attrs = nodes.attributes[i];
      for (let j = 0; j < attrs.length; j += 2)
        if (str(attrs[j]) === attribute) hosts.set(i, str(attrs[j + 1]));
    }
    // A pseudo can also own anonymous inline/text fragments with the same nodeIndex.
    // Chromium lists its outer border box first, followed by those fragments.
    const layoutByNode = new Map();
    layout.nodeIndex.forEach((n, i) => {
      if (!layoutByNode.has(n)) layoutByNode.set(n, i);
    });
    for (let i = 0; i < (nodes.pseudoType?.index.length ?? 0); i++) {
      const ni = nodes.pseudoType.index[i],
        key = hosts.get(nodes.parentIndex[ni]),
        pseudo = str(nodes.pseudoType.value[i]);
      if (!key || !["before", "after"].includes(pseudo)) continue;
      const li = layoutByNode.get(ni),
        bounds = li === undefined ? [0, 0, 0, 0] : layout.bounds[li];
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) continue;
      result[`${key}::${pseudo}`] = { bounds, hasLayout: li !== undefined };
    }
  }
  return result;
}

export async function clearPseudoHosts(frame, attribute) {
  await frame.evaluate((attribute) => {
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        el.removeAttribute(attribute);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
  }, attribute);
}
