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

/**
 * Give every node and domain a fixed position.
 *
 * Domains take angular sectors sized by how many connected files they hold, so
 * a big domain is visibly big. Files sit at even angles inside their own
 * sector. Computed once from the graph and never recomputed per view — that is
 * what guarantees nothing moves.
 *
 * @param {number} gap  radians of blank between sectors, so groups read as groups
 */
export function layout(graph, { cx = 0, cy = 0, rDomain = 96, rFile = 186, gap = 0.22, start = -Math.PI / 2 } = {}) {
  const nodes = new Map();
  const domains = new Map();

  const total = graph.nodes.length;
  if (total === 0) return { nodes, domains };

  // Whatever is not spent on gaps is shared out one slice per file.
  const perFile = (Math.PI * 2 - graph.domains.length * gap) / total;

  let angle = start;
  for (const domain of graph.domains) {
    const mine = graph.nodes.filter((n) => n.domain === domain);
    const from = angle;

    mine.forEach((n, i) => {
      const a = from + (i + 0.5) * perFile;
      nodes.set(n.path, { angle: a, x: cx + Math.cos(a) * rFile, y: cy + Math.sin(a) * rFile });
    });

    const to = from + mine.length * perFile;
    const mid = (from + to) / 2;
    domains.set(domain, {
      angle: mid,
      from,
      to,
      count: mine.length,
      x: cx + Math.cos(mid) * rDomain,
      y: cy + Math.sin(mid) * rDomain,
    });

    angle = to + gap;
  }

  return { nodes, domains, centre: { x: cx, y: cy } };
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
 * @param {{mode: 'domains'|'domain'|'file'|'full', domain?: string, path?: string}} view
 */
export function scene(graph, positions, view) {
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
    if (!focus) return scene(graph, positions, { mode: "domains" });

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
