/** Move nested stacking contexts to their CSS paint parent, retaining measured origins. */
function liftContexts(wrapper, x, y) {
  const retained = [],
    lifted = [];
  for (const child of wrapper.children || []) {
    if (child.cssStackingContext === true) {
      child.x = (child.x || 0) + x;
      child.y = (child.y || 0) + y;
      lifted.push(child);
    } else {
      retained.push(child);
      if (canLiftThrough(child))
        lifted.push(...liftContexts(child, x + (child.x || 0), y + (child.y || 0)));
    }
  }
  wrapper.children = retained;
  return lifted;
}
function canLiftThrough(node) {
  return (
    node.cssStackingContext === false &&
    !node.clip &&
    (node.opacity === undefined || node.opacity === 1) &&
    !node.effects?.length &&
    !node.flipX &&
    !node.flipY
  );
}

/** Adapt browser paint semantics, also for captures recorded by older extractors. */
export function normalizeCapture(node) {
  if (!node || typeof node !== "object") return node;
  // Inline resource bytes belong to the image paint/cache. Native layer source
  // metadata is bounded, so do not duplicate a potentially megabyte-sized URL.
  if (typeof node.source === "string" && node.source.startsWith("data:")) {
    const mime = node.source.slice(0, node.source.indexOf(",")).split(";")[0];
    node.source = `${node.id || "inline"}/${mime}`.slice(0, 4096);
  }
  if (node.cssStackingContext === true && node.children) {
    const children = [];
    for (const child of node.children) {
      children.push(child);
      if (canLiftThrough(child)) children.push(...liftContexts(child, child.x || 0, child.y || 0));
    }
    node.children = children;
  }
  if (node.fontFamily?.endsWith(" Variable"))
    node.fontFamily = node.fontFamily.replace(/ Variable$/, "");
  // A CSS mask establishes an isolated stacking context. Native pass-through would
  // let a descendant's multiply/screen blend leak into siblings outside the mask.
  if (node.type === "frame" && node.mask && !node.blendMode) node.blendMode = "NORMAL";
  // Figma masks must consume one explicit group when nested frames are involved.
  // Move the background into that group too, so the alpha mask covers every layer.
  if (
    node.type === "frame" &&
    node.mask &&
    !node.maskContentGrouped &&
    !(node.children?.length === 1 && node.children[0].id === `${node.id}/masked-content`)
  ) {
    const background = {
      type: "rect",
      id: `${node.id}/masked-background`,
      name: "CSS masked background",
      x: 0,
      y: 0,
      w: node.w,
      h: node.h,
      fills: node.fills || [],
      strokes: node.strokes || [],
      radii: node.radii || [0, 0, 0, 0],
    };
    node.children = [
      {
        type: "group",
        id: `${node.id}/masked-content`,
        name: "CSS masked contents",
        children: [background, ...(node.children || [])],
      },
    ];
    node.fills = [];
    node.strokes = [];
    node.maskContentGrouped = true;
  }
  // Each DOM Range line already has the browser's line breaks. Prevent a second
  // Figma wrap caused by small differences in font metrics; keep its measured origin.
  if (node.type === "text" && /\/text\d+\/line\d+$/.test(node.id || "")) node.sizing = "width";
  if (node.children)
    node.children = node.children
      .map((n, i) => ({ n, i }))
      .sort(
        (a, b) =>
          Number(b.n.id === node.id?.replace(/\/masked-content$/, "/masked-background")) -
            Number(a.n.id === node.id?.replace(/\/masked-content$/, "/masked-background")) ||
          (a.n.cssZIndex || 0) - (b.n.cssZIndex || 0) ||
          (a.n.name === "::before" ? -1 : a.n.name === "::after" ? 1 : 0) -
            (b.n.name === "::before" ? -1 : b.n.name === "::after" ? 1 : 0) ||
          a.i - b.i,
      )
      .map((x) => x.n);
  if (node.stops)
    for (const stop of node.stops)
      if (stop.opacity === 0) {
        const nearest = node.stops
          .filter((s) => s.opacity > 0)
          .sort(
            (a, b) => Math.abs(a.position - stop.position) - Math.abs(b.position - stop.position),
          )[0];
        if (nearest) stop.color = nearest.color;
      }
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach(normalizeCapture);
    else if (value && typeof value === "object") normalizeCapture(value);
  return node;
}
