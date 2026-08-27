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

import { starfield, planetLighting, planetToken, lightingBucket, bucketLighting, dustCloud } from "./sky.js";

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

test("moons in the same direction from the star share a gradient", () => {
  // Thirty moons must not need thirty gradient definitions. Bucketing is what
  // makes reflected light cheap enough to give every one of them.
  const centre = { x: 0, y: 0 };
  const a = lightingBucket({ x: 100, y: 0 }, centre);
  const b = lightingBucket({ x: 200, y: 1 }, centre);
  assert.equal(a, b, "near-identical directions should share a bucket");
  assert.notEqual(a, lightingBucket({ x: 0, y: 100 }, centre));
});

test("a bucket always lands in range, whatever the angle", () => {
  const centre = { x: 50, y: 50 };
  for (let deg = 0; deg < 360; deg += 7) {
    const rad = (deg * Math.PI) / 180;
    const at = { x: 50 + Math.cos(rad) * 90, y: 50 + Math.sin(rad) * 90 };
    const b = lightingBucket(at, centre);
    assert.ok(Number.isInteger(b) && b >= 0 && b < 24, `bucket ${b} out of range at ${deg} degrees`);
  }
});

test("a moon is lit on the limb that faces the star", () => {
  const centre = { x: 0, y: 0 };
  // A moon to the RIGHT of the star is lit on its left limb.
  const right = bucketLighting(lightingBucket({ x: 100, y: 0 }, centre));
  assert.ok(right.cx < 50, "bright point should face the star");
  const left = bucketLighting(lightingBucket({ x: -100, y: 0 }, centre));
  assert.ok(left.cx > 50);
});

// ---------------------------------------------------------------------------
// Dust — an imprecise span end
// ---------------------------------------------------------------------------

test("a dust cloud is the same cloud every render", () => {
  // Same reason as the starfield: the timeline redraws on every filter change,
  // and grains that reshuffle make the row crawl.
  const spec = { x0: 10, x1: 90, height: 9, seed: 3 };
  assert.deepEqual(dustCloud(spec), dustCloud(spec));
});

test("every grain lands inside the stretch it was given", () => {
  const grains = dustCloud({ x0: 40, x1: 120, height: 9, seed: 5 });
  assert.ok(grains.length > 0);
  for (const g of grains) {
    assert.ok(g.x >= 40 && g.x <= 120, `x ${g.x} outside 40..120`);
    assert.ok(g.y >= 0 && g.y <= 9, `y ${g.y} outside the band`);
  }
});

test("dust thickens toward the end that is certain", () => {
  // Semantic, not decorative: nearer the stretch we know was running, the more
  // likely the span was running too.
  const half = (grains, x0, x1) => {
    const mid = (x0 + x1) / 2;
    return [grains.filter((g) => g.x < mid).length, grains.filter((g) => g.x >= mid).length];
  };
  const tail = dustCloud({ x0: 0, x1: 100, height: 9, seed: 11, certainSide: "left" });
  const [tailLeft, tailRight] = half(tail, 0, 100);
  assert.ok(tailLeft > tailRight, "a tail should be densest at its left, beside the core");

  const head = dustCloud({ x0: 0, x1: 100, height: 9, seed: 11, certainSide: "right" });
  const [headLeft, headRight] = half(head, 0, 100);
  assert.ok(headRight > headLeft, "a head should be densest at its right, beside the core");
});

test("a wider stretch gets more grains, not bigger ones", () => {
  const narrow = dustCloud({ x0: 0, x1: 20, height: 9, seed: 2 });
  const wide = dustCloud({ x0: 0, x1: 200, height: 9, seed: 2 });
  assert.ok(wide.length > narrow.length * 5, "density should follow width");
  assert.ok(narrow.length >= 8, "even the narrowest stretch must read as dust, not as a speck");
  const biggest = (g) => Math.max(...g.map((x) => x.r));
  assert.ok(Math.abs(biggest(wide) - biggest(narrow)) < 1.2, "grain size should not scale with width");
});

test("a zero-width or zero-height stretch yields nothing rather than throwing", () => {
  assert.deepEqual(dustCloud({ x0: 50, x1: 50, height: 9 }), []);
  assert.deepEqual(dustCloud({ x0: 0, x1: 100, height: 0 }), []);
  assert.deepEqual(dustCloud({ x0: 100, x1: 20, height: 9 }), []);
});
