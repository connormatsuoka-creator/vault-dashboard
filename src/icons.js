// icons.js
//
// The four interface marks, drawn rather than typed.
//
// They used to be text glyphs — ← → ▾ ▸ — which worked only because the page
// ran on a system font stack that happened to carry them. It no longer does:
// U+2190, U+2192, U+25B8 and U+25BE all fall outside the latin subset the
// self-hosted faces ship, so as characters they would silently render in
// whatever face the OS reached for, at a different weight, beside text that
// did not. Nothing would error; it would just look wrong.
//
// They were never really characters anyway. An arrow inside a button is an
// icon, and an icon should scale and recolour with the thing it sits in — which
// is what `stroke: currentColor` gets you and a glyph in a fallback font does
// not.
//
// Drawn on a 16px grid, 1.5 stroke, round caps and joins. The source of truth
// for the shapes is assets/icons/*.svg; these paths are the same geometry
// inlined, because an <img> cannot inherit colour.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Path data, on a 0 0 16 16 grid. */
const PATHS = {
  "arrow-left": ["M13 8H3", "M7 4L3 8l4 4"],
  "arrow-right": ["M3 8h10", "M9 4l4 4-4 4"],
  "chevron-down": ["M4 6.5L8 10.5l4-4"],
  "chevron-right": ["M6.5 4l4 4-4 4"],
};

/**
 * Build one icon.
 *
 * Decorative by default: these always sit beside a text label that already says
 * what the control does, so announcing "arrow right" after "Read postmortem.md"
 * is noise. Pass a `title` only where an icon is genuinely the only label.
 *
 * @param {keyof PATHS} name
 * @param {{size?: number, title?: string}} [options]
 * @returns {SVGElement}
 */
export function icon(name, { size = 14, title } = {}) {
  const paths = PATHS[name];
  if (!paths) throw new Error(`unknown icon: ${name}`);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "icon");

  if (title) {
    const node = document.createElementNS(SVG_NS, "title");
    node.textContent = title;
    svg.append(node);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }

  return svg;
}

/**
 * Replace a control's contents with an icon and a label, in that visual order.
 *
 * Order is a parameter rather than two functions because a back control reads
 * mark-then-label and a forward one reads label-then-mark, and getting that
 * backwards is the kind of thing nobody notices in review.
 *
 * @param {HTMLElement} el
 * @param {keyof PATHS} name
 * @param {string} label
 * @param {'before'|'after'} [side]
 */
export function setIconLabel(el, name, label, side = "before") {
  const text = document.createElement("span");
  text.textContent = label;
  el.replaceChildren(...(side === "before" ? [icon(name), text] : [text, icon(name)]));
}

/**
 * The mark on a health row.
 *
 * Four states, not three. `critical` is drawn as a circle split vertically —
 * warning on the left, failing on the right — because 85% of a cap and 96% of
 * a cap are different problems: one means keep an eye on it, the other means
 * find the cause now, while the fix is still small. One mark meaning both is a
 * mark you learn to ignore.
 *
 * Colour comes from CSS, and a <title> names the state, because a status
 * carried by colour alone is not a status everyone can read.
 *
 * @param {'pass'|'warn'|'critical'|'fail'} status
 */
export function statusDot(status, size = 11) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `dot dot--${status}`);
  svg.setAttribute("role", "img");

  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = {
    pass: "passing",
    warn: "warning",
    critical: "close to failing",
    fail: "needs attention now",
  }[status] ?? status;
  svg.append(title);

  if (status === "critical") {
    // Two half-discs meeting on the vertical. Same arc, opposite sweep.
    for (const [sweep, half] of [[0, "warn"], [1, "fail"]]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M6 1 A5 5 0 0 ${sweep} 6 11 Z`);
      path.setAttribute("class", `dot-half dot-half--${half}`);
      svg.append(path);
    }
    return svg;
  }

  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "6");
  circle.setAttribute("cy", "6");
  circle.setAttribute("r", "5");
  svg.append(circle);
  return svg;
}
