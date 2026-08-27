// graph.test.js
//
// Run with:  node --test src/graph.test.js
//
// The graph is pure maths precisely so it can be tested here rather than judged
// by eye in a browser. The central assertion is position stability — if nodes
// move between views, drilling in stops being exploration and becomes a
// reshuffle, and no amount of visual polish fixes that.

import test from "node:test";
import assert from "node:assert/strict";

import { buildModel } from "./model.js";
import { buildGraph, layout, scene, neighbours } from "./graph.js";

const fm = (owns = "t") => `---\nupdated: 2026-08-21\nstatus: hot\nowns: [${owns}]\n---\n`;

/** Two domains, a cross-domain link, a mutual pair, a self-link and an orphan. */
const VAULT = buildModel([
  { path: "self/a.md", text: fm("a") + "\nlinks `[[self/b]]` and `[[system/x]]`\n" },
  { path: "self/b.md", text: fm("b") + "\nlinks back `[[self/a]]`\n" },          // mutual with a
  { path: "self/c.md", text: fm("c") + "\nlinks `[[self/c]]` itself\n" },        // self-link only
  { path: "system/x.md", text: fm("x") + "\nlinks `[[self/a]]` and `[[nowhere]]`\n" }, // one broken
  { path: "system/_index.md", text: fm("i") + "\nno wiki links, just `x.md`\n" },
]);

const G = buildGraph(VAULT);

/**
 * Deliberately lopsided: eight files against two. The vault's real shape is
 * 8/7/7/7/3/2, and a crowding bug hides completely in a fixture where every
 * domain is the same size.
 */
const LOPSIDED = buildGraph(
  buildModel([
    ...Array.from({ length: 8 }, (_, i) => ({
      path: `big/f${i}.md`,
      text: fm(`big${i}`) + `\nlinks \`[[small/s0]]\`\n`,
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      path: `small/s${i}.md`,
      text: fm(`small${i}`) + `\nlinks \`[[big/f0]]\`\n`,
    })),
  ])
);

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

test("bidirectional links collapse to one edge", () => {
  // a<->b is mutual, a<->x is mutual. Two edges, not four.
  assert.equal(G.edges.length, 2);
  assert.equal(G.byPath.get("self/a.md").degree, 2);
  assert.equal(G.byPath.get("self/b.md").degree, 1);
});

test("self-links and broken links create no edges", () => {
  assert.ok(!G.byPath.has("self/c.md"), "c links only to itself, so it is not connected");
  assert.ok(!G.edges.some((e) => e.a === e.b));
  assert.ok(!G.edges.some((e) => [e.a, e.b].includes("nowhere.md")));
});

test("files with no links are separated, not positioned", () => {
  const paths = G.isolated.map((n) => n.path).sort();
  assert.deepEqual(paths, ["self/c.md", "system/_index.md"]);
  assert.equal(G.nodes.length, 3);
});

test("domain weights count only links that cross a domain", () => {
  // self/a <-> system/x crosses. self/a <-> self/b does not.
  assert.deepEqual([...G.domainWeights.entries()], [["self|system", 1]]);
});

test("neighbours are stable and sorted", () => {
  assert.deepEqual(neighbours(G, "self/a.md"), ["self/b.md", "system/x.md"]);
  assert.deepEqual(neighbours(G, "nope.md"), []);
});

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

test("every connected node gets a position, and no isolated one does", () => {
  const p = layout(G);
  assert.equal(p.nodes.size, G.nodes.length);
  for (const n of G.isolated) assert.equal(p.nodes.get(n.path), undefined);
});

test("sectors fill the circle and never overlap", () => {
  const p = layout(G);
  const spans = [...p.domains.values()].map((d) => d.to - d.from);
  const total = spans.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-9, "sectors must fill the circle exactly");

  const ordered = [...p.domains.values()].sort((a, b) => a.from - b.from);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].from >= ordered[i - 1].to - 1e-9, "sectors overlap");
  }
});

test("a bigger domain gets a bigger planet and a wider moon orbit", () => {
  // Proportionality did not go away when angle stopped carrying it — it moved
  // to the thing that can carry it without crowding.
  const p = layout(LOPSIDED);
  const big = p.domains.get("big");
  const small = p.domains.get("small");
  assert.ok(big.count > small.count, "fixture is not actually lopsided");
  assert.ok(big.r > small.r, "the fuller domain must be the bigger planet");
  assert.ok(big.moonR > small.moonR, "the fuller domain must have the wider orbit");
});

test("adjacent moons are never closer than the guaranteed gap", () => {
  // The rule the layout exists to enforce: spacing is identical on every
  // planet, however full it is. Eight files get a wider orbit, not a tighter
  // ring.
  const p = layout(LOPSIDED);
  for (const [name, d] of p.domains) {
    if (d.count < 2) continue;
    const arc = (2 * Math.PI * d.moonR) / d.count;
    assert.ok(arc >= 30 - 1e-9, `${name}: moons ${arc.toFixed(1)}px apart, under the 30px floor`);
  }
});

test("no two moon systems overlap, however lopsided the vault", () => {
  // This is what allocating angle by footprint buys. Allocating by file count
  // instead put a small domain's moons through its neighbour's.
  const p = layout(LOPSIDED);
  const all = [...p.domains.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const apart = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(
        apart > a.moonR + b.moonR,
        `moon systems overlap: ${apart.toFixed(0)}px apart, footprints ${(a.moonR + b.moonR).toFixed(0)}px`
      );
    }
  }
});

test("every moon orbits its own planet, not the centre", () => {
  const p = layout(LOPSIDED);
  for (const [path, n] of p.nodes) {
    const d = p.domains.get(n.domain);
    const fromPlanet = Math.hypot(n.x - d.x, n.y - d.y);
    assert.ok(Math.abs(fromPlanet - d.moonR) < 1e-6, `${path} is not on its planet's orbit`);
  }
});

test("an empty graph lays out without throwing", () => {
  const empty = buildGraph(buildModel([{ path: "a.md", text: "no frontmatter, no links\n" }]));
  const p = layout(empty);
  assert.equal(p.nodes.size, 0);
  assert.doesNotThrow(() => scene(empty, p, { mode: "full" }));
});

// ---------------------------------------------------------------------------
// The mechanic: nothing moves
// ---------------------------------------------------------------------------

test("a node sits at the same point in every view it appears in", () => {
  const p = layout(G);
  const views = [
    { mode: "domains" },
    { mode: "domain", domain: "self" },
    { mode: "domain", domain: "system" },
    { mode: "file", path: "self/a.md" },
    { mode: "file", path: "system/x.md" },
    { mode: "full" },
  ];

  const seen = new Map();
  for (const v of views) {
    for (const n of scene(G, p, v).nodes) {
      const at = `${n.x},${n.y}`;
      if (seen.has(n.path)) {
        assert.equal(at, seen.get(n.path), `${n.path} moved in ${JSON.stringify(v)}`);
      } else {
        seen.set(n.path, at);
      }
    }
  }
  assert.ok(seen.size > 0, "the views showed no nodes at all");
});

test("domain markers are also fixed across views", () => {
  const p = layout(G);
  const first = new Map(scene(G, p, { mode: "domains" }).domains.map((d) => [d.name, `${d.x},${d.y}`]));
  for (const v of [{ mode: "domain", domain: "self" }, { mode: "file", path: "system/x.md" }, { mode: "full" }]) {
    for (const d of scene(G, p, v).domains) {
      assert.equal(`${d.x},${d.y}`, first.get(d.name), `domain ${d.name} moved`);
    }
  }
});

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

const P = layout(G);

test("domains view shows chords and no files", () => {
  const s = scene(G, P, { mode: "domains" });
  assert.equal(s.nodes.length, 0);
  assert.equal(s.edges.length, 0);
  assert.equal(s.domainChords.length, 1);
  assert.equal(s.domainChords[0].weight, 1);
});

test("domain view shows only that domain's files and internal links", () => {
  const s = scene(G, P, { mode: "domain", domain: "self" });
  assert.deepEqual(s.nodes.map((n) => n.path).sort(), ["self/a.md", "self/b.md"]);
  assert.equal(s.edges.length, 1, "the cross-domain link belongs to neither domain view");
  assert.equal(s.domains.find((d) => d.name === "self").state, "focus");
  assert.equal(s.domains.find((d) => d.name === "system").state, "muted");
});

test("file view shows the focus plus everything linked to it, wherever it lives", () => {
  const s = scene(G, P, { mode: "file", path: "self/a.md" });
  assert.deepEqual(s.nodes.map((n) => n.path).sort(), ["self/a.md", "self/b.md", "system/x.md"]);
  assert.equal(s.nodes.find((n) => n.path === "self/a.md").state, "focus");
  const cross = s.edges.find((e) => e.b === "system/x.md");
  assert.equal(cross.crossDomain, true);
  assert.equal(cross.state, "emphasis", "a link out of the domain is the interesting one");
  assert.match(s.caption, /1 from other domains/);
});

test("a file view for a path that is not in the graph falls back rather than blanking", () => {
  const s = scene(G, P, { mode: "file", path: "self/c.md" }); // isolated
  assert.equal(s.mode, "domains");
});

test("full view shows everything and marks the crossings", () => {
  const s = scene(G, P, { mode: "full" });
  assert.equal(s.nodes.length, 3);
  assert.equal(s.edges.length, 2);
  assert.equal(s.edges.filter((e) => e.state === "emphasis").length, 1);
});

test("every scene reports how many files are unconnected", () => {
  for (const v of [{ mode: "domains" }, { mode: "domain", domain: "self" }, { mode: "full" }]) {
    assert.equal(scene(G, P, v).isolated, 2);
  }
});

test("every edge carries both endpoints and the centre it curves through", () => {
  // The renderer draws chords without knowing the layout — it must be handed
  // everything, or the visual and the maths start disagreeing.
  for (const e of scene(G, P, { mode: "full" }).edges) {
    for (const p of [e.from, e.to, e.via]) {
      assert.equal(typeof p.x, "number");
      assert.equal(typeof p.y, "number");
    }
  }
});

// ---------------------------------------------------------------------------
// The brush — a date window laid across the modes
//
// Dates never reach this module. It is handed plain intervals, and a path that
// is absent from them is undated, which is its own case rather than a gap.
// ---------------------------------------------------------------------------

const d = (iso) => Date.parse(iso + "T00:00:00Z");

/** self/a ran through mid-2024, self/b for three weeks of 2026. system/x is undated. */
const SPANS = new Map([
  ["self/a.md", { from: d("2024-06-01"), to: d("2024-08-01") }],
  ["self/b.md", { from: d("2026-08-01"), to: d("2026-08-20") }],
]);
const WIN_2024 = { from: d("2024-07-01"), to: d("2024-07-15") };
const WIN_2026 = { from: d("2026-08-05"), to: d("2026-08-10") };
const MODES = [
  { mode: "domains" },
  { mode: "domain", domain: "self" },
  { mode: "file", path: "self/a.md" },
  { mode: "full" },
];
const at = (s) => [...s.nodes, ...s.domains].map((p) => `${p.path ?? p.name}:${p.x},${p.y}`).join("|");
const node = (s, path) => s.nodes.find((n) => n.path === path);
const dom = (s, name) => s.domains.find((x) => x.name === name);

test("a window moves nothing — the invariant the whole mechanic rests on", () => {
  for (const view of MODES) {
    const plain = scene(G, P, view);
    const brushed = scene(G, P, { ...view, window: WIN_2024 }, SPANS);
    assert.equal(at(brushed), at(plain), `${view.mode} moved under a brush`);
  }
});

test("the window composes with the mode instead of replacing it", () => {
  for (const view of MODES) {
    const plain = scene(G, P, view);
    const brushed = scene(G, P, { ...view, window: WIN_2024 }, SPANS);
    assert.deepEqual(brushed.nodes.map((n) => n.state), plain.nodes.map((n) => n.state), view.mode);
    assert.deepEqual(brushed.domains.map((x) => x.state), plain.domains.map((x) => x.state), view.mode);
  }
  // And the two fields genuinely disagree, which is why they are two fields:
  // self/b is drawn plainly by its mode and sits outside the window at once.
  const b = node(scene(G, P, { mode: "domain", domain: "self", window: WIN_2024 }, SPANS), "self/b.md");
  assert.equal(b.state, "plain");
  assert.equal(b.inWindow, false);
});

test("an undated file is never dimmed by a window", () => {
  // 15 of the vault's 36 files carry no event date. Dimming them would assert
  // they were absent during the window, which the data does not support.
  const s = scene(G, P, { mode: "full", window: WIN_2024 }, SPANS);
  assert.equal(node(s, "system/x.md").inWindow, null);
  // null is a real third state, not an unset one — a dated file outside is false.
  assert.equal(node(s, "self/a.md").inWindow, true);
  assert.equal(node(s, "self/b.md").inWindow, false);
});

test("a window selects by overlap, not containment", () => {
  // self/a runs June to August and the window is a fortnight inside it, holding
  // neither end. Containment would drop exactly the long-running things a
  // window is most useful for finding.
  assert.equal(node(scene(G, P, { mode: "full", window: WIN_2024 }, SPANS), "self/a.md").inWindow, true);
  // Touching at a single instant counts: the boundary is closed at both ends.
  const touch = { from: d("2024-08-01"), to: d("2024-09-01") };
  assert.equal(node(scene(G, P, { mode: "full", window: touch }, SPANS), "self/a.md").inWindow, true);
  const clear = { from: d("2024-08-02"), to: d("2024-09-01") };
  assert.equal(node(scene(G, P, { mode: "full", window: clear }, SPANS), "self/a.md").inWindow, false);
});

test("a domain is judged by every file it owns, not by the nodes drawn", () => {
  // The domains view draws no nodes at all and is where the window says the
  // most — which parts of the vault were alive at the same time. So a planet
  // has to know things this scene never drew.
  const s = scene(G, P, { mode: "domains", window: WIN_2026 }, SPANS);
  assert.equal(s.nodes.length, 0);
  assert.equal(dom(s, "self").inWindow, true);
  // system holds one file, undated — null, not false. Same rule as a file, one
  // level up: no date is not the same as not then.
  assert.equal(dom(s, "system").inWindow, null);

  const dated = new Map([...SPANS, ["system/x.md", { from: d("2020-01-01"), to: d("2020-02-01") }]]);
  assert.equal(dom(scene(G, P, { mode: "domains", window: WIN_2026 }, dated), "system").inWindow, false);
});

test("an edge dims only when both of its ends are out", () => {
  // a is inside the window and b is not. Dimming the link between them would
  // leave a lit node looking unconnected, which is a false claim about the graph.
  const s = scene(G, P, { mode: "full", window: WIN_2024 }, SPANS);
  assert.equal(s.edges.every((e) => e.inWindow === true), true);

  const both = new Map([
    ["self/a.md", { from: d("2026-01-01"), to: d("2026-01-02") }],
    ["self/b.md", { from: d("2026-01-01"), to: d("2026-01-02") }],
  ]);
  const out = scene(G, P, { mode: "full", window: WIN_2024 }, both);
  const ab = out.edges.find((e) => [e.a, e.b].includes("self/b.md"));
  assert.equal(ab.inWindow, false, "both ends outside should dim");
  // a -- x survives, because x is undated and undated is never out.
  assert.equal(out.edges.find((e) => [e.a, e.b].includes("system/x.md")).inWindow, true);
});

test("with no window brushed, nothing is judged", () => {
  const s = scene(G, P, { mode: "full" });
  assert.equal(s.window, null);
  assert.equal([...s.nodes, ...s.edges, ...s.domains].every((p) => p.inWindow === null), true);
  // A window without spans cannot invent membership out of nothing.
  assert.equal(scene(G, P, { mode: "full", window: WIN_2024 }).window, null);
});

test("the caption counts the window without pretending undated files are out", () => {
  const s = scene(G, P, { mode: "full", window: WIN_2024 }, SPANS);
  assert.match(s.caption, /window holds 1\/2 dated, 1 undated stay lit/);
});
