// sky.js
//
// The celestial geometry: where the stars sit, and which way a planet is lit.
//
// This is here rather than inside the renderer for one reason: the starfield
// must be DETERMINISTIC. renderGraph runs again on every view change, and a
// field generated from Math.random would reshuffle each time — the stars would
// shimmer whenever you drilled into a domain, which reads as the whole diagram
// twitching. Seeded generation makes the sky a fixed part of the world that the
// camera moves across, which is what it should be.
//
// Being pure also means it is testable in Node, which is where this project has
// consistently caught the things that reading did not.
//
// No colour appears here. `tint` is an index the renderer maps onto tokens, so
// the promise that a re-theme means editing one file survives.

/**
 * A small deterministic generator. Not cryptographic and does not need to be —
 * it needs to be the SAME sequence every call, which Math.random is not.
 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Scatter stars across a rectangle of world space.
 *
 * Generated across the WORLD, not the viewport, so panning the camera reveals
 * different stars rather than the same ones sliding about.
 *
 * Radius is the square of a uniform draw, which clusters most stars near
 * invisible and leaves a few bright — an even distribution reads as noise, or
 * as a texture, rather than as a sky.
 *
 * @returns {Array<{x:number, y:number, r:number, opacity:number, tint:number}>}
 */
export function starfield({ x = 0, y = 0, width, height, count, seed = 41, maxRadius = 1.5 }) {
  const rand = seeded(seed);
  const stars = [];
  for (let i = 0; i < count; i++) {
    const px = x + rand() * width;
    const py = y + rand() * height;
    const size = rand();
    stars.push({
      x: Number(px.toFixed(1)),
      y: Number(py.toFixed(1)),
      r: Number((size * size * maxRadius + 0.28).toFixed(2)),
      opacity: Number((0.1 + size * 0.42).toFixed(2)),
      tint: Math.floor(rand() * 3),
    });
  }
  return stars;
}

/**
 * Where to put a radial gradient's bright point so a planet reads as lit from
 * the star rather than from the viewer.
 *
 * Returned in percent of the element's bounding box, which is what SVG's
 * objectBoundingBox units want. Offset toward the centre, so the bright limb
 * faces inward and the far side falls into its own shadow — the one detail
 * that makes these read as planets rather than as discs.
 *
 * @returns {{cx: number, cy: number}} percent
 */
export function planetLighting(planet, centre, offset = 34) {
  const dx = centre.x - planet.x;
  const dy = centre.y - planet.y;
  const away = Math.hypot(dx, dy);
  if (away === 0) return { cx: 50, cy: 50 };
  return {
    cx: Number((50 + (dx / away) * offset).toFixed(1)),
    cy: Number((50 + (dy / away) * offset).toFixed(1)),
  };
}

/**
 * Which planet token a domain takes.
 *
 * By position in the domain list rather than by name: the vault's domains are
 * discovered, not fixed, so indexing survives one being added or renamed. Wraps
 * past the palette rather than running out.
 */
export function planetToken(index, palette = 6) {
  return (index % palette) + 1;
}
