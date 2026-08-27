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
