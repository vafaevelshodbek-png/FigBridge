/** Prepare lazy content before measurement. Pass to page.evaluate, then call captureDOM. */
export async function prepareDOM(options = {}) {
  if (
    options.maxScrollSteps !== undefined &&
    (!Number.isSafeInteger(options.maxScrollSteps) ||
      options.maxScrollSteps < 0 ||
      options.maxScrollSteps > 1000)
  )
    throw new RangeError("maxScrollSteps must be an integer between 0 and 1000");

  const warnings = [],
    timeoutMs = options.timeoutMs || 10000;
  const root = document.querySelector(options.selector || "body");
  if (!root) throw new Error("Capture root not found");
  const start = { x: scrollX, y: scrollY };
  const settle = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const bounded = async (promise, label) => {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("timeout")), timeoutMs);
        }),
      ]);
    } catch {
      warnings.push(`${label}: content was not ready before capture`);
    } finally {
      clearTimeout(timer);
    }
  };
  await bounded(document.fonts.ready, "fonts");
  const images = [...root.querySelectorAll("img")];
  const loading = images.map((image) => image.getAttribute("loading"));
  try {
    images.forEach((image) => {
      image.loading = "eager";
    });
    if (options.fullPage) {
      const limit = options.maxScrollSteps ?? 100;
      for (let step = 0; step < limit; step++) {
        const top = Math.min(
          step * innerHeight,
          document.documentElement.scrollHeight - innerHeight,
        );
        window.scrollTo({ left: 0, top: Math.max(0, top), behavior: "instant" });
        await settle();
        if (top + innerHeight >= document.documentElement.scrollHeight - 1) break;
        if (step === limit - 1) warnings.push("full page: lazy-content scroll limit reached");
      }
    }
    await Promise.all(
      images.map((image) => bounded(image.decode(), image.currentSrc || image.src || "image")),
    );
    await Promise.all(
      [...root.querySelectorAll("video")].map(async (video) => {
        if (!video.currentSrc && !video.src && !video.querySelector("source")) return;
        if (video.readyState < 2) {
          const ready = new Promise((resolve, reject) => {
            video.addEventListener("loadeddata", resolve, { once: true });
            video.addEventListener("error", reject, { once: true });
          });
          video.preload = "auto";
          video.load();
          await bounded(ready, video.currentSrc || video.src || "video");
        }
        if (options.pauseVideos !== false) video.pause();
        if (
          Number.isFinite(options.videoTime) &&
          video.readyState >= 2 &&
          Math.abs(video.currentTime - options.videoTime) > 0.001
        ) {
          const seeked = new Promise((resolve) =>
            video.addEventListener("seeked", resolve, { once: true }),
          );
          video.currentTime = options.videoTime;
          await bounded(seeked, "video seek");
        }
      }),
    );
  } finally {
    images.forEach((image, i) => {
      if (loading[i] === null) image.removeAttribute("loading");
      else image.setAttribute("loading", loading[i]);
    });
    window.scrollTo({ left: start.x, top: start.y, behavior: "instant" });
    await settle();
  }
  return { warnings, images: images.length, scrollRestored: { x: scrollX, y: scrollY } };
}

/** Browser-side capture. Pass this function to page.evaluate; no framework or Node dependency. */
export function captureDOM(options = {}) {
  // Keep measured DOM and the following screenshot in the same animation state.
  // Otherwise finite entry transitions can finish between the two operations.
  if (options.stabilize !== false)
    for (const animation of document.getAnimations()) {
      try {
        if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
        else animation.pause();
      } catch {}
    }
  const root = document.querySelector(options.selector || "body");
  if (!root) throw new Error("Capture root not found");
  const origin = options.selector
    ? root.getBoundingClientRect()
    : options.fullPage
      ? { x: -scrollX, y: -scrollY }
      : { x: 0, y: 0 };
  const warnings = [];
  const assets = new Set();
  const filteredAssets = new Map();
  const fontFamilies = new Map();
  const number = (v) => Number.parseFloat(v) || 0;
  const round = (v) => Math.round(v * 1000) / 1000;
  function color(v) {
    if (!v || v === "transparent" || v === "none") return null;
    const c = document.createElement("canvas").getContext("2d");
    c.fillStyle = v;
    c.fillRect(0, 0, 1, 1);
    const a = c.getImageData(0, 0, 1, 1).data;
    if (!a[3]) return null;
    return {
      type: "solid",
      color:
        "#" +
        [...a]
          .slice(0, 3)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join(""),
      opacity: a[3] / 255,
    };
  }
  function objectPaint(s, box, width, height) {
    const fit = s.objectFit || "fill";
    // CSS fill stretches both axes; native FILL instead preserves aspect ratio.
    if (fit === "fill") return { scaleMode: "crop", crop: { x: 0, y: 0, w: 1, h: 1 } };
    const positions = s.objectPosition.split(/\s+/);
    const position = (value) =>
      value?.endsWith("%")
        ? number(value) / 100
        : { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }[value];
    const x = position(positions[0]),
      y = position(positions[1] || "50%");
    const positioned = x !== undefined && y !== undefined && x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (
      fit === "contain" ||
      (fit === "scale-down" &&
        width &&
        height &&
        Math.min(box.width / width, box.height / height) < 1)
    ) {
      if (x !== 0.5 || y !== 0.5)
        warnings.push("CSS object-position for contained image requires review");
      return { scaleMode: "fit" };
    }
    if (["cover", "none", "scale-down"].includes(fit) && width && height) {
      const scale = fit === "cover" ? Math.max(box.width / width, box.height / height) : 1;
      const w = box.width / (width * scale),
        h = box.height / (height * scale);
      if (w <= 1 && h <= 1 && positioned)
        return { scaleMode: "crop", crop: { x: (1 - w) * x, y: (1 - h) * y, w, h } };
      if (!positioned)
        warnings.push(
          "CSS object-position with pixel offsets or out-of-range percentages requires review",
        );
      if (w > 1 || h > 1)
        warnings.push(`CSS object-fit: ${fit} with unscaled blank margins requires review`);
    } else warnings.push(`CSS object-fit: ${fit} without intrinsic dimensions requires review`);
    return { scaleMode: fit === "cover" ? "fill" : "fit" };
  }
  function parts(value) {
    const out = [];
    let depth = 0,
      start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "(") depth++;
      if (value[i] === ")") depth--;
      if (value[i] === "," && !depth) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(value.slice(start).trim());
    return out;
  }
  function stopColor(value) {
    const paint = color(value);
    if (paint) return paint;
    // Keep the RGB of zero-alpha stops: Figma interpolates their RGB as well as alpha.
    const opaque = value
      .replace(/,\s*0(?:\.0+)?\s*\)$/, ", 1)")
      .replace(/\/\s*0(?:\.0+)?\s*\)$/, "/ 1)");
    return { type: "solid", color: color(opaque)?.color || "#000000", opacity: 0 };
  }
  function paints(s, w, h, key) {
    const out = [];
    const bg = color(s.backgroundColor);
    if (bg) out.push(bg);
    for (const image of parts(s.backgroundImage || "none").reverse()) {
      const u = image.match(/^url\(["']?(.*?)["']?\)$/);
      if (u) {
        const url = new URL(u[1], location.href).href;
        assets.add(url);
        out.push({
          type: "image",
          url,
          scaleMode: s.backgroundSize === "contain" ? "fit" : "fill",
          opacity: 1,
        });
        continue;
      }
      const g = image.match(/^(repeating-)?linear-gradient\((.*)\)$/);
      if (g) {
        const items = parts(g[2]);
        let angle = 180;
        if (!/^(#|rgb|hsl|oklch|color|transparent)/.test(items[0])) {
          const dir = items.shift();
          angle = dir.includes("deg")
            ? number(dir)
            : ({
                "to top": 0,
                "to right": 90,
                "to bottom": 180,
                "to left": 270,
                "to bottom right": 135,
                "to top right": 45,
              }[dir] ?? 180);
        }
        const a = (angle * Math.PI) / 180,
          dx = Math.sin(a),
          dy = -Math.cos(a),
          l = Math.abs(w * dx) + Math.abs(h * dy);
        let stops = items.map((v, i) => {
          const m = v.match(/^(.*?)(?:\s+(-?[\d.]+)(%|px))?$/);
          const c = stopColor(m[1]);
          return {
            color: c.color,
            opacity: c.opacity,
            position: m[2] ? number(m[2]) / (m[3] === "%" ? 100 : l) : i / (items.length - 1),
          };
        });
        if (g[1]) {
          const period = stops.at(-1).position - stops[0].position,
            tiled = [];
          if (period > 0 && stops.length / period < 4000) {
            for (
              let k = Math.floor(-stops[0].position / period) - 1;
              k <= Math.ceil((1 - stops[0].position) / period) + 1;
              k++
            )
              for (const stop of stops)
                tiled.push({ ...stop, position: stop.position + k * period });
            tiled.sort((a, b) => a.position - b.position);
            const boundary = (position) => {
              let i = tiled.findIndex((s) => s.position >= position);
              if (i < 1) i = 1;
              const x = tiled[i - 1],
                y = tiled[i],
                t = (position - x.position) / (y.position - x.position || 1),
                opacity = x.opacity + (y.opacity - x.opacity) * t;
              const channels = (c) => c.match(/\w\w/g).map((v) => parseInt(v, 16));
              const p = channels(x.color),
                q = channels(y.color);
              const color =
                "#" +
                p
                  .map((v, j) =>
                    Math.round(
                      opacity ? (v * x.opacity * (1 - t) + q[j] * y.opacity * t) / opacity : v,
                    )
                      .toString(16)
                      .padStart(2, "0"),
                  )
                  .join("");
              return { position, color, opacity };
            };
            stops = [
              boundary(0),
              ...tiled.filter((s) => s.position > 0 && s.position < 1),
              boundary(1),
            ];
          } else warnings.push(`${key}: repeating gradient exceeds the editable stop budget`);
        } else stops = stops.map((s) => ({ ...s, position: Math.max(0, Math.min(1, s.position)) }));
        if (stops.length > 1) {
          out.push({
            type: "linear-gradient",
            from: [0.5 - (dx * l) / (2 * w), 0.5 - (dy * l) / (2 * h)],
            to: [0.5 + (dx * l) / (2 * w), 0.5 + (dy * l) / (2 * h)],
            stops,
            opacity: 1,
          });
        }
      } else if (image.startsWith("radial-gradient(")) {
        const items = parts(image.slice(16, -1));
        let spec = "ellipse farthest-corner at 50% 50%";
        if (!/^(#|rgb|hsl|oklch|color|transparent)/.test(items[0])) spec = items.shift();
        const [shape, centerSpec = "50% 50%"] = spec.split(/\s+at\s+/);
        const coords = centerSpec.trim().split(/\s+/);
        const pos = (v, span) =>
          v?.includes("%")
            ? number(v) / 100
            : v === "center"
              ? 0.5
              : v === "right" || v === "bottom"
                ? 1
                : number(v) / span;
        const cx = pos(coords[0], w),
          cy = pos(coords[1] || "50%", h);
        let rx, ry;
        const sizes = shape
          .replace(/circle|ellipse/, "")
          .trim()
          .split(/\s+/);
        if (/^[-\d.]/.test(sizes[0])) {
          rx = sizes[0].includes("%") ? number(sizes[0]) / 100 : number(sizes[0]) / w;
          ry = sizes[1]
            ? sizes[1].includes("%")
              ? number(sizes[1]) / 100
              : number(sizes[1]) / h
            : (rx * w) / h;
        } else {
          const close = shape.includes("closest");
          const dx = (close ? Math.min : Math.max)(cx, 1 - cx) * w,
            dy = (close ? Math.min : Math.max)(cy, 1 - cy) * h;
          if (shape.includes("circle")) {
            const r = shape.includes("side")
              ? (close ? Math.min : Math.max)(dx, dy)
              : Math.hypot(dx, dy);
            rx = r / w;
            ry = r / h;
          } else {
            const k = shape.includes("side") ? 1 : Math.SQRT2;
            rx = (dx * k) / w;
            ry = (dy * k) / h;
          }
        }
        const stops = items.map((v, i) => {
          const m = v.match(/^(.*?)(?:\s+(-?[\d.]+)(%|px))?$/);
          const c = stopColor(m[1]);
          return {
            color: c.color,
            opacity: c.opacity,
            position: m[2]
              ? Math.max(0, Math.min(1, number(m[2]) / (m[3] === "%" ? 100 : rx * w)))
              : i / (items.length - 1),
          };
        });
        if (stops.length > 1)
          out.push({
            type: "radial-gradient",
            center: [cx, cy],
            radius: [rx, ry],
            stops,
            opacity: 1,
          });
      } else if (image !== "none")
        warnings.push(`${key}: unsupported background ${image.slice(0, 140)}`);
    }
    // CSS interpolates premultiplied colours; Figma also interpolates hidden RGB.
    for (const paint of out)
      if (paint.stops)
        for (const stop of paint.stops)
          if (stop.opacity === 0) {
            const visible = paint.stops
              .filter((s) => s.opacity > 0)
              .sort(
                (a, b) =>
                  Math.abs(a.position - stop.position) - Math.abs(b.position - stop.position),
              )[0];
            if (visible) stop.color = visible.color;
          }
    return out;
  }
  function shadows(value, key) {
    if (!value || value === "none") return [];
    return parts(value).flatMap((v) => {
      const c = v.match(/(?:rgba?|color|oklch|hsl)a?\([^)]*\)|#[\da-f]+/i);
      if (!c) {
        warnings.push(`${key}: unsupported shadow ${v}`);
        return [];
      }
      const p = color(c[0]);
      if (!p) return [];
      const n = v.replace(c[0], "").replace("inset", "").trim().split(/\s+/).map(number);
      const rgb = p.color.match(/\w\w/g).map((x) => parseInt(x, 16) / 255);
      return [
        {
          type: v.includes("inset") ? "INNER_SHADOW" : "DROP_SHADOW",
          color: { r: rgb[0], g: rgb[1], b: rgb[2], a: p.opacity },
          offset: { x: n[0] || 0, y: n[1] || 0 },
          radius: Math.max(0, (n[2] || 0) / 2),
          spread: n[3] || 0,
          visible: true,
          blendMode: "NORMAL",
        },
      ];
    });
  }
  function svgMarkup(el) {
    const clone = el.cloneNode(true);
    const orig = [el, ...el.querySelectorAll("*")],
      copied = [clone, ...clone.querySelectorAll("*")];
    orig.forEach((n, i) => {
      const s = getComputedStyle(n);
      for (const p of [
        "fill",
        "fill-opacity",
        "stroke",
        "stroke-width",
        "stroke-opacity",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-dasharray",
        "stroke-dashoffset",
        "fill-rule",
        "clip-rule",
        "opacity",
        "color",
        "font-family",
        "font-size",
        "font-weight",
      ]) {
        copied[i].style.setProperty(p, s.getPropertyValue(p));
        copied[i].setAttribute(p, s.getPropertyValue(p));
      }
    });
    // Figma's SVG importer drops zero-length dashes. Expand round dotted strokes at the
    // browser's own exact arc-length positions; each dot remains an editable vector circle.
    orig.forEach((n, i) => {
      if (!(n instanceof SVGGeometryElement)) return;
      const s = getComputedStyle(n),
        dash = s.strokeDasharray.split(/[ ,]+/).map(number);
      if (
        dash.length !== 2 ||
        dash[0] !== 0 ||
        dash[1] <= 0 ||
        s.strokeLinecap !== "round" ||
        s.stroke === "none"
      )
        return;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      if (n.hasAttribute("transform")) g.setAttribute("transform", n.getAttribute("transform"));
      g.setAttribute("fill", s.stroke);
      g.setAttribute("fill-opacity", s.strokeOpacity);
      g.setAttribute("opacity", s.opacity);
      g.setAttribute("stroke", "none");
      const length = n.getTotalLength(),
        gap = dash[1],
        offset = ((number(s.strokeDashoffset) % gap) + gap) % gap;
      for (let at = offset === 0 ? 0 : gap - offset; at <= length; at += gap) {
        const p = n.getPointAtLength(at),
          dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        dot.setAttribute("r", String(number(s.strokeWidth) / 2));
        g.appendChild(dot);
      }
      copied[i].replaceWith(g);
    });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.querySelectorAll("use").forEach((n) => {
      const ref = n.getAttribute("href") || n.getAttribute("xlink:href");
      if (ref?.startsWith("#")) {
        const target = document.getElementById(ref.slice(1));
        if (target) {
          const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
          g.innerHTML = target.innerHTML;
          for (const a of [...n.attributes])
            if (!/href/.test(a.name)) g.setAttribute(a.name, a.value);
          n.replaceWith(g);
        }
      }
    });
    clone.setAttribute("opacity", "1");
    clone.style.opacity = "1";
    const ownStyle = getComputedStyle(el);
    if (ownStyle.transform !== "none") {
      const width = number(ownStyle.width) || el.clientWidth,
        height = number(ownStyle.height) || el.clientHeight;
      const origin = ownStyle.transformOrigin.split(" ").map(number);
      const matrix = new DOMMatrix()
        .translate(origin[0], origin[1])
        .multiply(new DOMMatrix(ownStyle.transform))
        .translate(-origin[0], -origin[1]);
      const points = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
      const minX = Math.min(...points.map((p) => p.x)),
        minY = Math.min(...points.map((p) => p.y)),
        w = Math.max(...points.map((p) => p.x)) - minX,
        h = Math.max(...points.map((p) => p.y)) - minY;
      const outer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      outer.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      outer.setAttribute("width", String(w));
      outer.setAttribute("height", String(h));
      outer.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute(
        "transform",
        `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e - minX} ${matrix.f - minY})`,
      );
      clone.removeAttribute("transform");
      clone.style.removeProperty("transform");
      clone.setAttribute("width", String(width));
      clone.setAttribute("height", String(height));
      g.appendChild(clone);
      outer.appendChild(g);
      return new XMLSerializer().serializeToString(outer);
    }
    return new XMLSerializer().serializeToString(clone);
  }
  function textNodes(text, s, parentBox, key, parentFlipX = false, parentFlipY = false) {
    const value = text.nodeValue;
    if (!value?.trim()) return [];
    const lines = [];
    const range = document.createRange();
    let current = null;
    for (let i = 0; i < value.length; i++) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height || !visibleRect(text.parentElement || text.getRootNode().host, r))
        continue;
      if (!current || Math.abs(current.y - r.y) > 0.5) {
        current = { x: r.x, y: r.y, right: r.right, h: r.height, value: "" };
        lines.push(current);
      }
      current.value += value[i];
      current.x = Math.min(current.x, r.x);
      current.right = Math.max(current.right, r.right);
    }
    const style = fontOf(s).fontStyle;
    return lines
      .filter((l) => l.value.trim())
      .map((l, i) => {
        let chars = l.value;
        if (s.textTransform === "uppercase") chars = chars.toUpperCase();
        else if (s.textTransform === "lowercase") chars = chars.toLowerCase();
        const lh = number(s.lineHeight) || number(s.fontSize) * 1.2;
        const width = l.right - l.x + 1,
          top = l.y - parentBox.y + (l.h - lh) / 2;
        return {
          type: "text",
          id: `${key}/line${i}`,
          name: chars.slice(0, 80),
          source: key,
          x: round(parentFlipX ? parentBox.width - (l.x - parentBox.x) - width : l.x - parentBox.x),
          y: round(parentFlipY ? parentBox.height - top - lh : top),
          w: round(width),
          h: round(lh),
          characters: chars,
          runs: [
            {
              start: 0,
              end: chars.length,
              ...fontOf(s),
              fontStyle: style,
              fontSize: number(s.fontSize),
              fill: color(s.color) || { type: "solid", color: "#000000", opacity: 1 },
              letterSpacing: number(s.letterSpacing),
              decoration: s.textDecorationLine.includes("underline")
                ? "underline"
                : s.textDecorationLine.includes("line-through")
                  ? "strikethrough"
                  : "none",
            },
          ],
          paragraphs: [{ start: 0, end: chars.length, lineHeight: { unit: "pixels", value: lh } }],
          sizing: "width",
          effects: shadows(s.textShadow, key),
        };
      });
  }
  function fontOf(s) {
    const weight = number(s.fontWeight);
    let family = s.fontFamily
      .split(",")[0]
      .replace(/["']/g, "")
      .replace(/ Variable$/, "")
      .trim();
    const browserAlias =
      /^(ui-|system-ui$|-apple-system$|BlinkMacSystemFont$|sans-serif$|serif$|monospace$|SFMono)/;
    if (browserAlias.test(family)) {
      const key = `${s.fontFamily} ${s.fontWeight} ${s.fontStyle}`;
      if (!fontFamilies.has(key)) {
        const ctx = document.createElement("canvas").getContext("2d"),
          prefix = `${s.fontStyle} ${s.fontWeight} 20px `;
        const samples = ["0123456789", "Широкий текст", "WWW iii"];
        ctx.font = prefix + s.fontFamily;
        const expected = samples.map((t) => ctx.measureText(t).width);
        const candidates = [
          ...s.fontFamily.split(",").map((f) => f.replace(/["']/g, "").trim()),
          "Segoe UI",
          "Consolas",
          "Arial",
          "Times New Roman",
          "Courier New",
        ].filter((f) => !browserAlias.test(f));
        for (const candidate of candidates) {
          ctx.font = prefix + JSON.stringify(candidate);
          if (samples.every((t, i) => Math.abs(ctx.measureText(t).width - expected[i]) < 0.001)) {
            family = candidate;
            break;
          }
        }
        fontFamilies.set(key, family);
      }
      family = fontFamilies.get(key);
    }
    return {
      fontFamily: family,
      fontStyle:
        (weight >= 900
          ? "Black"
          : weight >= 800
            ? "Extra Bold"
            : weight >= 700
              ? "Bold"
              : weight >= 600
                ? "Semi Bold"
                : weight >= 500
                  ? "Medium"
                  : weight <= 300
                    ? "Light"
                    : "Regular") + (s.fontStyle === "italic" ? " Italic" : ""),
    };
  }
  // Keep slot nodes in the composed traversal: direct text inherits slot styles.
  const composed = (el) =>
    el.tagName === "SLOT"
      ? el.assignedNodes().length
        ? el.assignedNodes()
        : [...el.childNodes]
      : [...(el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)];
  const viewportMode = options.fullPage === false && !options.selector;
  const parentElement = (el) => el.parentElement || el.getRootNode()?.host;
  const visibility = new WeakMap();
  const styleCache = new WeakMap();
  const styleOf = (el) => {
    if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el));
    return styleCache.get(el);
  };
  // These common accessibility clips have an exactly empty painted area. Other
  // clip-path shapes stay visible and continue to report their rendering loss.
  const emptyClip = (style, box) => {
    const inset = style.clipPath?.match(/^inset\(([^()]+)\)$/);
    if (inset) {
      const values = inset[1].trim().split(/\s+/);
      if (values.length <= 4 && values.every((v) => /^-?[\d.]+(?:px|%)?$/.test(v))) {
        const [a, b = a, c = a, d = b] = values;
        const px = (v, size) => number(v) * (v.endsWith("%") ? size / 100 : 1);
        if (
          px(a, box.height) + px(c, box.height) >= box.height ||
          px(b, box.width) + px(d, box.width) >= box.width
        )
          return true;
      }
    }
    const rect = style.clip?.match(/^rect\(([^)]+)\)$/);
    if (rect && /^(absolute|fixed)$/.test(style.position)) {
      const values = rect[1].split(/[ ,]+/);
      if (values.length === 4 && values.every((v) => /^-?[\d.]+px$/.test(v)))
        return number(values[2]) <= number(values[0]) || number(values[1]) <= number(values[3]);
    }
    return false;
  };
  const visibleRect = (el, rect) => {
    let left = rect.x,
      top = rect.y,
      right = rect.x + rect.width,
      bottom = rect.y + rect.height;
    if (viewportMode) {
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(right, innerWidth);
      bottom = Math.min(bottom, innerHeight);
    }
    let escapesOverflow = styleOf(el).position === "fixed";
    for (let ancestor = el; ancestor; ancestor = parentElement(ancestor)) {
      const style = styleOf(ancestor),
        box = ancestor.getBoundingClientRect();
      if (style.display === "none" || number(style.opacity) === 0 || emptyClip(style, box))
        return false;
      if (ancestor !== el) {
        // Viewport-fixed descendants escape ordinary overflow ancestors until a
        // transform/filter/contain establishes their containing block.
        if (
          style.transform !== "none" ||
          style.filter !== "none" ||
          style.perspective !== "none" ||
          /paint|layout|strict|content/.test(style.contain)
        )
          escapesOverflow = false;
        if (viewportMode && !escapesOverflow) {
          if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
            left = Math.max(left, box.x + ancestor.clientLeft);
            right = Math.min(right, box.x + ancestor.clientLeft + ancestor.clientWidth);
          }
          if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
            top = Math.max(top, box.y + ancestor.clientTop);
            bottom = Math.min(bottom, box.y + ancestor.clientTop + ancestor.clientHeight);
          }
        }
      }
      if (right <= left || bottom <= top) return false;
    }
    return right > left && bottom > top;
  };
  const overflowPaintVisible = (el, key) => {
    const style = styleOf(el);
    // Effects can paint beyond the border box. Retain their host conservatively;
    // estimating blur/shadow bounds here would risk deleting visible pixels.
    if (
      style.boxShadow !== "none" ||
      style.filter !== "none" ||
      (style.outlineStyle !== "none" && number(style.outlineWidth) > 0)
    )
      return true;
    return ["::before", "::after"].some((pseudo) => {
      const measured = options.pseudoGeometry?.[key + pseudo];
      if (!measured?.hasLayout) return false;
      const [x, y, width, height] = measured.bounds;
      return visibleRect(el, { x: x - scrollX, y: y - scrollY, width, height });
    });
  };
  let inspected = 0;
  const subtreeVisible = (el, key) => {
    if (visibility.has(el)) return visibility.get(el);
    if (++inspected > (options.maxNodes || 30000)) throw new Error("Capture node limit exceeded");
    const style = styleOf(el),
      box = el.getBoundingClientRect();
    let visible = false;
    if (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      number(style.opacity) !== 0 &&
      !emptyClip(style, box)
    ) {
      visible =
        visibleRect(el, box) ||
        overflowPaintVisible(el, key) ||
        composed(el).some((child, i) => {
          if (child.nodeType === 1) return subtreeVisible(child, `${key}/${i}`);
          if (child.nodeType !== 3 || !child.nodeValue?.trim()) return false;
          const range = document.createRange();
          range.selectNodeContents(child);
          return visibleRect(el, range.getBoundingClientRect());
        });
    }
    visibility.set(el, visible);
    return visible;
  };
  let count = 0;
  function walk(
    el,
    parentBox,
    key,
    inheritedFilter = "",
    parentFlipX = false,
    parentFlipY = false,
  ) {
    if (++count > (options.maxNodes || 30000)) throw new Error("Capture node limit exceeded");
    const s = getComputedStyle(el),
      b = el.getBoundingClientRect();
    if (
      s.display === "none" ||
      s.visibility === "hidden" ||
      number(s.opacity) === 0 ||
      ["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"].includes(el.tagName)
    )
      return [];
    if (!subtreeVisible(el, key)) return [];
    const ownVisible = visibleRect(el, b) || overflowPaintVisible(el, key);
    if (!b.width || !b.height) {
      return composed(el).flatMap((c, i) =>
        c.nodeType === 1
          ? walk(c, parentBox, `${key}/${i}`, inheritedFilter, parentFlipX, parentFlipY)
          : c.nodeType === 3
            ? textNodes(c, s, parentBox, `${key}/text${i}`, parentFlipX, parentFlipY)
            : [],
      );
    }
    const matrix = s.transform === "none" ? new DOMMatrix() : new DOMMatrix(s.transform);
    const flipX = matrix.a < 0 && Math.abs(matrix.b) < 0.00001 && Math.abs(matrix.c) < 0.00001,
      flipY = matrix.d < 0 && Math.abs(matrix.b) < 0.00001 && Math.abs(matrix.c) < 0.00001;
    const effectiveFlipX = parentFlipX !== flipX,
      effectiveFlipY = parentFlipY !== flipY;
    if (
      (Math.abs(matrix.b) > 0.00001 || Math.abs(matrix.c) > 0.00001) &&
      el.tagName.toLowerCase() !== "svg" &&
      ownVisible
    )
      warnings.push(`${key}: CSS rotation/skew requires visual review`);
    const base = {
      id: key,
      name:
        el.getAttribute("aria-label") ||
        el.id ||
        `${el.tagName.toLowerCase()}${typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`,
      source: key,
      cssZIndex: parseInt(s.zIndex, 10) || 0,
      cssPosition: s.position,
      cssStackingContext:
        el === document.body ||
        /^(fixed|sticky)$/.test(s.position) ||
        (s.position !== "static" && s.zIndex !== "auto") ||
        (s.zIndex !== "auto" &&
          /flex|grid/.test(getComputedStyle(el.parentElement || el).display)) ||
        number(s.opacity) < 1 ||
        s.transform !== "none" ||
        s.filter !== "none" ||
        s.perspective !== "none" ||
        s.isolation === "isolate" ||
        s.mixBlendMode !== "normal" ||
        (s.maskImage && s.maskImage !== "none") ||
        (s.clipPath && s.clipPath !== "none") ||
        /paint|layout|strict|content/.test(s.contain) ||
        /transform|opacity|filter|perspective/.test(s.willChange),
      role: el.getAttribute("role") || undefined,
      x: round(parentFlipX ? parentBox.width - (b.x - parentBox.x) - b.width : b.x - parentBox.x),
      y: round(parentFlipY ? parentBox.height - (b.y - parentBox.y) - b.height : b.y - parentBox.y),
      w: round(b.width),
      h: round(b.height),
      opacity: number(s.opacity),
      flipX,
      flipY,
    };
    if (!ownVisible) {
      // Keep the original coordinate/stacking ancestor for visible overflow or
      // fixed descendants, without capturing its offscreen paint or resources.
      const filter = [
        inheritedFilter,
        s.filter === "none" ? "" : s.filter.replace(/blur\([^)]*\)/g, ""),
      ]
        .filter(Boolean)
        .join(" ");
      const children = composed(el).flatMap((child, i) =>
        child.nodeType === 1
          ? walk(child, b, `${key}/${i}`, filter, effectiveFlipX, effectiveFlipY)
          : child.nodeType === 3
            ? textNodes(child, s, b, `${key}/text${i}`, effectiveFlipX, effectiveFlipY)
            : [],
      );
      return children.length
        ? [
            {
              ...base,
              type: "frame",
              fills: [],
              strokes: [],
              effects: [],
              radii: [0, 0, 0, 0],
              clip: false,
              children,
            },
          ]
        : [];
    }
    if (el.tagName.toLowerCase() === "svg")
      return [{ ...base, flipX: false, flipY: false, type: "svg", svg: svgMarkup(el) }];
    if (s.clipPath && s.clipPath !== "none")
      warnings.push(`${key}: unsupported CSS clip-path ${s.clipPath}`);
    const fills = el === root && propagatedBodyBackground ? [] : paints(s, b.width, b.height, key);
    const radii = [
      s.borderTopLeftRadius,
      s.borderTopRightRadius,
      s.borderBottomRightRadius,
      s.borderBottomLeftRadius,
    ].map((v) =>
      Math.min(
        Math.min(b.width, b.height) / 2,
        v.includes("%") ? (Math.min(b.width, b.height) * number(v)) / 100 : number(v),
      ),
    );
    const strokes = [];
    const sides = ["Top", "Right", "Bottom", "Left"];
    const bw = sides.map((p) => number(s[`border${p}Width`]));
    const bc = sides.map((p) => s[`border${p}Color`]);
    if (bw.every((v) => v === bw[0]) && bc.every((v) => v === bc[0]) && bw[0] && color(bc[0]))
      strokes.push({ paint: color(bc[0]), weight: bw[0], align: "inside" });
    const ox = /(auto|scroll)/.test(s.overflowX),
      oy = /(auto|scroll)/.test(s.overflowY);
    const frame = {
      ...base,
      type: "frame",
      fills,
      radii,
      strokes,
      clip: /(hidden|clip|scroll|auto)/.test(`${s.overflowX} ${s.overflowY}`),
      overflow: ox && oy ? "BOTH" : ox ? "HORIZONTAL" : oy ? "VERTICAL" : "NONE",
      effects: shadows(s.boxShadow, key),
      children: [],
      ...(el.tagName === "IFRAME"
        ? { browserFrame: el.getAttribute(options.frameAttribute || "data-figbridge-frame") }
        : {}),
    };
    if (el.tagName === "IFRAME" && !options.frameAttribute)
      warnings.push(`${key}: iframe contents require capturePage browser adapter`);
    const blur = s.filter.match(/blur\(([\d.]+)px\)/);
    if (blur) frame.effects.push({ type: "LAYER_BLUR", radius: number(blur[1]), visible: true });
    const backdrop = s.backdropFilter?.match(/blur\(([\d.]+)px\)/);
    if (backdrop)
      frame.effects.push({ type: "BACKGROUND_BLUR", radius: number(backdrop[1]), visible: true });
    if (s.maskImage && s.maskImage !== "none")
      frame.mask = paints(
        { backgroundColor: "transparent", backgroundImage: s.maskImage },
        b.width,
        b.height,
        `${key}/mask`,
      );
    const filter = [
      inheritedFilter,
      s.filter === "none" ? "" : s.filter.replace(/blur\([^)]*\)/g, ""),
    ]
      .filter(Boolean)
      .join(" ");
    if (el instanceof HTMLImageElement && el.currentSrc) {
      assets.add(el.currentSrc);
      let url = el.currentSrc;
      if (filter && el.naturalWidth) {
        const cacheKey = `${url} ${filter}`;
        if (!filteredAssets.has(cacheKey)) {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = el.naturalWidth;
            canvas.height = el.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.filter = filter;
            ctx.drawImage(el, 0, 0);
            filteredAssets.set(cacheKey, canvas.toDataURL("image/png"));
          } catch {
            warnings.push(`${key}: cannot bake original image filter ${filter}`);
          }
        }
        url = filteredAssets.get(cacheKey) || url;
      }
      frame.children.push({
        type: "image",
        id: `${key}/image`,
        name: el.getAttribute("src") || "image",
        source: el.currentSrc,
        x: 0,
        y: 0,
        w: b.width,
        h: b.height,
        image: {
          type: "image",
          url,
          ...objectPaint(s, b, el.naturalWidth, el.naturalHeight),
          opacity: 1,
        },
      });
    }
    if (el instanceof HTMLVideoElement) {
      if (
        el.getAttribute("poster")?.trim() &&
        el.paused &&
        el.currentTime === 0 &&
        el.played.length === 0
      ) {
        const url = new URL(el.poster, location.href).href;
        assets.add(url);
        frame.children.push({
          type: "image",
          id: `${key}/video-poster`,
          name: "Original video poster",
          source: url,
          x: 0,
          y: 0,
          w: b.width,
          h: b.height,
          image: {
            type: "image",
            url,
            ...objectPaint(s, b, el.videoWidth, el.videoHeight),
            opacity: 1,
          },
        });
      } else if (el.readyState >= 2 && el.videoWidth) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          const ctx = canvas.getContext("2d");
          if (filter) ctx.filter = filter;
          ctx.drawImage(el, 0, 0);
          frame.children.push({
            type: "image",
            id: `${key}/video-frame`,
            name: "Original video frame",
            source: `${el.currentSrc}#t=${el.currentTime}`,
            x: 0,
            y: 0,
            w: b.width,
            h: b.height,
            image: {
              type: "image",
              url: canvas.toDataURL("image/png"),
              ...objectPaint(s, b, el.videoWidth, el.videoHeight),
              opacity: 1,
            },
          });
          warnings.push(
            `${key}: video preserved as its original decoded frame at ${el.currentTime}s`,
          );
        } catch {
          warnings.push(`${key}: video frame could not be exported`);
        }
      } else warnings.push(`${key}: video has no decoded frame; load and pause it before capture`);
    }
    if (el instanceof HTMLCanvasElement) {
      try {
        frame.children.push({
          type: "image",
          id: `${key}/canvas`,
          name: "Canvas — complex rendered graphics",
          source: key,
          x: 0,
          y: 0,
          w: b.width,
          h: b.height,
          image: { type: "image", url: el.toDataURL("image/png"), scaleMode: "fill", opacity: 1 },
        });
        warnings.push(`${key}: canvas graphics preserved as a separate raster layer`);
      } catch {
        warnings.push(`${key}: canvas could not be exported`);
      }
    }
    if (
      s.backdropFilter &&
      s.backdropFilter.replace(/blur\([^)]*\)/g, "").trim() !== "none" &&
      s.backdropFilter.replace(/blur\([^)]*\)/g, "").trim()
    )
      warnings.push(`${key}: backdrop saturation requires review: ${s.backdropFilter}`);
    if (s.mixBlendMode !== "normal")
      frame.blendMode = s.mixBlendMode.replaceAll("-", "_").toUpperCase();
    else if (frame.mask || s.isolation === "isolate" || s.filter !== "none")
      frame.blendMode = "NORMAL";
    if (s.maskImage && s.maskImage !== "none" && !frame.mask)
      warnings.push(`${key}: CSS mask ${s.maskImage.slice(0, 100)}`);
    // Negative z-index descendants paint before normal-flow content; positive stacking last.
    const children = composed(el)
      .map((n, i) => ({
        n,
        i,
        z: n.nodeType === 1 ? parseInt(getComputedStyle(n).zIndex, 10) || 0 : 0,
      }))
      .sort((a, b) => a.z - b.z || a.i - b.i);
    for (const { n, i } of children) {
      if (n.nodeType === 3)
        frame.children.push(
          ...textNodes(n, s, b, `${key}/text${i}`, effectiveFlipX, effectiveFlipY),
        );
      else if (n.nodeType === 1)
        frame.children.push(...walk(n, b, `${key}/${i}`, filter, effectiveFlipX, effectiveFlipY));
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const password = el instanceof HTMLInputElement && el.type === "password";
      const value =
        password && el.value ? "\u2022".repeat(el.value.length) : el.value || el.placeholder;
      if (value) {
        const style = el.value ? s : getComputedStyle(el, "::placeholder");
        const size = number(style.fontSize) || number(s.fontSize),
          lh = number(s.lineHeight) || size * 1.2;
        frame.children.push({
          type: "text",
          id: `${key}/value`,
          name: value,
          source: key,
          x: number(s.paddingLeft) + number(s.borderLeftWidth),
          y: (b.height - lh) / 2,
          w:
            b.width -
            number(s.paddingLeft) -
            number(s.paddingRight) -
            number(s.borderLeftWidth) -
            number(s.borderRightWidth),
          h: lh,
          characters: value,
          align: ["center", "right", "left", "justified"].includes(s.textAlign)
            ? s.textAlign
            : s.textAlign === "end"
              ? "right"
              : "left",
          runs: [
            {
              start: 0,
              end: value.length,
              ...fontOf(style),
              fontSize: size,
              letterSpacing: number(style.letterSpacing) || number(s.letterSpacing),
              fill: color(style.color) || color(s.color),
            },
          ],
          paragraphs: [{ start: 0, end: value.length, lineHeight: { unit: "pixels", value: lh } }],
        });
      }
    }
    for (let i = 0; i < 4; i++)
      if (bw[i] && !strokes.length && color(bc[i]))
        frame.children.push({
          type: "rect",
          id: `${key}/border${i}`,
          name: `border ${sides[i]}`,
          x: i === 1 ? b.width - bw[i] : 0,
          y: i === 2 ? b.height - bw[i] : 0,
          w: i % 2 ? bw[i] : b.width,
          h: i % 2 ? b.height : bw[i],
          fills: [color(bc[i])],
        });
    for (const pseudo of ["::before", "::after"]) {
      const p = getComputedStyle(el, pseudo);
      if (p.content === "none" || p.content === "normal" || p.display === "none") continue;
      if (p.visibility === "hidden" || p.visibility === "collapse" || number(p.opacity) === 0)
        continue;
      const measured = options.pseudoGeometry?.[key + pseudo];
      const literal = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/s.test(p.content)
        ? p.content
            .slice(1, -1)
            .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/\\(.)/gs, "$1")
        : null;
      const transparent = (value) => value === "transparent" || /rgba\([^)]*,\s*0\)$/.test(value);
      const sides = ["Top", "Right", "Bottom", "Left"];
      const borderWidths = sides.map((side) => number(p[`border${side}Width`]));
      const borderColors = sides.map((side) => p[`border${side}Color`]);
      const noOutline =
        p.outlineStyle === "none" || number(p.outlineWidth) === 0 || transparent(p.outlineColor);
      const simpleEffects =
        noOutline &&
        p.filter === "none" &&
        p.boxShadow === "none" &&
        (!p.maskImage || p.maskImage === "none") &&
        p.clipPath === "none" &&
        p.mixBlendMode === "normal" &&
        (!p.backdropFilter || p.backdropFilter === "none");
      const noPaint =
        literal !== null &&
        !literal.trim() &&
        transparent(p.backgroundColor) &&
        p.backgroundImage === "none" &&
        (!p.maskImage || p.maskImage === "none") &&
        p.boxShadow === "none" &&
        noOutline &&
        borderWidths.every((width, i) => !width || transparent(borderColors[i]));
      // Whitespace layout effects are already present in measured sibling positions.
      if (noPaint) continue;
      if (measured?.hasLayout !== false && measured?.bounds) {
        const [mx, my, mw, mh] = measured.bounds;
        if (
          mw > 0 &&
          mh > 0 &&
          !visibleRect(el, { x: mx - scrollX, y: my - scrollY, width: mw, height: mh })
        )
          continue;
        if (mw > 0 && mh > 0 && p.position !== "fixed") {
          const left = mx - scrollX,
            top = my - scrollY;
          if (
            /hidden|clip|scroll|auto/.test(s.overflowX) &&
            (left + mw <= b.x + el.clientLeft || left >= b.x + el.clientLeft + el.clientWidth)
          )
            continue;
          if (
            /hidden|clip|scroll|auto/.test(s.overflowY) &&
            (top + mh <= b.y + el.clientTop || top >= b.y + el.clientTop + el.clientHeight)
          )
            continue;
        }
        const matrix = p.transform === "none" ? new DOMMatrix() : new DOMMatrix(p.transform);
        const translationOnly =
          matrix.is2D && matrix.a === 1 && matrix.d === 1 && matrix.b === 0 && matrix.c === 0;
        const nativeBase = {
          id: key + pseudo,
          name: pseudo,
          source: key + pseudo,
          type: "svg",
          cssZIndex: parseInt(p.zIndex, 10) || 0,
          x: mx - scrollX - b.x,
          y: my - scrollY - b.y,
          w: mw,
          h: mh,
          opacity: number(p.opacity),
        };
        if (
          translationOnly &&
          mw > 0 &&
          mh > 0 &&
          literal?.trim() &&
          !/[\r\n]/.test(literal) &&
          transparent(p.backgroundColor) &&
          p.backgroundImage === "none" &&
          borderWidths.every((width) => width === 0) &&
          simpleEffects &&
          p.textTransform === "none"
        ) {
          const fontSize = number(p.fontSize),
            lineHeight = number(p.lineHeight) || fontSize * 1.2;
          frame.children.push({
            ...nativeBase,
            type: "text",
            characters: literal,
            x: nativeBase.x + number(p.paddingLeft),
            y: nativeBase.y + number(p.paddingTop),
            w: mw - number(p.paddingLeft) - number(p.paddingRight),
            h: mh,
            align: ["center", "right"].includes(p.textAlign) ? p.textAlign : "left",
            runs: [
              {
                start: 0,
                end: literal.length,
                ...fontOf(p),
                fontSize,
                fill: color(p.color) || { type: "solid", color: "#000000", opacity: 1 },
                letterSpacing: number(p.letterSpacing),
                decoration: p.textDecorationLine.includes("underline")
                  ? "underline"
                  : p.textDecorationLine.includes("line-through")
                    ? "strikethrough"
                    : "none",
              },
            ],
            paragraphs: [
              { start: 0, end: literal.length, lineHeight: { unit: "pixels", value: lineHeight } },
            ],
            sizing: "width",
          });
          continue;
        }
        if (translationOnly && mw > 0 && mh > 0 && literal === "" && simpleEffects) {
          const painted = sides
            .map((_, i) => i)
            .filter((i) => borderWidths[i] > 0 && !transparent(borderColors[i]));
          const triangular =
            painted.length === 1 &&
            Math.abs(borderWidths[1] + borderWidths[3] - mw) < 0.1 &&
            Math.abs(borderWidths[0] + borderWidths[2] - mh) < 0.1 &&
            sides.every(
              (side) => p[`border${side}Style`] === "solid" || p[`border${side}Style`] === "none",
            ) &&
            p.backgroundImage === "none" &&
            transparent(p.backgroundColor) &&
            p.boxShadow === "none";
          if (triangular) {
            const center = `${borderWidths[3]} ${borderWidths[0]}`;
            const paths = [
              `M0 0L${mw} 0L${center}Z`,
              `M${mw} 0L${mw} ${mh}L${center}Z`,
              `M${mw} ${mh}L0 ${mh}L${center}Z`,
              `M0 ${mh}L0 0L${center}Z`,
            ];
            frame.children.push({
              ...nativeBase,
              svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${mw}" height="${mh}" viewBox="0 0 ${mw} ${mh}"><path fill="${borderColors[painted[0]]}" d="${paths[painted[0]]}"/></svg>`,
            });
            continue;
          }
          const urls = [
            ...p.backgroundImage.matchAll(
              /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/g,
            ),
          ].map((match) => match[1] ?? match[2] ?? match[3].trim());
          let markup = measured.svg;
          if (!markup && urls.length === 1 && urls[0].startsWith("data:image/svg+xml")) {
            try {
              const comma = urls[0].indexOf(",");
              markup = urls[0].slice(0, comma).includes(";base64")
                ? atob(urls[0].slice(comma + 1))
                : decodeURIComponent(urls[0].slice(comma + 1));
            } catch {
              /* Unsupported encoding retains the warning. */
            }
          }
          if (
            markup &&
            urls.length === 1 &&
            p.backgroundRepeat === "no-repeat" &&
            ["contain", "auto", "auto auto"].includes(p.backgroundSize) &&
            borderWidths.every((width) => width === 0) &&
            transparent(p.backgroundColor) &&
            p.boxShadow === "none" &&
            (!p.maskImage || p.maskImage === "none")
          ) {
            const parsed = new DOMParser().parseFromString(markup, "image/svg+xml"),
              svg = parsed.documentElement;
            const positions = {
              "0% 0%": "xMinYMin",
              "50% 50%": "xMidYMid",
              "100% 0%": "xMaxYMin",
              "0% 50%": "xMinYMid",
              "100% 50%": "xMaxYMid",
              "50% 0%": "xMidYMin",
              "50% 100%": "xMidYMax",
              "0% 100%": "xMinYMax",
              "100% 100%": "xMaxYMax",
            };
            const intrinsicWidth = svg.getAttribute("width"),
              intrinsicHeight = svg.getAttribute("height");
            const autoSize =
              p.backgroundSize === "contain" ||
              (!intrinsicWidth && !intrinsicHeight) ||
              (Math.abs(number(intrinsicWidth) - mw) < 0.1 &&
                Math.abs(number(intrinsicHeight) - mh) < 0.1);
            if (
              svg.localName === "svg" &&
              !parsed.querySelector("parsererror") &&
              positions[p.backgroundPosition] &&
              autoSize
            ) {
              if (
                !svg.hasAttribute("viewBox") &&
                /^\d+(?:\.\d+)?(?:px)?$/.test(intrinsicWidth ?? "") &&
                /^\d+(?:\.\d+)?(?:px)?$/.test(intrinsicHeight ?? "")
              )
                svg.setAttribute(
                  "viewBox",
                  `0 0 ${number(intrinsicWidth)} ${number(intrinsicHeight)}`,
                );
              svg.setAttribute("color", p.color);
              svg.setAttribute("preserveAspectRatio", `${positions[p.backgroundPosition]} meet`);
              svg.setAttribute("x", "0");
              svg.setAttribute("y", "0");
              svg.setAttribute("width", String(mw));
              svg.setAttribute("height", String(mh));
              frame.children.push({
                ...nativeBase,
                svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${mw}" height="${mh}" viewBox="0 0 ${mw} ${mh}">${new XMLSerializer().serializeToString(svg)}</svg>`,
              });
              continue;
            }
            warnings.push(
              `${key}${pseudo}: pseudo SVG background sizing or position requires review`,
            );
          }
        }
      }
      if (!["absolute", "fixed"].includes(p.position) || !['""', "''"].includes(p.content)) {
        warnings.push(`${key}${pseudo}: non-decorative pseudo element requires review`);
        continue;
      }
      const pw =
        p.width === "auto"
          ? b.width -
            number(p.left) -
            number(p.right) -
            number(s.borderLeftWidth) -
            number(s.borderRightWidth)
          : number(p.width);
      const ph =
        p.height === "auto"
          ? b.height -
            number(p.top) -
            number(p.bottom) -
            number(s.borderTopWidth) -
            number(s.borderBottomWidth)
          : number(p.height);
      let px =
        p.left === "auto"
          ? b.width - number(p.right) - pw
          : number(p.left) + number(s.borderLeftWidth);
      let py =
        p.top === "auto"
          ? b.height - number(p.bottom) - ph
          : number(p.top) + number(s.borderTopWidth);
      if (p.transform !== "none") {
        const matrix = new DOMMatrix(p.transform);
        px += matrix.e;
        py += matrix.f;
        if (matrix.a !== 1 || matrix.d !== 1 || matrix.b || matrix.c)
          warnings.push(`${key}${pseudo}: transformed decoration requires review`);
      }
      if (pw > 0 && ph > 0)
        frame.children.push({
          type: "frame",
          id: key + pseudo,
          cssZIndex: parseInt(p.zIndex, 10) || 0,
          name: pseudo,
          source: key + pseudo,
          x: px,
          y: py,
          w: pw,
          h: ph,
          opacity: number(p.opacity),
          fills: paints(p, pw, ph, key + pseudo),
          radii: [
            p.borderTopLeftRadius,
            p.borderTopRightRadius,
            p.borderBottomRightRadius,
            p.borderBottomLeftRadius,
          ].map(number),
          effects: [
            ...shadows(p.boxShadow, key + pseudo),
            ...(p.backdropFilter?.match(/blur\(([\d.]+)px\)/)
              ? [
                  {
                    type: "BACKGROUND_BLUR",
                    radius: number(p.backdropFilter.match(/blur\(([\d.]+)px\)/)[1]),
                    visible: true,
                  },
                ]
              : []),
          ],
          ...(p.maskImage && p.maskImage !== "none"
            ? {
                mask: paints(
                  { backgroundColor: "transparent", backgroundImage: p.maskImage },
                  pw,
                  ph,
                  `${key + pseudo}/mask`,
                ),
                blendMode: "NORMAL",
              }
            : {}),
          children: [],
        });
    }
    frame.children = frame.children
      .map((n, i) => ({ n, i }))
      .sort(
        (a, b) =>
          (a.n.cssZIndex || 0) - (b.n.cssZIndex || 0) ||
          (a.n.name === "::before" ? -1 : a.n.name === "::after" ? 1 : 0) -
            (b.n.name === "::before" ? -1 : b.n.name === "::after" ? 1 : 0) ||
          a.i - b.i,
      )
      .map((x) => x.n);
    return [frame];
  }
  const width = options.selector
    ? root.getBoundingClientRect().width
    : options.fullPage
      ? Math.max(document.documentElement.scrollWidth, innerWidth)
      : innerWidth;
  const height = options.selector
    ? root.getBoundingClientRect().height
    : options.fullPage
      ? Math.max(document.documentElement.scrollHeight, innerHeight)
      : innerHeight;
  const htmlStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  const htmlColor = color(htmlStyle.backgroundColor);
  // Chromium's normal screenshot composites the page canvas over opaque white.
  // With a transparent root and no background image, the body's solid background
  // propagates to that canvas rather than being painted again in the body box.
  const propagatedBodyBackground =
    !options.selector &&
    root === document.body &&
    !htmlColor &&
    htmlStyle.backgroundImage === "none" &&
    bodyStyle.backgroundImage === "none";
  const canvasColor =
    htmlColor || (propagatedBodyBackground ? color(bodyStyle.backgroundColor) : null);
  const canvasRgb = (canvasColor?.color || "#ffffff")
    .match(/[a-f\d]{2}/gi)
    .map((v) =>
      Math.round(
        parseInt(v, 16) * (canvasColor?.opacity ?? 1) + 255 * (1 - (canvasColor?.opacity ?? 1)),
      ),
    );
  const background = options.selector
    ? []
    : [
        {
          type: "solid",
          color: `#${canvasRgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`,
          opacity: 1,
        },
      ];
  const capturedChildren = walk(root, origin, "root");
  assets.clear();
  const collectAssets = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "image" && node.url) assets.add(node.url);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collectAssets);
      else if (value && typeof value === "object") collectAssets(value);
    }
  };
  capturedChildren.forEach(collectAssets);
  return {
    slide: {
      name: options.name || document.title,
      width,
      height,
      background,
      children: capturedChildren,
    },
    warnings: [...new Set(warnings)],
    assets: [...assets],
    url: location.href,
    nodeCount: count,
  };
}
