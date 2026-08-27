// sky.test.js
//
// Run with:  node --test src/sky.test.js
//
// The property that matters here is determinism. renderGraph runs again on
// every view change, so a starfield that varies between calls makes the sky
// shimmer whenever you drill into a domain — which reads as the whole diagram
// twitching, and is exactly the class of bug that is obvious once seen and
// invisible in review.

import test from "node:test";
import assert from "node:assert/strict";

import { starfield, planetLighting, planetToken } from "./sky.js";

const FIELD = { width: 1000, height: 600, count: 200 };

test("the same seed gives the same sky, every time", () => {
  const a = starfield({ ...FIELD, seed: 41 });
  const b = starfield({ ...FIELD, seed: 41 });
  assert.deepEqual(a, b, "a re-render would reshuffle the stars");
});

test("a different seed gives a different sky", () => {
  const a = starfield({ ...FIELD, seed: 41 });
  const b = starfield({ ...FIELD, seed: 42 });
  assert.notDeepEqual(a, b);
});

test("every star lands inside the world it was asked for", () => {
  const stars = starfield({ x: -200, y: -100, width: 1200, height: 800, count: 500, seed: 7 });
  for (const s of stars) {
    assert.ok(s.x >= -200 && s.x <= 1000, `x ${s.x} outside the field`);
    assert.ok(s.y >= -100 && s.y <= 700, `y ${s.y} outside the field`);
  }
});

test("most stars are faint and a few are bright", () => {
  // Radius is a squared draw on purpose: an even spread reads as noise or as a
  // texture, not as a sky.
  const stars = starfield({ ...FIELD, count: 600, seed: 13 });
  const radii = stars.map((s) => s.r).sort((a, b) => a - b);
  const median = radii[Math.floor(radii.length / 2)];
  const brightest = radii[radii.length - 1];
  assert.ok(median < brightest / 2.5, `median ${median} is not far below the brightest ${brightest}`);
  assert.ok(stars.every((s) => s.opacity > 0 && s.opacity <= 0.55));
});

test("a star carries a tint index, never a colour", () => {
  // Colour lives in tokens.css. A literal here would break the promise that a
  // re-theme means editing one file.
  const stars = starfield({ ...FIELD, count: 50, seed: 3 });
  for (const s of stars) {
    assert.ok(Number.isInteger(s.tint) && s.tint >= 0 && s.tint < 3);
    assert.ok(!Object.values(s).some((v) => typeof v === "string" && v.includes("#")));
  }
});

test("a planet is lit from the star, not from the viewer", () => {
  const centre = { x: 100, y: 100 };
  // A planet to the RIGHT of the star is lit on its left limb — the side
  // facing inward — so the gradient's bright point sits below 50%.
  const right = planetLighting({ x: 200, y: 100 }, centre);
  assert.ok(right.cx < 50, "bright point should face the star");
  assert.equal(right.cy, 50);

  const left = planetLighting({ x: 0, y: 100 }, centre);
  assert.ok(left.cx > 50, "a planet on the other side is lit from the other limb");

  const below = planetLighting({ x: 100, y: 200 }, centre);
  assert.ok(below.cy < 50);
  assert.equal(below.cx, 50);
});

test("a planet sitting on the star does not divide by zero", () => {
  assert.deepEqual(planetLighting({ x: 5, y: 5 }, { x: 5, y: 5 }), { cx: 50, cy: 50 });
});

test("planet tokens index the palette and wrap rather than running out", () => {
  assert.deepEqual([0, 1, 5].map((i) => planetToken(i)), [1, 2, 6]);
  // A vault that grows a seventh domain must not get an undefined colour.
  assert.equal(planetToken(6), 1);
  assert.equal(planetToken(13), 2);
});
