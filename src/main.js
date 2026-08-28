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
import { parseMarkdown } from "./markdown.js";
import { buildChronology, timelineScene, axisOf, trackSpans, humanDuration } from "./chronology.js";
import { icon, setIconLabel, statusDot } from "./icons.js";
import { starfield, planetLighting, planetToken, lightingBucket, bucketLighting, dustCloud } from "./sky.js";

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
  viewTimeline: document.getElementById("view-timeline"),

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
  fileRendered: document.getElementById("file-rendered"),
  modeRaw: document.getElementById("mode-raw"),
  modeRendered: document.getElementById("mode-rendered"),

  graph: document.getElementById("graph"),
  graphSvg: document.getElementById("graph-svg"),
  graphCaption: document.getElementById("graph-caption"),
  graphNote: document.getElementById("graph-note"),
  graphBrush: document.getElementById("graph-brush"),
  graphStrip: document.getElementById("graph-strip"),
  graphWindow: document.getElementById("graph-window"),
  graphWindowClear: document.getElementById("graph-window-clear"),
  graphHome: document.getElementById("graph-home"),
  graphFull: document.getElementById("graph-full"),
  graphOpen: document.getElementById("graph-open"),

  timeline: document.getElementById("timeline"),
  timelineSvg: document.getElementById("timeline-svg"),
  timelineCaption: document.getElementById("timeline-caption"),
  timelineDomain: document.getElementById("timeline-domain"),
  timelineUndated: document.getElementById("timeline-undated"),
};

/** Panels that showOnly arbitrates between. */
const PANELS = ["unsupported", "picker", "error", "loading", "summary", "browse", "graph", "timeline"];

/** The subset that means "a vault is open" — the switcher belongs to these. */
const VIEWS = { summary: "viewHealth", browse: "viewBrowse", graph: "viewGraph", timeline: "viewTimeline" };

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

  // Computed once per vault, like the graph and for the same reason.
  chronology: null,
  // The join between when and where: path -> {from, to}, undated paths absent.
  spans: null,
  view: { mode: "domains" },

  // Raw is the default. It is the view with no parser between you and the
  // file, so it is the one that cannot be wrong.
  mode: "raw",
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

  // Before renderGraph, not after: the graph now asks the chronology which
  // files were live inside a brushed window, so the dates have to exist first.
  state.chronology = buildChronology(model);
  state.spans = trackSpans(state.chronology);

  renderGraph();
  renderStrip();
  renderTimelineDomains(state.chronology);
  renderTimeline();
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
  mark.append(statusDot(check.status));

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
  toggle.replaceChildren(icon(openByDefault ? "chevron-down" : "chevron-right", { size: 12 }));

  row.addEventListener("click", () => {
    const nowOpen = row.getAttribute("aria-expanded") !== "true";
    row.setAttribute("aria-expanded", String(nowOpen));
    list.hidden = !nowOpen;
    toggle.replaceChildren(icon(nowOpen ? "chevron-down" : "chevron-right", { size: 12 }));
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
    `inbox ${t.inboxMax} items · stale ${t.staleDays}d · warn at ${Math.round(t.warnAtFraction * 100)}% · critical at ${Math.round(t.criticalAtFraction * 100)}%` +
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
  const resolutions = resolutionsFor(file.path);
  const rendered = state.mode === "rendered";

  els.fileBody.hidden = rendered;
  els.fileRendered.hidden = !rendered;

  if (rendered) {
    els.fileRendered.replaceChildren(...parseMarkdown(file.body, resolutions).map(blockNode));
  } else {
    els.fileBody.replaceChildren(
      ...segmentBody(file.body, resolutions).map((s) =>
        s.type === "text" ? document.createTextNode(s.value) : linkNode(s)
      )
    );
  }

  for (const [mode, ref] of [["raw", "modeRaw"], ["rendered", "modeRendered"]]) {
    if (state.mode === mode) els[ref].setAttribute("aria-current", "true");
    else els[ref].removeAttribute("aria-current");
  }
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
function linkNode(segment, extraClass = "") {
  const label = `[[${segment.target}]]`;
  const extra = extraClass ? ` ${extraClass}` : "";

  if (segment.status === "resolved") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vlink${extra}`;
    button.textContent = label;
    button.title = segment.resolvedPath;
    button.addEventListener("click", () => openFile(segment.resolvedPath));
    return button;
  }

  const span = document.createElement("span");
  span.className = `vlink vlink--${segment.status === "ambiguous" ? "ambiguous" : "broken"}${extra}`;
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
// Rendered markdown
//
// Turns the block tree from markdown.js into nodes. It parses nothing and
// decides no structure — same split as the graph's scene, and the reason both
// parsers are testable in Node at all.
//
// Every node is built with createElement + textContent. Never innerHTML: the
// CSP would stop injected script anyway, but this is the layer that should not
// be relying on that.
// ---------------------------------------------------------------------------

/** Markdown h1 sits below the file's own h3, so levels shift down by three. */
const HEADING_TAG = { 1: "h4", 2: "h5", 3: "h6" };

function blockNode(block) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(block.level, 3);
      const el = document.createElement(HEADING_TAG[level]);
      el.className = `md-h${level}`;
      el.append(...inlineNodes(block.inline));
      return el;
    }

    case "paragraph": {
      const p = document.createElement("p");
      p.append(...inlineNodes(block.inline));
      return p;
    }

    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      // A list that starts at 0 or 3 must say so, or the rendered document
      // disagrees with the source about its own numbering.
      if (block.ordered && block.start !== undefined && block.start !== 1) {
        list.setAttribute("start", String(block.start));
      }
      list.append(
        ...block.items.map((item) => {
          const li = document.createElement("li");
          li.append(...inlineNodes(item));
          return li;
        })
      );
      return list;
    }

    case "quote": {
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      quote.append(...inlineNodes(block.inline));
      return quote;
    }

    case "code": {
      // Wrapped in <pre><code> so the content is unambiguous to a screen
      // reader as well as to the eye.
      const pre = document.createElement("pre");
      pre.className = "md-pre";
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      return pre;
    }

    case "rule": {
      const hr = document.createElement("hr");
      hr.className = "md-rule";
      return hr;
    }

    case "table":
      return tableNode(block);

    default: {
      // An unknown block type is a bug in the parser, not a reason to drop
      // content on the floor.
      const p = document.createElement("p");
      p.textContent = JSON.stringify(block);
      return p;
    }
  }
}

/**
 * Tables get their own scroll container.
 *
 * They appear in 20 of 34 files and are often wide. Letting one scroll inside
 * its own box is what keeps the page itself from scrolling sideways on a phone.
 */
function tableNode(block) {
  const wrap = document.createElement("div");
  wrap.className = "md-table-wrap";

  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  block.head.forEach((cell, i) => {
    const th = document.createElement("th");
    if (block.align?.[i] && block.align[i] !== "left") th.style.textAlign = block.align[i];
    th.append(...inlineNodes(cell));
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, i) => {
      const td = document.createElement("td");
      if (block.align?.[i] && block.align[i] !== "left") td.style.textAlign = block.align[i];
      td.append(...inlineNodes(cell));
      tr.append(td);
    });
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function inlineNodes(tokens) {
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
        return document.createTextNode(token.value);

      case "code": {
        const code = document.createElement("code");
        code.className = "md-code";
        code.textContent = token.value;
        return code;
      }

      case "strong":
      case "em": {
        const el = document.createElement(token.type === "strong" ? "strong" : "em");
        el.append(...inlineNodes(token.children));
        return el;
      }

      case "link":
        // The same node builder both views use, so a broken link looks and
        // behaves identically whether you are reading source or prose.
        return linkNode(token, token.inCode ? "md-link-code" : "");

      default:
        return document.createTextNode("");
    }
  });
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

/**
 * The world the camera moves across.
 *
 * Generated once, across a rect far larger than any view frames, so panning
 * between views reveals different stars rather than sliding the same ones
 * about. Deterministic, so drilling into a domain does not make the sky
 * shimmer.
 */
const SKY = starfield({ x: -260, y: -260, width: 1240, height: 1040, count: 340, seed: 41 });

/** Three tints, mapped to tokens here so no colour appears in JavaScript. */
const STAR_TINT = ["var(--star-core)", "var(--moon)", "var(--star)"];

/** Node size reads degree at a glance. sqrt so a hub does not swamp the view. */
const radiusFor = (degree) => 4 + Math.sqrt(degree) * 2;

/**
 * Change mode, keeping the window.
 *
 * The window outlives a mode change on purpose. It is the second, orthogonal
 * axis of the view — dropping it here would make the brush behave like a fifth
 * mode after all, which is the design it was built to avoid.
 */
function setGraphView(view) {
  state.view = { ...view, window: state.view.window };
  renderGraph();
  renderStrip();
}

/** Set or clear the brushed window. null means no window at all. */
function setGraphWindow(window) {
  state.view = { ...state.view, window };
  renderGraph();
  renderStrip();
}

function renderGraph() {
  if (!state.graph) return;

  const current = scene(state.graph, state.positions, state.view, state.spans);
  // Only meaningful while a window is brushed; without one everything is null
  // and saying so would be noise on every tooltip in the app.
  const why = (inWindow) =>
    !current.window
      ? ""
      : inWindow === null
        ? " · no event date, never dimmed"
        : inWindow === false
          ? " · outside the window"
          : " · inside the window";
  const out = (inWindow) => (inWindow === false ? " gout" : "");
  const plates = [];
  state.view = { ...state.view, mode: current.mode }; // scene may have fallen back

  els.graphCaption.textContent = current.caption;
  els.graphNote.textContent = current.isolated
    ? `${current.isolated} files have no links in either direction — index files list their contents as plain names, not wiki-links, so they never enter the graph.`
    : "";

  // Every gradient this view needs. Rebuilt per render because the lighting
  // depends on where each planet sits relative to the star, and ids are scoped
  // by mode so two views never share a stale definition.
  const defs = svg("defs");
  const gradient = (id, stops, focal) => {
    const g = svg("radialGradient", { id, ...(focal ? { cx: `${focal.cx}%`, cy: `${focal.cy}%`, r: "78%" } : {}) });
    for (const [offset, color, opacity] of stops) {
      g.append(svg("stop", { offset, "stop-color": color, ...(opacity === undefined ? {} : { "stop-opacity": opacity }) }));
    }
    defs.append(g);
    return `url(#${id})`;
  };

  const corona = gradient("sky-corona", [
    ["0%", "var(--star-core)", 0.9],
    ["18%", "var(--star)", 0.36],
    ["55%", "var(--star)", 0.1],
    ["100%", "var(--bg)", 0],
  ]);
  const nebula = gradient("sky-nebula", [
    ["0%", "var(--nebula)", 0.38],
    ["100%", "var(--bg)", 0],
  ]);
  // Every moon is lit by the same star, so its terminator depends only on the
  // direction to it. Bucketing the direction means thirty moons share a handful
  // of gradients rather than needing one each. Built lazily: a view that draws
  // no moons defines none.
  const moonFill = new Map();
  const moonGradient = (bucket) => {
    if (!moonFill.has(bucket)) {
      const { cx, cy } = bucketLighting(bucket);
      moonFill.set(
        bucket,
        gradient(
          `sky-moon-${current.mode}-${bucket}`,
          [
            ["0%", "var(--moon-lit)"],
            ["45%", "var(--moon)"],
            ["100%", "var(--moon-dark)"],
          ],
          { cx, cy }
        )
      );
    }
    return moonFill.get(bucket);
  };

  const planetFill = new Map();
  state.graph.domains.forEach((name, i) => {
    const at = state.positions.domains.get(name);
    if (!at) return;
    const token = planetToken(i);
    const { cx, cy } = planetLighting(at, current.centre);
    planetFill.set(
      name,
      gradient(
        `sky-planet-${current.mode}-${i}`,
        [
          ["0%", `var(--planet-${token})`],
          ["58%", `var(--planet-${token})`, 0.6],
          ["100%", `var(--planet-${token}-dark)`],
        ],
        { cx, cy }
      )
    );
  });

  const layers = { sky: [defs], edges: [], marks: [], labels: [] };

  // The void, then the deep colour in it, then the stars. Nebulae sit far out
  // so they never end up behind a label.
  layers.sky.push(svg("rect", { x: -400, y: -400, width: 1600, height: 1400, class: "gvoid" }));
  for (const [nx, ny, rx, ry] of [
    [current.centre.x - 300, current.centre.y - 230, 300, 190],
    [current.centre.x + 320, current.centre.y + 240, 320, 200],
  ]) {
    layers.sky.push(svg("ellipse", { cx: nx, cy: ny, rx, ry, fill: nebula }));
  }
  for (const s of SKY) {
    layers.sky.push(
      svg("circle", { cx: s.x, cy: s.y, r: s.r, fill: STAR_TINT[s.tint], opacity: s.opacity, class: "gstar" })
    );
  }

  // Orbits: the one the planets ride, and each planet's own moon ring.
  layers.sky.push(
    svg("circle", { cx: current.centre.x, cy: current.centre.y, r: 178, class: "gorbit" })
  );
  for (const domain of current.domains) {
    if (domain.moonR === undefined) continue;
    layers.sky.push(
      svg("circle", {
        cx: domain.x,
        cy: domain.y,
        r: domain.moonR,
        class:
          `gorbit gorbit--moon gorbit--${domain.state} ` +
          `gp-${planetToken(state.graph.domains.indexOf(domain.name))}${out(domain.inWindow)}`,
      })
    );
  }

  // The star. The only thing in the diagram that emits rather than reflects.
  layers.marks.push(svg("circle", { cx: current.centre.x, cy: current.centre.y, r: 120, fill: corona }));
  layers.marks.push(svg("circle", { cx: current.centre.x, cy: current.centre.y, r: 13, class: "gstar-core" }));
  layers.marks.push(svg("circle", { cx: current.centre.x, cy: current.centre.y, r: 19, class: "gstar-ring" }));

  for (const chord of current.domainChords) {
    layers.edges.push(
      svg("path", {
        // Same rule as an edge: a chord dims only when both of its domains are
        // out, or a lit planet would appear to reference nothing.
        class: `gchord${
          current.window &&
          current.domains.find((d) => d.name === chord.a)?.inWindow === false &&
          current.domains.find((d) => d.name === chord.b)?.inWindow === false
            ? " gout"
            : ""
        }`,
        d: `M${chord.from.x} ${chord.from.y} Q ${chord.via.x} ${chord.via.y} ${chord.to.x} ${chord.to.y}`,
        "stroke-width": Math.min(6, 1 + chord.weight * 0.55),
      })
    );
  }

  for (const edge of current.edges) {
    layers.edges.push(
      svg("path", {
        class: `gedge${edge.state === "emphasis" ? " gedge--emphasis" : ""}${out(edge.inWindow)}`,
        d: `M${edge.from.x} ${edge.from.y} Q ${edge.via.x} ${edge.via.y} ${edge.to.x} ${edge.to.y}`,
      })
    );
  }

  for (const domain of current.domains) {
    const token = planetToken(state.graph.domains.indexOf(domain.name));
    const group = svg("g", {
      class: `gdom gdom--${domain.state} gp-${token} ghit${out(domain.inWindow)}`,
      tabindex: "0",
      role: "button",
    });
    // A planet holding no dated files at all reads as lit, exactly like one
    // that was live during the window. Only a tooltip can tell them apart, and
    // in the domains view — where the window says the most — the difference is
    // the whole finding.
    group.append(
      (() => {
        const t = svg("title");
        t.textContent =
          `${domain.name} — ${domain.count} file${domain.count === 1 ? "" : "s"}` +
          (current.window && domain.inWindow === null ? " · none of them dated" : why(domain.inWindow));
        return t;
      })()
    );
    const pr = (domain.r ?? 14) + (domain.state === "focus" ? 3 : 0);
    group.append(
      svg("circle", { cx: domain.x, cy: domain.y, r: pr, fill: planetFill.get(domain.name) ?? "none" })
    );
    group.append(
      svg("circle", { cx: domain.x, cy: domain.y, r: pr, class: "gplanet-rim" })
    );

    const count = svg("text", { x: domain.x, y: domain.y + 4, "text-anchor": "middle", class: "gdom-count" });
    count.textContent = String(domain.count);
    group.append(count);

    // Outward along the marker's own radius, clear of the circle. Inward put
    // six labels in a huddle around the centre, overlapping each other.
    const dx = domain.x - current.centre.x;
    const dy = domain.y - current.centre.y;
    const away = Math.hypot(dx, dy) || 1;
    // Clear the planet’s OWN moon ring. A fixed offset was right when every
    // file sat on one shared outer ring; now each planet carries its own moons,
    // and 26px puts the label on top of them.
    const clear = (domain.moonR ?? 14) + 20;
    const name = svg("text", {
      x: domain.x + (dx / away) * clear,
      y: domain.y + (dy / away) * clear + 4,
      "text-anchor": dx > 6 ? "start" : dx < -6 ? "end" : "middle",
      class: "gdom-name",
    });
    name.textContent = domain.name;
    // Glow is a property of bodies, never of chrome — so a label never sits on
    // a gradient. The plate is sized from the text once it is measured.
    const plate = svg("rect", { class: "gplate", rx: 2 });
    group.append(plate, name);
    plates.push([plate, name]);

    const open = () => setGraphView({ mode: "domain", domain: domain.name });
    group.addEventListener("click", open);
    group.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    layers.marks.push(group);
  }

  for (const node of current.nodes) {
    const group = svg("g", {
      class: `gnode gnode--${node.state} ghit${out(node.inWindow)}`,
      tabindex: "0",
      role: "button",
    });
    // A moon REFLECTS. It gets the same treatment as a planet - lit limb toward
    // the star, far side in shadow - and no bloom of its own, because emission
    // is the star’s alone. Thirty white discs with halos read as thirty little
    // suns and left the real one competing with them.
    group.append(
      svg("circle", {
        cx: node.x,
        cy: node.y,
        r: radiusFor(node.degree),
        fill: moonGradient(lightingBucket(node, current.centre)),
        class: "gmoon",
      })
    );

    const title = svg("title");
    title.textContent =
      `${node.path} — ${node.degree} link${node.degree === 1 ? "" : "s"}` + why(node.inWindow);
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
    // Outward from the moon’s OWN planet. Measured from the distant centre, a
    // moon on the near half of its ring has its label pushed inward - straight
    // through the planet it belongs to.
    const dx = node.x - (node.px ?? current.centre.x);
    const dy = node.y - (node.py ?? current.centre.y);
    const length = Math.hypot(dx, dy) || 1;
    const label = svg("text", {
      x: node.x + (dx / length) * (radiusFor(node.degree) + 9),
      y: node.y + (dy / length) * (radiusFor(node.degree) + 9) + 3.5,
      "text-anchor": dx > 6 ? "start" : dx < -6 ? "end" : "middle",
      class: `glabel${out(node.inWindow)}`,
    });
    label.textContent = node.name;
    layers.labels.push(label);
  }

  els.graphSvg.replaceChildren(...layers.sky, ...layers.edges, ...layers.marks, ...layers.labels);
  frameToContent(current);

  // Plates can only be sized once the text is in the document and measurable.
  for (const [plate, text] of plates) {
    const box = text.getBBox();
    plate.setAttribute("x", box.x - 5);
    plate.setAttribute("y", box.y - 2);
    plate.setAttribute("width", box.width + 10);
    plate.setAttribute("height", box.height + 4);
  }

  // "Read this file" only exists when there is a file to read. The graph finds
  // things; browse is where you read one.
  const focused = current.mode === "file" ? state.view.path : null;
  els.graphOpen.hidden = !focused;
  if (focused) setIconLabel(els.graphOpen, "arrow-right", `Read ${focused}`, "after");
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

  // Each point reaches further than its own coordinate: a planet carries a moon
  // ring and a label beyond that. Framing on the bare coordinates clipped the
  // labels the moment they were pushed clear of the moons.
  const reach = (p) => (p.moonR ?? 0) + 26;
  const lefts = points.map((p) => p.x - reach(p));
  const rights = points.map((p) => p.x + reach(p));
  const tops = points.map((p) => p.y - reach(p));
  const bottoms = points.map((p) => p.y + reach(p));

  // Labels run horizontally, so x still needs more room than y.
  const padX = 72;
  const padY = 30;

  const minX = Math.min(...lefts) - padX;
  const minY = Math.min(...tops) - padY;
  const width = Math.max(...rights) + padX - minX;
  const height = Math.max(...bottoms) + padY - minY;

  els.graphSvg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
}


// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeline
//
// chronology.js decided every position; this only draws. The axis is piecewise,
// so a break band is chrome laid over the plot rather than a gap in it — a bar
// crossing one continued through a stretch where nothing was recorded, and
// hiding that would be a different claim than the data supports.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The brush
//
// A date window dragged across the connections. Time is a FILTER here and never
// a layout: the window changes which bodies are lit and moves none of them,
// which is the property the whole drill-down mechanic rests on.
//
// The strip is the third consumer of one scale, alongside the timeline and the
// health panel's staleness. A break here is the same break there, because it is
// literally the same object — two axes computed separately would drift apart
// the first time either threshold moved.
// ---------------------------------------------------------------------------

const STRIP = { minWidth: 340, padL: 12, padR: 12, height: 50, top: 10, bottom: 32, minTickGap: 58 };

const DAY_MS = 86_400_000;

/** Dates as the readout says them. */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Midnight at the start of the day a moment falls in. */
const floorDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

function renderStrip() {
  const axis = state.chronology ? axisOf(state.chronology) : { empty: true };

  // No dated file means no axis to brush. Hiding the control is better than
  // offering one that cannot do anything.
  els.graphBrush.hidden = axis.empty;
  if (axis.empty) return;

  const width = Math.max(STRIP.minWidth, els.graphBrush.clientWidth);
  const plot = width - STRIP.padL - STRIP.padR;
  const at = (unit) => STRIP.padL + unit * plot;
  const { top, bottom } = STRIP;

  els.graphStrip.setAttribute("viewBox", `0 0 ${width} ${STRIP.height}`);
  els.graphStrip.setAttribute("width", width);
  els.graphStrip.setAttribute("height", STRIP.height);

  const parts = [svg("rect", { x: STRIP.padL, y: top, width: plot, height: bottom - top, class: "gbrush-track" })];

  for (const band of axis.breaks) {
    const x0 = at(band.x0);
    parts.push(
      titled(
        svg("rect", { x: x0, y: top, width: Math.max(2, at(band.x1) - x0), height: bottom - top, class: "gbrush-break" }),
        `${band.label} with no dated entries — a handle dropped here snaps inside it`
      )
    );
  }

  // Every recorded moment, drawn before the ticks so a label always wins.
  // These are what you aim a brush at.
  for (const position of axis.events) {
    const x = at(position);
    parts.push(svg("line", { x1: x, y1: top + 3, x2: x, y2: bottom - 3, class: "gbrush-event" }));
  }

  let lastTick = -Infinity;
  for (const tick of axis.ticks) {
    const x = at(tick.x);
    if (x - lastTick < STRIP.minTickGap) continue;
    lastTick = x;
    parts.push(svg("line", { x1: x, y1: bottom, x2: x, y2: bottom + 3, class: "gbrush-tick" }));
    // The end labels turn to face inward rather than centring on their tick.
    // The first tick sits at x = padL, and a centred label there runs off the
    // left of the viewBox and is simply cut in half.
    const label = svg("text", {
      x,
      y: bottom + 13,
      class: "gbrush-tick-label",
      "text-anchor": x < 30 ? "start" : x > width - 30 ? "end" : "middle",
    });
    label.textContent = tick.label;
    parts.push(label);
  }

  if (axis.today !== null) {
    const x = at(axis.today);
    parts.push(titled(svg("line", { x1: x, y1: top - 3, x2: x, y2: bottom + 3, class: "gbrush-today" }), "today"));
  }

  const win = state.view.window;
  if (win) {
    const scale = state.chronology.scale;
    const x0 = at(scale.project(win.from));
    const x1 = at(scale.project(win.to));
    parts.push(svg("rect", { x: x0, y: top, width: Math.max(2, x1 - x0), height: bottom - top, class: "gbrush-window" }));
    for (const x of [x0, x1]) {
      parts.push(svg("line", { x1: x, y1: top - 4, x2: x, y2: bottom + 4, class: "gbrush-handle" }));
    }
  }

  els.graphStrip.replaceChildren(...parts);
  els.graphWindowClear.hidden = !win;
  // to is exclusive — midnight ending the last included day — so the readout
  // names that day rather than the one after it.
  els.graphWindow.textContent = win
    ? `${isoDay(win.from)} → ${isoDay(win.to - 1)} · ${humanDuration(win.to - win.from)}`
    : "Drag across the strip to filter by date. Files with no date are never dimmed.";
}

// --- dragging ---------------------------------------------------------------
//
// Coalesced to one redraw per animation frame, because pointermove fires faster
// than frames and would otherwise run the same work several times for a single
// picture. It is not a performance rescue: a full renderGraph is ~7ms and holds
// 60fps redrawn every frame, with room to spare. The frame gate just stops the
// waste.

let dragFrom = null;
let dragTo = null;
let dragFromUnit = 0;
let dragToUnit = 0;
let dragFrame = 0;

/** Where the pointer is on the axis, as a 0..1 position. */
function unitAt(event) {
  const box = els.graphStrip.getBoundingClientRect();
  const plot = box.width - STRIP.padL - STRIP.padR;
  if (plot <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - box.left - STRIP.padL) / plot));
}

function commitDrag() {
  dragFrame = 0;
  if (dragFrom === null) return;

  // Was this a drag at all? Measured in PIXELS, because that is the gesture
  // being classified. A press with no movement means no window, not a window of
  // zero width — nothing would survive that filter and nobody asked for it.
  // Measuring it in days instead would make a deliberate single-day selection
  // in the dense August stretch indistinguishable from a click.
  const plot = els.graphStrip.getBoundingClientRect().width - STRIP.padL - STRIP.padR;
  if (Math.abs(dragToUnit - dragFromUnit) * plot < 3) {
    setGraphWindow(null);
    return;
  }

  // A window is a range of DAYS, not of instants. A drag lands mid-day at both
  // ends, so both those days are included whole. Without this the readout shows
  // two dates and a duration that contradict them: 08-19 to 08-25, "5 days".
  const from = floorDay(Math.min(dragFrom, dragTo));
  const to = floorDay(Math.max(dragFrom, dragTo)) + DAY_MS;
  setGraphWindow({ from, to });
}

els.graphStrip.addEventListener("pointerdown", (event) => {
  const scale = state.chronology?.scale;
  if (!scale) return;
  els.graphStrip.setPointerCapture(event.pointerId);
  dragFromUnit = dragToUnit = unitAt(event);
  dragFrom = dragTo = scale.resolve(dragFromUnit).ms;
  commitDrag();
});

els.graphStrip.addEventListener("pointermove", (event) => {
  if (dragFrom === null) return;
  dragToUnit = unitAt(event);
  dragTo = state.chronology.scale.resolve(dragToUnit).ms;
  if (!dragFrame) dragFrame = requestAnimationFrame(commitDrag);
});

for (const type of ["pointerup", "pointercancel"]) {
  els.graphStrip.addEventListener(type, () => {
    if (dragFrom === null) return;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    commitDrag();
    dragFrom = dragTo = null;
  });
}

els.graphWindowClear.addEventListener("click", () => setGraphWindow(null));

const TL = { minWidth: 760, labelWidth: 232, rightPad: 28, top: 46, rowHeight: 24, bottom: 30, minTickGap: 54 };

/** An SVG <title> is the tooltip, and it is also what a screen reader reads. */
function titled(node, text) {
  const title = svg("title");
  title.textContent = text;
  node.append(title);
  return node;
}

/** Long paths lose their middle, not their end — the filename is the identifying part. */
function shortPath(path, max = 34) {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const room = max - name.length - 2;
  return room > 3 ? `${path.slice(0, room)}…/${name}` : `…${name.slice(-(max - 1))}`;
}

function renderTimeline() {
  if (!state.chronology) return;

  const view = els.timelineDomain.value ? { domain: els.timelineDomain.value } : {};
  const scene = timelineScene(state.chronology, view);
  els.timelineCaption.textContent = scene.caption;

  // Fill the panel when it is wide enough, scroll only below minWidth.
  const available = els.timelineSvg.parentElement.clientWidth;
  const width = Math.max(TL.minWidth, available);

  const plotWidth = width - TL.labelWidth - TL.rightPad;
  const at = (unit) => TL.labelWidth + unit * plotWidth;
  const height = TL.top + scene.rows.length * TL.rowHeight + TL.bottom;
  const rowY = (i) => TL.top + i * TL.rowHeight;

  // Drawn 1:1 and scrolled, rather than scaled to fit. Scaling to fit is what
  // shrinks an 11px label to 7px on a narrow screen.
  els.timelineSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.timelineSvg.setAttribute("width", width);
  els.timelineSvg.setAttribute("height", height);

  const parts = [];


  if (scene.empty || scene.rows.length === 0) {
    const empty = svg("text", { x: width / 2, y: 60, class: "tl-empty", "text-anchor": "middle" });
    empty.textContent = scene.empty ? "No file carries an event date." : "No dated files in this domain.";
    els.timelineSvg.replaceChildren(empty);
    renderUndated(scene.undated);
    return;
  }

  const plotTop = TL.top - 14;
  const plotBottom = height - TL.bottom + 6;

  // ---- break bands, behind everything ------------------------------------
  for (const band of scene.axis.breaks) {
    const x0 = at(band.x0);
    const width = Math.max(2, at(band.x1) - x0);
    parts.push(
      titled(
        svg("rect", { x: x0, y: plotTop, width, height: plotBottom - plotTop, class: "tl-break" }),
        `${band.label} with no dated entries — the axis is compressed here`
      )
    );
    // Rotated, so a nine-year label fits inside a 50px band without colliding
    // with its neighbours.
    const label = svg("text", {
      x: x0 + width / 2,
      y: (plotTop + plotBottom) / 2,
      class: "tl-break-label",
      "text-anchor": "middle",
      transform: `rotate(-90 ${x0 + width / 2} ${(plotTop + plotBottom) / 2})`,
    });
    label.textContent = band.label;
    parts.push(label);
  }

  // ---- axis ticks ---------------------------------------------------------
  let lastTickX = -Infinity;
  for (const tick of scene.axis.ticks) {
    const x = at(tick.x);
    if (x - lastTickX < TL.minTickGap) continue;
    lastTickX = x;
    parts.push(svg("line", { x1: x, y1: TL.top - 10, x2: x, y2: plotBottom, class: "tl-tick" }));
    const label = svg("text", { x, y: TL.top - 18, class: "tl-tick-label", "text-anchor": "middle" });
    label.textContent = tick.label;
    parts.push(label);
  }

  // ---- today --------------------------------------------------------------
  if (scene.today !== null) {
    const x = at(scene.today);
    parts.push(titled(svg("line", { x1: x, y1: plotTop, x2: x, y2: plotBottom, class: "tl-today" }), "today"));
    const label = svg("text", { x, y: plotBottom + 16, class: "tl-today-label", "text-anchor": "middle" });
    label.textContent = "today";
    parts.push(label);
  }

  // ---- rows ---------------------------------------------------------------
  scene.rows.forEach((row, i) => {
    const y = rowY(i);
    const group = svg("g", { class: "tl-row", tabindex: "0", role: "button" });
    const open = () => openFile(row.path);
    group.addEventListener("click", open);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    // A full-width hit area, so the whole row is clickable rather than only the
    // few pixels a one-day mark occupies.
    // The tooltip lives on the hit area, not on the label. A <title> INSIDE a
    // <text> element is valid SVG but doubles that element’s textContent, which
    // makes the label unreadable to anything that reads the tree.
    group.append(
      titled(svg("rect", { x: 0, y, width, height: TL.rowHeight, class: "tl-hit" }), row.path)
    );

    const label = svg("text", { x: TL.labelWidth - 12, y: y + 16, class: "tl-label", "text-anchor": "end" });
    label.textContent = shortPath(row.path);
    group.append(label);

    if (row.bar) {
      // A certain stretch is a solid bar. An imprecise one is DUST: the author
      // wrote a month or a year, so the exact edge inside it is unknown, and a
      // solid bar would claim a precision the vault does not have. Dust says
      // that plainly, where a hatch said "pattern".
      const tip =
        `${row.bar.label} · ${row.bar.duration}` +
        (row.bar.uncertain ? " · dust = imprecise, exact edge unknown" : "") +
        (row.bar.clamped ? " · shown only up to today" : "");

      row.bar.parts.forEach((part, i) => {
        const x0 = at(part.x0);
        const width = Math.max(2, at(part.x1) - x0);

        if (part.certain) {
          group.append(
            titled(
              svg("rect", { x: x0, y: y + 7, width, height: 9, rx: 2, class: `tl-bar${row.bar.ongoing ? " tl-bar--ongoing" : ""}` }),
              tip
            )
          );
          return;
        }

        // Which side the known stretch is on decides which way the dust
        // thickens. A first part is a head, so its core is to the right.
        const cloud = svg("g", { class: "tl-dust" });
        for (const grain of dustCloud({
          x0,
          x1: x0 + width,
          height: 13,
          seed: 97 + i * 31 + Math.round(x0),
          certainSide: i === 0 ? "right" : "left",
        })) {
          cloud.append(svg("circle", { cx: grain.x, cy: y + 5 + grain.y, r: grain.r, opacity: grain.opacity }));
        }
        group.append(titled(cloud, tip));
      });
    }

    for (const mark of row.marks) {
      const dot = svg("circle", {
        cx: at(mark.x),
        cy: y + 11.5,
        r: 4,
        class: `tl-mark${mark.future ? " tl-mark--future" : ""}`,
      });
      group.append(titled(dot, `${mark.iso}${mark.future ? " (ahead of today)" : ""} — ${mark.text}`));
    }

    parts.push(group);
  });

  els.timelineSvg.replaceChildren(...parts);
  renderUndated(scene.undated);
}

/**
 * The files with no event date.
 *
 * Listed rather than counted-and-hidden, and never given a position: updated:
 * is metadata about the file, not a claim about when anything happened.
 */
function renderUndated(undated) {
  if (!undated.length) {
    els.timelineUndated.replaceChildren();
    return;
  }

  const title = document.createElement("h3");
  title.className = "tl-undated-title";
  title.textContent = `${undated.length} file${undated.length === 1 ? "" : "s"} with no event date`;

  const note = document.createElement("p");
  note.className = "tl-undated-note";
  note.textContent =
    "These carry no occurred: span and no date in their prose. They are not placed on the axis, because updated: records when the file was edited, not when anything happened.";

  const list = document.createElement("ul");
  list.className = "tl-undated-list";
  for (const item of undated) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tl-undated-item";
    button.textContent = item.path;
    if (item.updated) button.title = `updated: ${item.updated}`;
    button.addEventListener("click", () => openFile(item.path));
    li.append(button);
    list.append(li);
  }

  els.timelineUndated.replaceChildren(title, note, list);
}

/** Domain options are built once per vault, so switching never rebuilds them. */
function renderTimelineDomains(chronology) {
  const domains = [...new Set(chronology.tracks.map((t) => t.domain))].sort();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All domains";
  const options = domains.map((domain) => {
    const option = document.createElement("option");
    option.value = domain;
    option.textContent = domain;
    return option;
  });
  els.timelineDomain.replaceChildren(all, ...options);
}

// Two controls carry a mark in their markup-free label. Setting it here rather
// than in index.html keeps every icon in one place, and keeps index.html from
// having to hand-write SVG it cannot recolour.
setIconLabel(els.fileBack, "arrow-left", "Back");
setIconLabel(els.graphHome, "arrow-left", "Domains");

els.openVault.addEventListener("click", openVault);
els.retry.addEventListener("click", openVault);
els.reload.addEventListener("click", openVault);

els.viewHealth.addEventListener("click", () => showOnly("summary"));
els.viewBrowse.addEventListener("click", () => showOnly("browse"));
els.viewGraph.addEventListener("click", () => {
  showOnly("graph");
  // Measured from a panel that was display:none until this moment, so the first
  // render always measures zero and falls back to the minimum. Same reason the
  // timeline re-renders here.
  renderStrip();
});
els.viewTimeline.addEventListener("click", () => {
  showOnly("timeline");
  // The width is measured from the panel, which is display:none until now — so
  // the first render inside render() always measures zero and falls back to the
  // minimum. Re-render once it can actually be measured.
  renderTimeline();
});

els.timelineDomain.addEventListener("change", renderTimeline);

// The width above is measured, so it has to be re-measured when the panel
// changes size. Redrawing ~20 rows is microseconds; a debounce would only add
// a timer to reason about.
window.addEventListener("resize", () => {
  if (!els.timeline.hidden) renderTimeline();
  if (!els.graph.hidden) renderStrip();
});

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

for (const [mode, ref] of [["raw", "modeRaw"], ["rendered", "modeRendered"]]) {
  els[ref].addEventListener("click", () => {
    if (state.mode === mode) return;
    state.mode = mode;
    // Re-render in place: switching view must not lose which file is open.
    if (state.path) renderFile(state.model.byPath.get(state.path));
  });
}

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
