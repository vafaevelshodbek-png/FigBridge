import { createHash } from "node:crypto";

const dangerous =
  /submit|send|purchase|buy|checkout|delete|remove|logout|log out|sign out|pay|confirm|unsubscribe|отправ|купить|оплат|удал|выйти/i;
const bounds = {
  maxStates: [20, 1, 1000],
  maxActions: [80, 1, 10000],
  maxDepth: [2, 0, 30],
  maxScrollSteps: [3, 0, 100],
  timeoutMs: [10000, 1, 120000],
};
const clean = (value) =>
  Array.isArray(value)
    ? value.map(clean)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => !["name", "timestamp", "capturedAt", "captureTime"].includes(k))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, clean(v)]),
        )
      : value;

/** Bounded, conservative browser exploration. Recipes are arrays of action arrays. */
export async function explorePage(page, options = {}) {
  const o = { ...options };
  for (const [key, [fallback, min, max]] of Object.entries(bounds)) {
    o[key] ??= fallback;
    if (!Number.isInteger(o[key]) || o[key] < min || o[key] > max)
      throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
  }
  if (typeof o.capture !== "function") throw new Error("capture callback required");
  const root = new URL(o.url ?? page.url());
  if (!["http:", "https:"].includes(root.protocol)) throw new Error("Expected HTTP(S) URL");
  const check = () => {
    if (o.signal?.aborted) throw new Error("Exploration aborted");
  };
  const states = [],
    edges = [],
    seen = new Map();
  let actions = 0;
  const scope = {
    url: root.href,
    origin: root.origin,
    maxStates: o.maxStates,
    maxActions: o.maxActions,
    maxDepth: o.maxDepth,
    maxScrollSteps: o.maxScrollSteps,
  };
  // Navigation guards apply even to clicks whose handlers try cross-origin navigation.
  const guard = async (route) => {
    const req = route.request();
    if (
      (req.isNavigationRequest() && !["GET", "HEAD", "OPTIONS"].includes(req.method())) ||
      (req.isNavigationRequest() &&
        req.frame() === page.mainFrame() &&
        new URL(req.url()).origin !== root.origin)
    )
      await route.abort();
    else await route.continue();
  };
  await page.route("**/*", guard);
  const resolveTarget = (action) =>
    action.selector
      ? page.locator(action.selector).first()
      : page.getByRole(action.role, { name: action.name, exact: true }).first();
  const perform = async (action) => {
    check();
    if (action.action === "scroll") {
      const offset = {
        x: action.x ?? 0,
        y: action.y ?? (action.x === undefined ? (page.viewportSize()?.height ?? 700) : 0),
      };
      if (action.selector || action.role)
        await resolveTarget(action).evaluate((el, delta) => el.scrollBy(delta.x, delta.y), offset);
      else await page.evaluate((delta) => window.scrollBy(delta.x, delta.y), offset);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      check();
      return;
    }
    if (action.action === "wait") {
      await page.waitForTimeout(Math.min(action.ms ?? 100, o.timeoutMs));
      return;
    }
    const target = resolveTarget(action);
    if (action.action === "click") await target.click({ timeout: o.timeoutMs });
    else if (action.action === "hover") await target.hover({ timeout: o.timeoutMs });
    else if (action.action === "fill")
      await target.fill(action.value ?? "", { timeout: o.timeoutMs });
    else if (action.action === "select")
      await target.selectOption(action.value, { timeout: o.timeoutMs });
    else if (action.action === "press") {
      if (/enter|return/i.test(action.key ?? "")) throw new Error("Submission key blocked");
      await target.press(action.key, { timeout: o.timeoutMs });
    } else throw new Error(`Unknown action ${action.action}`);
    check();
  };
  const restore = async (recipe) => {
    check();
    await page.goto(root.href, { waitUntil: "domcontentloaded", timeout: o.timeoutMs });
    for (const action of recipe) await perform(action);
    check();
  };
  const take = async (recipe) => {
    check();
    const data = await o.capture(page);
    check();
    if (!data?.slide) throw new Error("Capture returned no slide");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ url: page.url(), slide: clean(data.slide) }))
      .digest("hex");
    if (seen.has(fingerprint)) return { duplicate: seen.get(fingerprint) };
    const state = {
      id: `state-${states.length}`,
      index: states.length,
      url: page.url(),
      recipe,
      fingerprint,
    };
    state.result = o.onState ? await o.onState(data, state) : undefined;
    check();
    states.push(state);
    seen.set(fingerprint, state.id);
    return { state };
  };
  const discover = async () =>
    page.evaluate(() => {
      const all = [
        ...document.querySelectorAll(
          "a[href],button,input[type=submit],[role=tab],[role=menuitem],[aria-expanded],summary,[aria-haspopup],[tabindex]",
        ),
      ];
      return all
        .filter((el) => el.getClientRects().length)
        .slice(0, 500)
        .map((el) => {
          const path = [];
          let node = el;
          while (node && node !== document.documentElement) {
            path.unshift(
              `${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`,
            );
            node = node.parentElement;
          }
          const name = (el.getAttribute("aria-label") || el.textContent || el.value || "")
            .trim()
            .slice(0, 160);
          return {
            action: "click",
            selector: `html > ${path.join(" > ")}`,
            name,
            href: el instanceof HTMLAnchorElement ? el.href : undefined,
            submit:
              el.matches("input[type=submit],button:not([type=button])") && !!el.closest("form"),
            safe: el.matches(
              "a[href],summary,[role=tab],[role=menuitem],[aria-expanded],[aria-haspopup]",
            ),
            hover: el.matches("[tabindex],[aria-haspopup]"),
          };
        });
    });
  const unsafe = async (action) => {
    if (dangerous.test(`${action.name ?? ""} ${action.href ?? ""}`) || action.submit)
      return "Potentially destructive or submitting control";
    if (action.href) {
      const url = new URL(action.href, root);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== root.origin)
        return "Outside same-origin scope";
    }
    if (
      action.action === "click" ||
      (action.action === "press" &&
        /^(?:(?:Alt|Control|Meta|Shift)\+)*(?:Space| |Enter|Return)$/i.test(action.key ?? ""))
    ) {
      const info = await resolveTarget(action).evaluate((el) => ({
        name: el.getAttribute("aria-label") || el.textContent || "",
        submit:
          ((el instanceof HTMLButtonElement && el.type === "submit") ||
            (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type))) &&
          !!el.form,
        href: el instanceof HTMLAnchorElement ? el.href : "",
      }));
      if (dangerous.test(`${info.name} ${info.href}`) || info.submit)
        return "Potentially destructive or submitting control";
      if (info.href && new URL(info.href).origin !== root.origin)
        return "Outside same-origin scope";
    }
    return null;
  };
  const discoverScroll = async () =>
    page.evaluate(() => {
      const candidates = [];
      for (const el of document.querySelectorAll("body *")) {
        if (candidates.length >= 50) break;
        const rect = el.getBoundingClientRect();
        if (
          !rect.width ||
          !rect.height ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= innerHeight ||
          rect.left >= innerWidth
        )
          continue;
        const style = getComputedStyle(el);
        const vertical =
          /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const horizontal =
          /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if (!vertical && !horizontal) continue;
        const path = [];
        let node = el;
        while (node && node !== document.documentElement) {
          path.unshift(
            `${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`,
          );
          node = node.parentElement;
        }
        const selector = `html > ${path.join(" > ")}`;
        if (vertical) candidates.push({ action: "scroll", selector, x: 0, y: el.clientHeight });
        if (horizontal) candidates.push({ action: "scroll", selector, x: el.clientWidth, y: 0 });
      }
      return candidates;
    });
  try {
    await restore([]);
    const initial = await take([]);
    const work = [initial.state];
    for (let cursor = 0; cursor < work.length; cursor++) {
      const parent = work[cursor];
      await restore(parent.recipe);
      let candidates;
      if (o.recipes) {
        if (!Array.isArray(o.recipes)) throw new Error("recipes must be an array");
        const paths = o.recipes.map((r) => (Array.isArray(r) ? r : r.steps));
        if (paths.some((r) => !Array.isArray(r)))
          throw new Error("recipes must contain steps arrays");
        candidates = paths
          .filter(
            (r) =>
              r.length > parent.recipe.length &&
              JSON.stringify(r.slice(0, parent.recipe.length)) === JSON.stringify(parent.recipe),
          )
          .map((r) => r[parent.recipe.length]);
      } else {
        const found = await discover();
        candidates = found.flatMap((a) =>
          a.hover ? [a, { ...a, action: "hover", safe: true }] : [a],
        );
        if (parent.recipe.filter((a) => a.action === "scroll").length < o.maxScrollSteps) {
          candidates.push(...(await discoverScroll()));
          candidates.push({ action: "scroll", y: page.viewportSize()?.height ?? 700 });
        }
      }
      const unique = new Set();
      for (const action of candidates) {
        check();
        const key = JSON.stringify(action);
        if (unique.has(key)) continue;
        unique.add(key);
        const edge = { from: parent.id, action, status: "pending" };
        edges.push(edge);
        if (
          parent.recipe.length >= o.maxDepth ||
          states.length >= o.maxStates ||
          actions >= o.maxActions
        )
          continue;
        actions++;
        try {
          await restore(parent.recipe);
          const reason =
            action.action === "scroll" &&
            parent.recipe.filter((a) => a.action === "scroll").length >= o.maxScrollSteps
              ? "Scroll step limit"
              : await unsafe(action);
          if (reason || (!o.recipes && action.action === "click" && !action.safe)) {
            edge.status = "blocked";
            edge.reason = reason ?? "Control is not a recognized safe navigation control";
            continue;
          }
          await perform(action);
        } catch (error) {
          check();
          edge.status = "failed";
          edge.reason = String(error.message ?? error);
          continue;
        }
        // Capture/persistence failures must fail the run, never masquerade as completed coverage.
        const result = await take([...parent.recipe, action]);
        edge.to = result.duplicate ?? result.state.id;
        edge.status = result.duplicate ? "duplicate" : "captured";
        // Explicit replay paths remain work even when their pixels are already saved.
        if (result.state || o.recipes)
          work.push({ id: edge.to, recipe: [...parent.recipe, action] });
      }
    }
    return {
      states,
      edges,
      coverage: {
        actions,
        counts: Object.fromEntries(
          ["captured", "duplicate", "blocked", "failed", "pending"].map((s) => [
            s,
            edges.filter((e) => e.status === s).length,
          ]),
        ),
        limited: edges.some((e) => e.status === "pending"),
        exhaustive: false,
      },
      scope,
    };
  } finally {
    await page.unroute("**/*", guard);
  }
}
