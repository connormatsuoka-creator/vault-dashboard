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
import { buildModel } from "./model.js";
import { runHealthChecks, THRESHOLDS } from "./health.js";

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
};

/**
 * Exactly one panel is visible at a time. Centralising this means no code path
 * can leave two panels showing or none at all — a class of bug that is tedious
 * to chase once several handlers each hide and show things independently.
 */
function showOnly(name) {
  for (const key of ["unsupported", "picker", "error", "loading", "summary"]) {
    els[key].hidden = key !== name;
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
  renderHealth(runHealthChecks(model, THRESHOLDS));
  renderThresholds(THRESHOLDS);
  renderCounts(model);
  renderDomains(model);
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
    `inbox ${t.inboxMax} items · stale ${t.staleDays}d · warn at ${Math.round(t.warnAtFraction * 100)}%  ` +
    `(source: ${t.source})`;
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
// Start
// ---------------------------------------------------------------------------

els.openVault.addEventListener("click", openVault);
els.retry.addEventListener("click", openVault);
els.reload.addEventListener("click", openVault);

if (isSupported()) {
  showOnly("picker");
} else {
  els.unsupportedDetail.textContent =
    "The File System Access API isn't available. Use Chrome or Edge, and make sure this " +
    "page is served over https or http://localhost — opening the file directly won't work, " +
    "because a file:// page has an opaque origin the browser won't grant folder access to.";
  showOnly("unsupported");
}
