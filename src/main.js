// main.js
//
// Wires the three modules together and puts the result on screen.
//
// The pipeline is one line of meaning:
//     pickVault() -> readVault() -> buildModel() -> render
//
// What this renders is deliberately plain: counts. It is the foundation's
// proof-of-life, not the health panel. If these numbers match what the vault's
// own bash audits report, the foundation is correct — and that same data is
// most of what the health panel will later need.

import { isSupported, pickVault, readVault, VaultAccessError } from "./vault-access.js";
import { buildModel } from "./model.js";

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
  counts: document.getElementById("counts"),
  domains: document.getElementById("domains"),
  problems: document.getElementById("problems"),
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
  renderCounts(model);
  renderDomains(model);
  renderProblems(model);
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

/**
 * Structural problems the model can see on its own.
 *
 * Deliberately excludes anything threshold-based — staleness and size caps need
 * numbers that belong with the health panel, not here. This is only what is
 * true by construction: a topic owned twice, a link that does not resolve,
 * frontmatter that would not parse.
 */
function renderProblems(model) {
  const problems = [];

  for (const [topic, files] of model.byTopic) {
    if (files.length > 1) {
      problems.push(["bad", `Topic "${topic}" is owned by ${files.length} files`, files.map((f) => f.path).join("  ·  ")]);
    }
  }

  for (const link of model.links) {
    if (link.status === "broken") {
      problems.push(["bad", `Broken link [[${link.target}]]`, link.from]);
    } else if (link.status === "ambiguous") {
      problems.push(["warn", `Ambiguous link [[${link.target}]] — ${link.candidates.length} candidates`, link.candidates.join("  ·  ")]);
    }
  }

  for (const warning of model.warnings) {
    problems.push(["warn", warning, ""]);
  }

  if (problems.length === 0) {
    problems.push(["ok", "No structural problems found", "no duplicate topics, no unresolved links, no parse warnings"]);
  }

  els.problems.replaceChildren(
    ...problems.map(([level, text, detail]) => {
      const li = document.createElement("li");
      li.className = `problem problem--${level}`;

      const mark = document.createElement("span");
      mark.className = "problem-mark";
      mark.textContent = level === "ok" ? "OK" : level === "warn" ? "!" : "X";

      const body = document.createElement("span");
      body.textContent = text;

      li.append(mark, body);

      if (detail) {
        const d = document.createElement("span");
        d.className = "problem-detail";
        d.textContent = detail;
        li.append(d);
      }
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
