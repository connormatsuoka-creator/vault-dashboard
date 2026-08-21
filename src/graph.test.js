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

test("sectors are proportional to file count and never overlap", () => {
  const p = layout(G, { gap: 0.2 });
  const spans = [...p.domains.values()].map((d) => d.to - d.from);
  const totalSpan = spans.reduce((a, b) => a + b, 0);
  const expected = Math.PI * 2 - p.domains.size * 0.2;
  assert.ok(Math.abs(totalSpan - expected) < 1e-9, "sectors plus gaps must fill the circle");

  const ordered = [...p.domains.values()].sort((a, b) => a.from - b.from);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].from >= ordered[i - 1].to, "sectors overlap");
  }
  // self has 2 connected files, system has 1 — so its sector is twice as wide.
  assert.ok(Math.abs(p.domains.get("self").to - p.domains.get("self").from -
    2 * (p.domains.get("system").to - p.domains.get("system").from)) < 1e-9);
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
