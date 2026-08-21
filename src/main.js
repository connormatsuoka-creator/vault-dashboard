// main.js
//
// Wires the modules together and puts the result on screen.
//
// The pipeline is one line of meaning:
//     pickVault() -> readVault() -> buildModel() -> runHealthChecks() -> render
//
// Rendering is deliberately fixed-size: eight check rows whatever the vault
// contains, with detail behind a disclosure. Every check computes over the
// whole vault because that is cheap at any size — but a screen listing every
// result stops being readable long before it stops being fast.

import { isSupported, pickVault, readVault, VaultAccessError } from "./vault-access.js";
import { buildModel, segmentBody } from "./model.js";
import { runHealthChecks, loadThresholds } from "./health.js";
import { searchVault, MAX_RESULTS } from "./search.js";
import { buildGraph, layout, scene } from "./graph.js";

/** Items shown when a check is expanded. Beyond this it says "and N more" —
 *  the point of the panel is a fixed-size default view, and a 500-row list is
 *  not information. */
const MAX_ITEMS_SHOWN = 20;

// ---------------------------------------------------------------------------
// Element references. Looked up once; the shell owns the markup, not this file.
// ---------------------------------------------------------------------------

const els = {
  unsupported: document.getElementById("unsupported"),
  unsupportedDetail: document.getElementById("unsupported-detail"),
  picker: document.getElementById("picker"),
  openVault: document.getElementById("open-vault"),
  error: document.getElementById("error"),
  errorDetail: document.getElementById("error-detail"),
  retry: document.getElementById("retry"),
  loading: document.getElementById("loading"),
  summary: document.getElementById("summary"),
  verdict: document.getElementById("verdict"),
  health: document.getElementById("health"),
  thresholds: document.getElementById("thresholds"),
  counts: document.getElementById("counts"),
  domains: document.getElementById("domains"),
  reload: document.getElementById("reload"),

  viewNav: document.getElementById("view-nav"),
  viewHealth: document.getElementById("view-health"),
  viewBrowse: document.getElementById("view-browse"),
  viewGraph: document.getElementById("view-graph"),

  browse: document.getElementById("browse"),
  search: document.getElementById("search"),
  searchMeta: document.getElementById("search-meta"),
  browseList: document.getElementById("browse-list"),
  fileEmpty: document.getElementById("file-empty"),
  fileView: document.getElementById("file-view"),
  filePath: document.getElementById("file-path"),
  fileBack: document.getElementById("file-back"),
  fileMeta: document.getElementById("file-meta"),
  fileBacklinks: document.getElementById("file-backlinks"),
  fileBody: document.getElementById("file-body"),

  graph: document.getElementById("graph"),
  graphSvg: document.getElementById("graph-svg"),
  graphCaption: document.getElementById("graph-caption"),
  graphNote: document.getElementById("graph-note"),
  graphHome: document.getElementById("graph-home"),
  graphFull: document.getElementById("graph-full"),
  graphOpen: document.getElementById("graph-open"),
};

/** Panels that showOnly arbitrates between. */
const PANELS = ["unsupported", "picker", "error", "loading", "summary", "browse", "graph"];

/** The subset that means "a vault is open" — the switcher belongs to these. */
const VIEWS = { summary: "viewHealth", browse: "viewBrowse", graph: "viewGraph" };

/**
 * Everything the browse view needs to remember. Deliberately small and plain:
 * a path, and the trail that led to it.
 */
const state = {
  model: null,
  path: null,
  history: [],

  // The graph and its layout are computed once per vault. Recomputing per view
  // is what would let nodes drift, which is the one thing the design cannot
  // afford.
  graph: null,
  positions: null,
  view: { mode: "domains" },
};

/**
 * Exactly one panel is visible at a time. Centralising this means no code path
 * can leave two panels showing or none at all — a class of bug that is tedious
 * to chase once several handlers each hide and show things independently.
 */
function showOnly(name) {
  for (const key of PANELS) {
    els[key].hidden = key !== name;
  }

  // The switcher's visibility and its selected state are decided here too. Two
  // functions each owning part of "what is on screen" is how you end up with a
  // nav pointing at a panel that isn't showing.
  els.viewNav.hidden = !(name in VIEWS);
  for (const [view, ref] of Object.entries(VIEWS)) {
    if (name === view) els[ref].setAttribute("aria-current", "page");
    else els[ref].removeAttribute("aria-current");
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

async function openVault() {
  try {
    // Must happen inside the click handler — the browser requires a real user
    // gesture and rejects the call otherwise.
    const handle = await pickVault();

    showOnly("loading");

    const files = await readVault(handle);
    const model = buildModel(files);

    // A different folder is a different vault: the open file and the trail that
    // led to it belong to the old one.
    state.model = model;
    state.path = null;
    state.history = [];
    els.search.value = "";

    state.graph = buildGraph(model);
    state.positions = layout(state.graph, { cx: 360, cy: 258 });
    state.view = { mode: "domains" };

    render(model);
    showOnly("summary");
  } catch (err) {
    // Cancelling the picker is a normal thing to do, not an error worth a panel.
    if (err instanceof VaultAccessError && err.code === "CANCELLED") {
      showOnly("picker");
      return;
    }

    els.errorDetail.textContent =
      err instanceof VaultAccessError ? err.message : `Unexpected error: ${err.message}`;
    showOnly("error");

    // Anything we did not deliberately throw is a real bug. Keep it in the
    // console with its stack rather than reducing it to a friendly message.
    if (!(err instanceof VaultAccessError)) console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(model) {
  // The vault owns these now; health.js only holds a fallback. Read once and
  // pass the same object to both, so the panel can never check against one set
  // of numbers while printing another.
  const thresholds = loadThresholds(model);

  renderHealth(runHealthChecks(model, thresholds));
  renderThresholds(thresholds);
  renderCounts(model);
  renderDomains(model);
  renderBrowseList("");
  clearFile();
  renderGraph();
}

/**
 * One row per check, always. Detail lives behind a disclosure so this view is
 * the same size for a vault of 30 files or 30,000 — the checks all compute in
 * milliseconds either way, but a screen listing every result stops being
 * readable long before it stops being fast.
 */
function renderHealth(checks) {
  const needAttention = checks.filter((c) => c.status !== "pass").length;
  els.verdict.textContent =
    needAttention === 0 ? "all clear" : `${needAttention} of ${checks.length} need attention`;
  els.verdict.classList.toggle("verdict--attention", needAttention > 0);

  els.health.replaceChildren(...checks.map(buildCheckRow));
}

function buildCheckRow(check) {
  const li = document.createElement("li");
  li.className = `check check--${check.status}`;

  const row = document.createElement("button");
  row.type = "button";
  row.className = "check-row";

  const mark = document.createElement("span");
  mark.className = "check-mark";
  mark.textContent = check.status === "pass" ? "OK" : check.status === "warn" ? "!" : "X";

  const label = document.createElement("span");
  label.className = "check-label";
  label.textContent = check.label;

  const summary = document.createElement("span");
  summary.className = "check-summary";
  summary.textContent = check.summary;

  const toggle = document.createElement("span");
  toggle.className = "check-toggle";

  row.append(mark, label, summary, toggle);
  li.append(row);

  // A check with nothing to show is not a disclosure. Leaving off aria-expanded
  // is also what the CSS keys on to withhold the pointer cursor, so a row never
  // looks clickable when clicking it would do nothing.
  if (check.items.length === 0) {
    row.disabled = true;
    return li;
  }

  const list = document.createElement("ul");
  list.className = "check-items";
  list.append(
    ...check.items.slice(0, MAX_ITEMS_SHOWN).map((item) => {
      const entry = document.createElement("li");
      const text = document.createElement("span");
      text.className = "check-item-text";
      text.textContent = item.text;
      entry.append(text);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "check-item-detail";
        detail.textContent = item.detail;
        entry.append(detail);
      }
      return entry;
    })
  );

  if (check.items.length > MAX_ITEMS_SHOWN) {
    const more = document.createElement("li");
    more.className = "check-more";
    more.textContent = `…and ${check.items.length - MAX_ITEMS_SHOWN} more`;
    list.append(more);
  }

  // Anything not passing opens by itself — if a check found something, hiding
  // it behind a click defeats the purpose of running it.
  const openByDefault = check.status !== "pass";
  list.hidden = !openByDefault;
  row.setAttribute("aria-expanded", String(openByDefault));
  toggle.textContent = openByDefault ? "▾" : "▸";

  row.addEventListener("click", () => {
    const nowOpen = row.getAttribute("aria-expanded") !== "true";
    row.setAttribute("aria-expanded", String(nowOpen));
    list.hidden = !nowOpen;
    toggle.textContent = nowOpen ? "▾" : "▸";
  });

  li.append(list);
  return li;
}

/**
 * The thresholds are a derived copy of numbers the vault's router owns.
 * Printing them is what turns a silent divergence into a visible one — the same
 * reasoning behind the vault's rule that a stale pointer should fail loudly.
 */
function renderThresholds(t) {
  els.thresholds.textContent =
    `thresholds — router ${t.caps.router} · index ${t.caps.index} · leaf ${t.caps.leaf} · ` +
    `inbox ${t.inboxMax} items · stale ${t.staleDays}d · warn at ${Math.round(t.warnAtFraction * 100)}%` +
    `${(t.capExempt ?? []).length ? ` · exempt: ${t.capExempt.join(", ")}` : ""}` +
    `  (source: ${t.source})`;
}

function renderCounts(model) {
  const linkStatus = tally(model.links.map((l) => l.status));

  const stats = [
    ["Files", model.files.length],
    ["Domains", model.byDomain.size],
    ["Topics owned", model.byTopic.size],
    ["Links", model.links.length],
    ["Dated files", model.files.filter((f) => f.data.occurred).length],
    ["Hot files", model.files.filter((f) => f.data.status === "hot").length],
    ["Private files", model.files.filter((f) => f.data.sensitivity === "private").length],
    ["Total lines", model.files.reduce((n, f) => n + f.lineCount, 0)],
  ];

  els.counts.replaceChildren(
    ...stats.map(([label, value]) => {
      const wrap = document.createElement("div");
      wrap.className = "stat";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      wrap.append(dt, dd);
      return wrap;
    })
  );

  // Link breakdown only earns a line when something is not resolved.
  if (linkStatus.broken || linkStatus.ambiguous) {
    const wrap = document.createElement("div");
    wrap.className = "stat";
    const dt = document.createElement("dt");
    dt.textContent = "Link problems";
    const dd = document.createElement("dd");
    dd.textContent = `${(linkStatus.broken ?? 0) + (linkStatus.ambiguous ?? 0)}`;
    wrap.append(dt, dd);
    els.counts.append(wrap);
  }
}

function renderDomains(model) {
  const rows = [...model.byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
  const max = Math.max(...rows.map(([, files]) => files.length), 1);

  els.domains.replaceChildren(
    ...rows.map(([domain, files]) => {
      const li = document.createElement("li");
      li.className = "bar-row";

      const name = document.createElement("span");
      name.className = "bar-name";
      name.textContent = domain;

      const track = document.createElement("span");
      track.className = "bar-track";
      const fill = document.createElement("span");
      fill.className = "bar-fill";
      // Width is the only inline style in the app, because it is data, not design.
      fill.style.width = `${(files.length / max) * 100}%`;
      track.append(fill);

      const count = document.createElement("span");
      count.className = "bar-count";
      count.textContent = String(files.length);

      li.append(name, track, count);
      return li;
    })
  );
}

/** Count occurrences of each value in a list. */
function tally(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Browse
//
// Two panes. The left decides what to look at — search results when there is a
// query, the whole vault by domain when there isn't. The right shows it.
//
// Content renders as raw text by choice, not as a shortcut. Better markdown
// readers already exist and none of them know this vault's ownership map or its
// resolved link graph, which is the part worth building. What the <pre> adds
// over any editor is that the [[links]] in it are navigable, and that a broken
// one is visibly broken while you read.
// ---------------------------------------------------------------------------

/** Empty query lists the vault; a query searches it. */
function renderBrowseList(query) {
  if (!state.model) return;

  const groups = query.trim()
    ? searchResultGroups(query)
    : domainGroups();

  els.browseList.replaceChildren(...groups);
  if (state.path) markCurrent(state.path);
}

function domainGroups() {
  const model = state.model;
  els.searchMeta.textContent = `${model.files.length} files in ${model.byDomain.size} domains`;

  return [...model.byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, files]) =>
      group(
        domain,
        [...files]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => browseRow(f.path, f.name))
      )
    );
}

function searchResultGroups(query) {
  const { groups, total, truncated } = searchVault(state.model, query, MAX_RESULTS);

  els.searchMeta.textContent =
    total === 0
      ? "No matches"
      : `${total} file${total === 1 ? "" : "s"}` + (truncated ? ` — ${truncated} not shown` : "");

  return groups.map((g) =>
    group(
      g.label,
      g.results.map((r) => browseRow(r.path, r.path, r))
    )
  );
}

function group(title, rows) {
  const wrap = document.createElement("div");
  const h = document.createElement("h4");
  h.className = "browse-group-title";
  h.textContent = title;
  const ul = document.createElement("ul");
  ul.className = "browse-items";
  ul.append(...rows);
  wrap.append(h, ul);
  return wrap;
}

function browseRow(path, label, result) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browse-item";
  button.dataset.path = path;

  const name = document.createElement("span");
  name.className = "browse-item-name";
  name.textContent = label;
  button.append(name);

  if (result) {
    const evidence = document.createElement("span");
    evidence.className = "browse-item-evidence";
    evidence.append(highlighted(result.evidence, result.offset, result.length));
    if (result.extra > 0) {
      const more = document.createElement("span");
      more.textContent = `  +${result.extra} more in this file`;
      evidence.append(more);
    }
    button.append(evidence);
  }

  button.addEventListener("click", () => openFile(path));
  li.append(button);
  return li;
}

/**
 * Wrap the matched span in a <mark>, built from text nodes.
 *
 * The offsets come from search.js, which guarantees they select the query
 * inside `evidence` — a test asserts exactly that, because a wrong offset
 * highlights the wrong characters silently instead of failing.
 */
function highlighted(text, offset, length) {
  const frag = document.createDocumentFragment();
  frag.append(document.createTextNode(text.slice(0, offset)));

  const mark = document.createElement("mark");
  mark.className = "hit";
  mark.textContent = text.slice(offset, offset + length);
  frag.append(mark, document.createTextNode(text.slice(offset + length)));

  return frag;
}

// ---------------------------------------------------------------------------
// The file view
// ---------------------------------------------------------------------------

function openFile(path, push = true) {
  const file = state.model?.byPath.get(path);
  if (!file) return;

  // Following a link from inside a file is what builds the trail. Re-opening
  // the file you are already on is not a move.
  if (push && state.path && state.path !== path) state.history.push(state.path);

  state.path = path;
  renderFile(file);
  markCurrent(path);

  // A link can be followed from the health panel's view later; opening one
  // should always land you where the file actually is.
  if (els.browse.hidden) showOnly("browse");

  // Scroll position is per-page, not per-file. Following a link from halfway
  // down a long file otherwise leaves you halfway down the *next* one, looking
  // at the middle of a document with nothing to say you moved. It matters most
  // in the stacked layout, where the file sits below the list entirely.
  els.fileView.scrollIntoView({ block: "start" });
}

function clearFile() {
  state.path = null;
  state.history = [];
  els.fileView.hidden = true;
  els.fileEmpty.hidden = false;
}

function renderFile(file) {
  els.fileEmpty.hidden = true;
  els.fileView.hidden = false;

  els.filePath.textContent = file.path;
  els.fileBack.hidden = state.history.length === 0;

  renderMeta(file);
  renderBacklinks(file);
  renderBody(file);
}

/** Frontmatter as it was written. Values stay strings; arrays get commas. */
function renderMeta(file) {
  const entries = Object.entries(file.data);

  if (entries.length === 0) {
    els.fileMeta.hidden = true;
    return;
  }
  els.fileMeta.hidden = false;

  els.fileMeta.replaceChildren(
    ...entries.flatMap(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = Array.isArray(value) ? value.join(", ") : String(value);
      return [dt, dd];
    })
  );
}

/**
 * What points here. The other half of the link graph — forward links walk you
 * out of a file, these walk you in, and together they answer the question the
 * vault is organised around: if this moves, what breaks?
 */
function renderBacklinks(file) {
  const sources = state.model.backlinks.get(file.path) ?? [];

  if (sources.length === 0) {
    els.fileBacklinks.replaceChildren();
    return;
  }

  const title = document.createElement("h4");
  title.className = "file-backlinks-title";
  title.textContent = `Linked from ${sources.length} file${sources.length === 1 ? "" : "s"}`;

  const ul = document.createElement("ul");
  ul.className = "file-backlinks-list";
  ul.append(
    ...[...sources].sort().map((from) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vlink";
      button.textContent = from;
      button.addEventListener("click", () => openFile(from));
      li.append(button);
      return li;
    })
  );

  els.fileBacklinks.replaceChildren(title, ul);
}

function renderBody(file) {
  const segments = segmentBody(file.body, resolutionsFor(file.path));

  els.fileBody.replaceChildren(
    ...segments.map((s) => (s.type === "text" ? document.createTextNode(s.value) : linkNode(s)))
  );
}

/** target -> how the model resolved it, for this file's links only. */
function resolutionsFor(path) {
  const map = new Map();
  for (const link of state.model.links) {
    if (link.from === path) map.set(link.target, link);
  }
  return map;
}

/**
 * A resolved link is a button; anything else is a span.
 *
 * That distinction is deliberate. A broken link has nowhere to go, and a
 * control that looks live and does nothing is precisely the bug that made the
 * health disclosures feel broken when the JavaScript was correct all along.
 */
function linkNode(segment) {
  const label = `[[${segment.target}]]`;

  if (segment.status === "resolved") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vlink";
    button.textContent = label;
    button.title = segment.resolvedPath;
    button.addEventListener("click", () => openFile(segment.resolvedPath));
    return button;
  }

  const span = document.createElement("span");
  span.className = `vlink vlink--${segment.status === "ambiguous" ? "ambiguous" : "broken"}`;
  span.textContent = label;
  span.title =
    segment.status === "ambiguous"
      ? "Ambiguous — the name matches more than one file"
      : "Broken — nothing in the vault answers to this";
  return span;
}

function markCurrent(path) {
  for (const button of els.browseList.querySelectorAll(".browse-item")) {
    if (button.dataset.path === path) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

// ---------------------------------------------------------------------------
// Connections
//
// A renderer and nothing more. graph.js decides what is visible, where it sits
// and how it is emphasised; this reads that scene and draws it. The drill-down
// is a mechanic, and the look is placeholder — so every decision worth keeping
// lives on the other side of this boundary, and a restyle rewrites only what
// is below.
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** Labelling everything at 30 nodes is a smear; the hubs are what orient you. */
const LABEL_DEGREE_IN_FULL = 5;

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Node size reads degree at a glance. sqrt so a hub does not swamp the view. */
const radiusFor = (degree) => 4 + Math.sqrt(degree) * 2;

function setGraphView(view) {
  state.view = view;
  renderGraph();
}

function renderGraph() {
  if (!state.graph) return;

  const current = scene(state.graph, state.positions, state.view);
  state.view = { ...state.view, mode: current.mode }; // scene may have fallen back

  els.graphCaption.textContent = current.caption;
  els.graphNote.textContent = current.isolated
    ? `${current.isolated} files have no links in either direction — index files list their contents as plain names, not wiki-links, so they never enter the graph.`
    : "";

  const layers = { edges: [], marks: [], labels: [] };

  for (const chord of current.domainChords) {
    layers.edges.push(
      svg("path", {
        class: "gchord",
        d: `M${chord.from.x} ${chord.from.y} Q ${chord.via.x} ${chord.via.y} ${chord.to.x} ${chord.to.y}`,
        "stroke-width": Math.min(6, 1 + chord.weight * 0.55),
      })
    );
  }

  for (const edge of current.edges) {
    layers.edges.push(
      svg("path", {
        class: `gedge${edge.state === "emphasis" ? " gedge--emphasis" : ""}`,
        d: `M${edge.from.x} ${edge.from.y} Q ${edge.via.x} ${edge.via.y} ${edge.to.x} ${edge.to.y}`,
      })
    );
  }

  for (const domain of current.domains) {
    const group = svg("g", { class: `gdom gdom--${domain.state} ghit`, tabindex: "0", role: "button" });
    group.append(svg("circle", { cx: domain.x, cy: domain.y, r: domain.state === "focus" ? 17 : 14 }));

    const count = svg("text", { x: domain.x, y: domain.y + 4, "text-anchor": "middle", class: "gdom-count" });
    count.textContent = String(domain.count);
    group.append(count);

    // Outward along the marker's own radius, clear of the circle. Inward put
    // six labels in a huddle around the centre, overlapping each other.
    const dx = domain.x - current.centre.x;
    const dy = domain.y - current.centre.y;
    const away = Math.hypot(dx, dy) || 1;
    const name = svg("text", {
      x: domain.x + (dx / away) * 26,
      y: domain.y + (dy / away) * 26 + 4,
      "text-anchor": dx > 6 ? "start" : dx < -6 ? "end" : "middle",
      class: "gdom-name",
    });
    name.textContent = domain.name;
    group.append(name);

    const open = () => setGraphView({ mode: "domain", domain: domain.name });
    group.addEventListener("click", open);
    group.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    layers.marks.push(group);
  }

  for (const node of current.nodes) {
    const group = svg("g", { class: `gnode gnode--${node.state} ghit`, tabindex: "0", role: "button" });
    group.append(svg("circle", { cx: node.x, cy: node.y, r: radiusFor(node.degree) }));

    const title = svg("title");
    title.textContent = `${node.path} — ${node.degree} link${node.degree === 1 ? "" : "s"}`;
    group.append(title);

    const focus = () => setGraphView({ mode: "file", path: node.path });
    group.addEventListener("click", focus);
    group.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focus(); }
    });
    layers.marks.push(group);

    const worthLabelling =
      current.mode !== "full" || node.state === "focus" || node.degree >= LABEL_DEGREE_IN_FULL;
    if (!worthLabelling) continue;

    // Push the label outward along the node's own radius, so it never sits on
    // top of the ring it belongs to.
    const dx = node.x - current.centre.x;
    const dy = node.y - current.centre.y;
    const length = Math.hypot(dx, dy) || 1;
    const label = svg("text", {
      x: node.x + (dx / length) * 15,
      y: node.y + (dy / length) * 15 + 3.5,
      "text-anchor": dx > 6 ? "start" : dx < -6 ? "end" : "middle",
      class: "glabel",
    });
    label.textContent = node.name;
    layers.labels.push(label);
  }

  els.graphSvg.replaceChildren(...layers.edges, ...layers.marks, ...layers.labels);
  frameToContent(current);

  // "Read this file" only exists when there is a file to read. The graph finds
  // things; browse is where you read one.
  const focused = current.mode === "file" ? state.view.path : null;
  els.graphOpen.hidden = !focused;
  if (focused) els.graphOpen.textContent = `Read ${focused} →`;
}

/**
 * Point the viewBox at whatever this view actually drew.
 *
 * The viewBox is a camera, not a layout. Zooming to the content leaves every
 * coordinate untouched, so the "nothing moves" guarantee survives — a node at
 * the same point simply fills more of the frame when fewer things share it.
 * Without this the domains view puts six markers in the middle of a mostly
 * empty box, because it is framed for a file ring that is not being drawn.
 */
function frameToContent(current) {
  const points = [...current.domains, ...current.nodes];
  if (points.length === 0) {
    els.graphSvg.setAttribute("viewBox", "0 0 720 520");
    return;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  // Labels sit outside their marks and run horizontally, so x needs the room.
  const padX = 96;
  const padY = 44;

  const minX = Math.min(...xs) - padX;
  const minY = Math.min(...ys) - padY;
  const width = Math.max(...xs) + padX - minX;
  const height = Math.max(...ys) + padY - minY;

  els.graphSvg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
}


// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

els.openVault.addEventListener("click", openVault);
els.retry.addEventListener("click", openVault);
els.reload.addEventListener("click", openVault);

els.viewHealth.addEventListener("click", () => showOnly("summary"));
els.viewBrowse.addEventListener("click", () => showOnly("browse"));
els.viewGraph.addEventListener("click", () => showOnly("graph"));

els.graphHome.addEventListener("click", () => setGraphView({ mode: "domains" }));
els.graphFull.addEventListener("click", () => setGraphView({ mode: "full" }));
els.graphOpen.addEventListener("click", () => {
  // The graph is for finding a file; browse is for reading one. openFile()
  // already switches panels.
  if (state.view.path) openFile(state.view.path);
});

// 34 files scanned per keystroke costs microseconds — a debounce would only add
// latency and a timer to reason about.
els.search.addEventListener("input", () => renderBrowseList(els.search.value));

els.fileBack.addEventListener("click", () => {
  const previous = state.history.pop();
  if (previous) openFile(previous, false);
});

if (isSupported()) {
  showOnly("picker");
} else {
  els.unsupportedDetail.textContent =
    "The File System Access API isn't available. Use Chrome or Edge, and make sure this " +
    "page is served over https or http://localhost — opening the file directly won't work, " +
    "because a file:// page has an opaque origin the browser won't grant folder access to.";
  showOnly("unsupported");
}
