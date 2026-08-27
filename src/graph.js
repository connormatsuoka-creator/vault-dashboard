// graph.js
//
// The connections graph — mechanics only, no drawing.
//
// This module answers "what should be on screen, where, and how emphasised",
// and stops there. It emits a *scene*: plain data the renderer turns into
// shapes. That seam is deliberate and load-bearing. The visual here is a
// placeholder like tokens.css; the drill-down behaviour is not. Replacing the
// look should mean rewriting draw calls and nothing else — no layout maths, no
// view state, no re-deciding what a click does.
//
// THE PROPERTY THE WHOLE THING RESTS ON:
//
//   Every file owns a permanent angle inside its domain's sector. Drilling in,
//   focusing, and coming back never move a node.
//
// That is what makes exploring orientating instead of disorienting, and it is
// why this needs no physics simulation — the layout is deterministic maths,
// which also makes it testable in Node. A force-directed layout would put the
// whole mechanic behind a tuning exercise that can only be judged in a browser.

const ROOT = "(root)";

/**
 * @typedef {Object} GraphNode
 * @property {string} path
 * @property {string} name
 * @property {string} domain
 * @property {number} degree  - undirected, deduped
 */

/**
 * Reduce the model to what a graph needs.
 *
 * Links are collapsed to undirected unique pairs: A→B and B→A are one edge, and
 * a file linking twice to the same target is one edge. Only resolved links
 * count — a broken link points at no node, so there is nothing to draw it to.
 *
 * Files with no links either way are separated out rather than positioned.
 * Five unconnected dots teach nothing; "6 files have no links" is the finding,
 * and in this vault it is true by design — index files list their contents as
 * `` `capture.md` ``, not as wiki-links, so they never enter the graph.
 */
export function buildGraph(model) {
  const degree = new Map(model.files.map((f) => [f.path, 0]));
  const seen = new Set();
  const edges = [];

  for (const link of model.links) {
    if (link.status !== "resolved") continue;
    if (link.from === link.resolvedPath) continue; // a file linking to itself
    const key = [link.from, link.resolvedPath].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a: link.from, b: link.resolvedPath });
    degree.set(link.from, degree.get(link.from) + 1);
    degree.set(link.resolvedPath, degree.get(link.resolvedPath) + 1);
  }

  const all = model.files.map((f) => ({
    path: f.path,
    name: f.name,
    domain: f.domain || ROOT,
    degree: degree.get(f.path) ?? 0,
  }));

  const nodes = all.filter((n) => n.degree > 0);
  const isolated = all.filter((n) => n.degree === 0);

  // Domains in a stable order, holding only their connected files.
  const domains = [...new Set(nodes.map((n) => n.domain))].sort();

  // How many links run between each pair of domains — the top-level view draws
  // these, because "32 of 49 links cross a domain boundary" is the finding this
  // vault actually has.
  const domainWeights = new Map();
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  for (const e of edges) {
    const a = byPath.get(e.a)?.domain;
    const b = byPath.get(e.b)?.domain;
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join("|");
    domainWeights.set(key, (domainWeights.get(key) ?? 0) + 1);
  }

  const adjacency = new Map(nodes.map((n) => [n.path, []]));
  for (const e of edges) {
    if (!adjacency.has(e.a) || !adjacency.has(e.b)) continue;
    adjacency.get(e.a).push(e.b);
    adjacency.get(e.b).push(e.a);
  }

  return { nodes, edges, isolated, domains, domainWeights, adjacency, byPath };
}

/** Paths linked to this one, in a stable order. */
export function neighbours(graph, path) {
  return [...(graph.adjacency.get(path) ?? [])].sort();
}

/** Guaranteed arc distance between two adjacent moons, in px. */
const MOON_GAP = 30;
/** Clear space between a planet's limb and its own moons. */
const PLANET_CLEAR = 16;

/**
 * Give every node and domain a fixed position: a solar system.
 *
 * Domains are PLANETS on one orbit around a centre; the files in a domain are
 * MOONS on that planet's own orbit. Computed once from the graph and never
 * recomputed per view — which is what guarantees nothing moves, and is the
 * property the whole drill-down mechanic rests on.
 *
 * Two rules keep a crowded domain from becoming a smear, and they compose:
 *
 *   1. A moon orbit is whatever radius GUARANTEES MOON_GAP between adjacent
 *      moons. Eight files therefore get a wider orbit than two, and the spacing
 *      between moons is identical on every planet rather than varying with how
 *      full the domain happens to be.
 *
 *   2. Angular room around the centre is allocated by each planet's FOOTPRINT —
 *      the radius rule 1 just produced — and not by its file count. So the
 *      planet that needs the most room gets it, and no two moon systems can
 *      overlap however lopsided the vault becomes.
 *
 * Rule 2 replaced an earlier "sector proportional to file count", which sized
 * the planet but not the room its moons needed, so a dense domain still
 * crowded. Proportionality is preserved in the thing that carries it — a
 * planet's radius, and its orbit — rather than in the angle.
 */
export function layout(graph, { cx = 0, cy = 0, rOrbit = 178, start = -Math.PI / 2 } = {}) {
  const nodes = new Map();
  const domains = new Map();
  const centre = { x: cx, y: cy };

  if (graph.nodes.length === 0) return { nodes, domains, centre };

  // 1. Size each planet, and derive the orbit its moons need.
  const planets = graph.domains.map((name) => {
    const mine = graph.nodes.filter((n) => n.domain === name);
    const r = 8 + mine.length * 1.5;
    return { name, mine, r, moonR: Math.max(r + PLANET_CLEAR, (mine.length * MOON_GAP) / (Math.PI * 2)) };
  });

  // 2. Share the circle out by footprint.
  const footprint = planets.reduce((sum, d) => sum + d.moonR, 0);

  let angle = start;
  for (const planet of planets) {
    const sweep = (planet.moonR / footprint) * Math.PI * 2;
    const from = angle;
    const to = from + sweep;
    const mid = from + sweep / 2;
    const x = cx + Math.cos(mid) * rOrbit;
    const y = cy + Math.sin(mid) * rOrbit;

    // Moons start on the far side of the planet from the star, so the first one
    // is never hidden behind the planet's own label.
    planet.mine.forEach((n, i) => {
      const t = mid + Math.PI + ((i + 0.5) / planet.mine.length) * Math.PI * 2;
      nodes.set(n.path, {
        angle: t,
        x: x + Math.cos(t) * planet.moonR,
        y: y + Math.sin(t) * planet.moonR,
        domain: planet.name,
        // Where its planet is, so a renderer can orient a label outward from
        // the moon system rather than from the distant centre.
        px: x,
        py: y,
      });
    });

    domains.set(planet.name, {
      angle: mid,
      from,
      to,
      count: planet.mine.length,
      r: planet.r,
      moonR: planet.moonR,
      x,
      y,
    });

    angle = to;
  }

  return { nodes, domains, centre };
}

/**
 * What to show for a given view.
 *
 * Four modes over one layout. The renderer receives positions and states and
 * draws them — it decides nothing.
 *
 *   domains  the six domains, chorded by how much they reference each other
 *   domain   one domain opened, showing its files and their internal links
 *   file     one file and everything linked to it, wherever that lives
 *   full     all of it
 *
 * A date window, when one is brushed, is applied on top as a SECOND and
 * independent field. It is not a fifth mode and not another value in `state`,
 * because the two answer different questions: `state` says what the mode asked
 * for, `inWindow` says whether the thing was happening then. A file can be
 * muted by its mode and inside the window at once, and collapsing that into one
 * field would force a precedence rule between two things that do not conflict.
 * Keeping them apart is what lets the brush compose with all four modes instead
 * of replacing them.
 *
 * @param {{mode: 'domains'|'domain'|'file'|'full', domain?: string, path?: string,
 *          window?: {from: number, to: number}}} view
 * @param {Map<string, {from: number, to: number}>|null} spans - from trackSpans
 */
export function scene(graph, positions, view, spans = null) {
  return applyWindow(buildScene(graph, positions, view), graph, view?.window, spans);
}

function buildScene(graph, positions, view) {
  const mode = view?.mode ?? "domains";
  const at = (path) => positions.nodes.get(path);
  const centre = positions.centre ?? { x: 0, y: 0 };

  const node = (n, state) => ({ ...n, ...at(n.path), state });
  const domainAt = (name, state) => ({ name, ...positions.domains.get(name), state });
  const edge = (a, b, state) => {
    const pa = at(a);
    const pb = at(b);
    const crossDomain = graph.byPath.get(a).domain !== graph.byPath.get(b).domain;
    return { a, b, from: pa, to: pb, via: centre, crossDomain, state };
  };

  const base = { mode, centre, isolated: graph.isolated.length, domainChords: [] };

  if (mode === "domains") {
    return {
      ...base,
      caption: `${graph.domains.length} domains · chord weight is links between them`,
      domains: graph.domains.map((d) => domainAt(d, "plain")),
      nodes: [],
      edges: [],
      domainChords: [...graph.domainWeights].map(([key, weight]) => {
        const [a, b] = key.split("|");
        return { a, b, from: positions.domains.get(a), to: positions.domains.get(b), via: centre, weight };
      }),
    };
  }

  if (mode === "domain") {
    const mine = graph.nodes.filter((n) => n.domain === view.domain);
    const inside = new Set(mine.map((n) => n.path));
    return {
      ...base,
      caption: `${view.domain} — ${mine.length} files, links within the domain`,
      domains: graph.domains.map((d) => domainAt(d, d === view.domain ? "focus" : "muted")),
      nodes: mine.map((n) => node(n, "plain")),
      edges: graph.edges
        .filter((e) => inside.has(e.a) && inside.has(e.b))
        .map((e) => edge(e.a, e.b, "plain")),
    };
  }

  if (mode === "file") {
    const focus = graph.byPath.get(view.path);
    if (!focus) return buildScene(graph, positions, { mode: "domains" });

    const linked = neighbours(graph, view.path);
    const shown = new Set([view.path, ...linked]);
    const crossing = linked.filter((p) => graph.byPath.get(p).domain !== focus.domain).length;

    return {
      ...base,
      caption:
        `${focus.name} — ${linked.length} link${linked.length === 1 ? "" : "s"}` +
        (crossing ? `, ${crossing} from other domains` : ""),
      domains: graph.domains.map((d) => domainAt(d, d === focus.domain ? "focus" : "muted")),
      nodes: graph.nodes.filter((n) => shown.has(n.path)).map((n) => node(n, n.path === view.path ? "focus" : "plain")),
      edges: linked.map((p) =>
        edge(view.path, p, graph.byPath.get(p).domain !== focus.domain ? "emphasis" : "plain")
      ),
    };
  }

  // full
  const crossing = graph.edges.filter((e) => graph.byPath.get(e.a).domain !== graph.byPath.get(e.b).domain).length;
  return {
    ...base,
    caption: `${graph.nodes.length} linked files · ${graph.edges.length} links · ${crossing} cross a domain`,
    domains: graph.domains.map((d) => domainAt(d, "plain")),
    nodes: graph.nodes.map((n) => node(n, "plain")),
    edges: graph.edges.map((e) =>
      edge(e.a, e.b, graph.byPath.get(e.a).domain !== graph.byPath.get(e.b).domain ? "emphasis" : "plain")
    ),
  };
}

/**
 * Stamp a date window across a built scene.
 *
 * Three states, and the third is the point:
 *
 *   true   dated, and live at some moment inside the window
 *   false  dated, and not
 *   null   UNDATED, and therefore never dimmed
 *
 * 15 of the vault's 36 files carry no event date. Dimming them for a window
 * would assert they were ABSENT during it, which the data does not support —
 * the same error as promoting `updated:` to an event date. Absence of a date is
 * not absence from a window, so they stay lit and stay honest.
 *
 * Membership is OVERLAP, not containment. Silvia AI ran 2026-06 to 2026-08;
 * asking what was happening in August has to include it. Containment would hide
 * precisely the long-running things a window is most useful for finding.
 *
 * Domains are judged from every file they own rather than from the nodes this
 * mode happens to draw, because the domains view draws no nodes at all and is
 * the view where the window says the most: which parts of the vault were alive
 * at once. A domain holding no dated files is null, not false — the same rule
 * as a file, one level up.
 */
function applyWindow(built, graph, window, spans) {
  if (!window || !spans) {
    return {
      ...built,
      window: null,
      nodes: built.nodes.map((n) => ({ ...n, inWindow: null })),
      edges: built.edges.map((e) => ({ ...e, inWindow: null })),
      domains: built.domains.map((d) => ({ ...d, inWindow: null })),
    };
  }

  const overlaps = (span) => span.from <= window.to && span.to >= window.from;
  const forPath = (path) => {
    const span = spans.get(path);
    return span ? overlaps(span) : null;
  };

  const forDomain = (name) => {
    const dated = graph.nodes.filter((n) => n.domain === name).map((n) => spans.get(n.path)).filter(Boolean);
    return dated.length === 0 ? null : dated.some(overlaps);
  };

  const nodes = built.nodes.map((n) => ({ ...n, inWindow: forPath(n.path) }));

  // An edge dims only when BOTH ends are out. A link from a file inside the
  // window to one outside is the most informative thing the brush surfaces —
  // and dimming every edge touching an excluded file would leave a lit node
  // looking unconnected, which is a false claim about the graph.
  const edges = built.edges.map((e) => ({
    ...e,
    inWindow: forPath(e.a) !== false || forPath(e.b) !== false,
  }));

  const judged = graph.nodes.map((n) => forPath(n.path));
  const inside = judged.filter((v) => v === true).length;
  const dated = judged.filter((v) => v !== null).length;
  const undated = judged.length - dated;

  return {
    ...built,
    window,
    nodes,
    edges,
    domains: built.domains.map((d) => ({ ...d, inWindow: forDomain(d.name) })),
    caption:
      `${built.caption} · window holds ${inside}/${dated} dated` +
      (undated ? `, ${undated} undated stay lit` : ""),
  };
}
