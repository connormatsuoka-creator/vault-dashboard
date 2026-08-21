// health.js
//
// The vault's own audits, run against the model.
//
// Every check returns the same shape, so main.js never special-cases one. Each
// produces a single summary line for the default view and a list of items shown
// only when the row is expanded — because computing every check is cheap
// forever, but rendering every result stops being useful long before it stops
// being fast. Eight rows regardless of vault size.
//
// ---------------------------------------------------------------------------
// ON THE THRESHOLDS BELOW — read before changing anything here.
//
// These numbers are NOT owned by this file. The vault's own router states them,
// and the vault is authoritative. What lives here is a derived copy, which the
// vault's rules permit only because it names its source and yields to it — and
// because the UI displays these values, so a divergence is visible on the next
// load rather than silently wrong for months.
//
// The intended end state is that the vault exposes them and this constant
// becomes a fallback. That migration is deliberately one line at the call site:
//
//     runHealthChecks(model, THRESHOLDS)                       <- today
//     runHealthChecks(model, loadThresholds(model) ?? THRESHOLDS)  <- later
//
// which works only because thresholds are a PARAMETER of runHealthChecks rather
// than a module global. Do not "simplify" that by reading THRESHOLDS directly
// inside the check functions — that is what closes the door.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  source: "vault CLAUDE.md — Size caps and Staleness",
  caps: { router: 80, index: 40, leaf: 150 },
  // Paths the vault exempts from its caps. Data rather than a special case buried
  // in the check, so the list renders on screen beside the caps themselves — an
  // exemption nobody can see is indistinguishable from a check that quietly broke.
  capExempt: ["system/setup.md"],
  inboxMax: 15,
  staleDays: 30,
  // Fractions of a limit at which a check warns instead of passing. Pass/fail
  // alone is too coarse: a file at 91% of its cap is fine today and not fine
  // next week, and that is exactly when it is cheap to act.
  warnAtFraction: 0.85,
  warnAtInbox: 12,
  warnAtStaleDays: 21,
};

/** Where the vault keeps the real numbers. */
const CONFIG_PATH = "system/config.md";

/**
 * Read the thresholds from the vault, falling back per key.
 *
 * THRESHOLDS above is no longer the authority — it is the fallback for when the
 * vault cannot be read. The vault owns these numbers; this file keeps a copy so
 * the dashboard still runs against a folder that has no config, and says which
 * of the two it used.
 *
 * **Per key, not all-or-nothing.** One typo'd line should cost you that one
 * value, not silently revert every threshold to a copy that may be months old.
 *
 * A value that is present but nonsense — a negative cap, a fraction of 5 —
 * falls back too. Frontmatter values arrive as strings, so everything here is
 * coerced and range-checked rather than trusted.
 */
export function loadThresholds(model, fallback = THRESHOLDS) {
  const file = model?.byPath?.get(CONFIG_PATH);
  if (!file || !file.hasFrontmatter) {
    return { ...fallback, source: `built-in fallback — this vault has no ${CONFIG_PATH}` };
  }

  const fellBack = [];

  const num = (key, current, ok = (n) => n > 0) => {
    const raw = file.data[key];
    if (raw === undefined) { fellBack.push(key); return current; }
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) { fellBack.push(key); return current; }
    return n;
  };

  const list = (key, current) => {
    const raw = file.data[key];
    if (raw === undefined) { fellBack.push(key); return current; }
    return Array.isArray(raw) ? raw : [raw];
  };

  const isFraction = (n) => n > 0 && n <= 1;

  const t = {
    caps: {
      router: num("cap-router", fallback.caps.router),
      index: num("cap-index", fallback.caps.index),
      leaf: num("cap-leaf", fallback.caps.leaf),
    },
    capExempt: list("cap-exempt", fallback.capExempt ?? []),
    inboxMax: num("inbox-max", fallback.inboxMax),
    staleDays: num("stale-days", fallback.staleDays),
    warnAtFraction: num("warn-at-fraction", fallback.warnAtFraction, isFraction),
    warnAtInbox: num("warn-at-inbox", fallback.warnAtInbox),
    warnAtStaleDays: num("warn-at-stale-days", fallback.warnAtStaleDays),
  };

  // Naming the source is the whole safety mechanism for a duplicated number: a
  // divergence shows up on the next load instead of being wrong for months.
  t.source =
    fellBack.length === 0
      ? `vault ${CONFIG_PATH}`
      : `vault ${CONFIG_PATH} — ${fellBack.length} fell back: ${fellBack.join(", ")}`;

  return t;
}

/** Values the vault's frontmatter contract allows. Anything else is a typo. */
const VOCABULARY = {
  status: ["hot", "cold"],
  confidence: ["stated", "inferred", "untested", "resolved"],
  sensitivity: ["normal", "private"],
};

const REQUIRED_FIELDS = ["updated", "status", "owns", "confidence", "sensitivity"];

/**
 * Run every check.
 *
 * @param {ReturnType<import("./model.js").buildModel>} model
 * @param {typeof THRESHOLDS} thresholds
 * @param {Date} [today] - injected so staleness is testable rather than
 *                         depending on when the test happens to run
 * @returns {Check[]}
 */
export function runHealthChecks(model, thresholds = THRESHOLDS, today = new Date()) {
  return [
    checkDrift(model),
    checkLinks(model),
    checkSizeCaps(model, thresholds),
    checkStaleness(model, thresholds, today),
    checkInbox(model, thresholds),
    checkFrontmatter(model),
    checkSchema(model),
    checkDateFormats(model),
  ];
}

/**
 * @typedef {Object} Check
 * @property {string} id
 * @property {string} label
 * @property {'pass'|'warn'|'fail'} status
 * @property {string} summary - one line, always visible
 * @property {Array<{text: string, detail?: string}>} items - shown when expanded
 */

const check = (id, label, status, summary, items = []) => ({ id, label, status, summary, items });

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** A topic claimed by two files is drift, by definition. No threshold involved. */
function checkDrift(model) {
  const duplicates = [...model.byTopic.entries()].filter(([, files]) => files.length > 1);

  if (duplicates.length === 0) {
    return check("drift", "Topic ownership", "pass", `${model.byTopic.size} topics, none owned twice`);
  }

  return check(
    "drift",
    "Topic ownership",
    "fail",
    `${duplicates.length} topic${duplicates.length === 1 ? "" : "s"} owned by more than one file`,
    duplicates.map(([topic, files]) => ({
      text: `"${topic}" claimed by ${files.length} files`,
      detail: files.map((f) => f.path).join("  ·  "),
    }))
  );
}

/**
 * Broken links fail. Ambiguous links warn — they resolve to *something*, which
 * is worse than failing, because whichever file wins depends on lookup order.
 */
function checkLinks(model) {
  const broken = model.links.filter((l) => l.status === "broken");
  const ambiguous = model.links.filter((l) => l.status === "ambiguous");
  const resolved = model.links.length - broken.length - ambiguous.length;

  const items = [
    ...broken.map((l) => ({ text: `Broken: [[${l.target}]]`, detail: `in ${l.from}` })),
    ...ambiguous.map((l) => ({
      text: `Ambiguous: [[${l.target}]] matches ${l.candidates.length} files`,
      detail: l.candidates.join("  ·  "),
    })),
  ];

  const status = broken.length ? "fail" : ambiguous.length ? "warn" : "pass";
  return check(
    "links",
    "Links",
    status,
    `${resolved} resolve, ${broken.length} broken, ${ambiguous.length} ambiguous`,
    items
  );
}

/** Which cap applies depends on the file's role, matching the vault's rules. */
function capFor(path, thresholds) {
  const { caps, capExempt = [] } = thresholds;
  // Infinity rather than an early return: both the over-cap test and the
  // approaching-cap fraction below then fall out correctly with no second branch.
  if (capExempt.includes(path)) return { cap: Infinity, kind: "exempt" };
  if (!path.includes("/")) return { cap: caps.router, kind: "router" };
  if (path.endsWith("_index.md")) return { cap: caps.index, kind: "index" };
  return { cap: caps.leaf, kind: "leaf" };
}

function checkSizeCaps(model, thresholds) {
  const over = [];
  const approaching = [];

  for (const file of model.files) {
    const { cap, kind } = capFor(file.path, thresholds);
    const fraction = file.lineCount / cap;

    if (file.lineCount > cap) {
      over.push({ text: `${file.path} is over the ${kind} cap`, detail: `${file.lineCount}/${cap} lines` });
    } else if (fraction >= thresholds.warnAtFraction) {
      approaching.push({
        text: `${file.path} is near the ${kind} cap`,
        detail: `${file.lineCount}/${cap} lines — ${Math.round(fraction * 100)}%`,
      });
    }
  }

  if (over.length) {
    return check("caps", "Size caps", "fail", `${over.length} file${over.length === 1 ? "" : "s"} over cap`, [
      ...over,
      ...approaching,
    ]);
  }
  if (approaching.length) {
    return check(
      "caps",
      "Size caps",
      "warn",
      `${approaching.length} file${approaching.length === 1 ? "" : "s"} at ${Math.round(thresholds.warnAtFraction * 100)}%+ of cap`,
      approaching
    );
  }
  return check("caps", "Size caps", "pass", `all ${model.files.length} files within cap`);
}

/**
 * Only `status: hot` files can be stale — cold files are stable by definition,
 * which is what the status field is for.
 */
function checkStaleness(model, thresholds, today) {
  const hot = model.files.filter((f) => f.data.status === "hot");
  const aged = [];

  for (const file of hot) {
    const days = daysSince(file.data.updated, today);
    if (days === null) continue; // unparseable dates are the date check's problem
    aged.push({ file, days });
  }

  aged.sort((a, b) => b.days - a.days);

  const stale = aged.filter((a) => a.days > thresholds.staleDays);
  const ageing = aged.filter((a) => a.days > thresholds.warnAtStaleDays && a.days <= thresholds.staleDays);

  // Even when passing, report the oldest — a check that says only "OK" teaches
  // nothing about how close it came.
  const oldest = aged[0];
  const passSummary = oldest
    ? `${hot.length} hot files, oldest ${oldest.days} day${oldest.days === 1 ? "" : "s"} old`
    : `${hot.length} hot files`;

  const toItems = (list) =>
    list.map(({ file, days }) => ({ text: file.path, detail: `updated ${file.data.updated} — ${days} days ago` }));

  if (stale.length) {
    return check("staleness", "Staleness", "fail", `${stale.length} hot file${stale.length === 1 ? "" : "s"} over ${thresholds.staleDays} days old`, toItems([...stale, ...ageing]));
  }
  if (ageing.length) {
    return check("staleness", "Staleness", "warn", `${ageing.length} hot file${ageing.length === 1 ? "" : "s"} over ${thresholds.warnAtStaleDays} days old`, toItems(ageing));
  }
  return check("staleness", "Staleness", "pass", passSummary, toItems(aged));
}

/**
 * Inbox depth counts ITEMS, not lines — the file has a header, so counting
 * lines would report ~10 for an empty inbox and fire the trigger far too early.
 * That exact bug existed in the vault's router before it was caught.
 */
function checkInbox(model, thresholds) {
  const inbox = model.files.find((f) => f.path.endsWith("system/inbox.md"));
  if (!inbox) {
    return check("inbox", "Inbox", "warn", "no system/inbox.md found");
  }

  const items = inbox.body.split(/\r?\n/).filter((line) => /^-\s+/.test(line));
  const n = items.length;
  const preview = items.slice(0, 20).map((line) => ({ text: line.replace(/^-\s+/, "") }));

  if (n > thresholds.inboxMax) {
    return check("inbox", "Inbox", "fail", `${n} items — over the cap of ${thresholds.inboxMax}, reconcile before other work`, preview);
  }
  if (n >= thresholds.warnAtInbox) {
    return check("inbox", "Inbox", "warn", `${n} items, approaching the cap of ${thresholds.inboxMax}`, preview);
  }
  return check("inbox", "Inbox", "pass", `${n} item${n === 1 ? "" : "s"} (cap ${thresholds.inboxMax})`, preview);
}

/**
 * Parse warnings, plus files with no frontmatter at all.
 *
 * The router is exempt. A root-level file is the vault's router, which owns no
 * facts and deliberately carries no frontmatter — flagging it would train the
 * reader to ignore this check, which is worse than not running it. Same rule
 * used by capFor() to decide which cap applies.
 */
function checkFrontmatter(model) {
  const isRouter = (f) => !f.path.includes("/");
  const missing = model.files.filter((f) => !f.hasFrontmatter && !isRouter(f));
  const withFm = model.files.filter((f) => f.hasFrontmatter).length;

  const items = [
    ...model.warnings.map((w) => ({ text: w })),
    ...missing.map((f) => ({ text: `${f.path} has no frontmatter`, detail: "expected for the router, not for leaf files" })),
  ];

  if (model.warnings.length) {
    return check("frontmatter", "Frontmatter", "fail", `${model.warnings.length} parse warning${model.warnings.length === 1 ? "" : "s"}`, items);
  }
  if (missing.length) {
    return check("frontmatter", "Frontmatter", "warn", `${withFm} parsed, ${missing.length} without frontmatter`, items);
  }
  return check("frontmatter", "Frontmatter", "pass", `${withFm} parsed, 0 warnings`);
}

/**
 * Values outside the documented vocabulary, and missing required fields.
 *
 * Nothing else catches this: `status: warm` parses perfectly and is silently
 * meaningless, so every check keyed on status quietly skips that file.
 */
function checkSchema(model) {
  const problems = [];

  for (const file of model.files) {
    if (!file.hasFrontmatter) continue; // the frontmatter check owns that case

    for (const [field, allowed] of Object.entries(VOCABULARY)) {
      const value = file.data[field];
      if (value !== undefined && !allowed.includes(value)) {
        problems.push({
          text: `${file.path}: ${field} = "${value}"`,
          detail: `expected one of: ${allowed.join(" | ")}`,
        });
      }
    }

    for (const field of REQUIRED_FIELDS) {
      if (file.data[field] === undefined) {
        problems.push({ text: `${file.path}: missing "${field}"`, detail: "required by the frontmatter contract" });
      }
    }
  }

  if (problems.length) {
    return check("schema", "Schema", "fail", `${problems.length} field problem${problems.length === 1 ? "" : "s"}`, problems);
  }
  return check("schema", "Schema", "pass", "all values within the documented vocabulary");
}

/**
 * Dates must match the documented format. Precision is allowed to vary — that
 * is the point of the format — so "2024" and "2024-06/2024-12" are both valid
 * and neither is normalised here.
 */
function checkDateFormats(model) {
  const problems = [];
  let dated = 0;

  for (const file of model.files) {
    if (file.data.updated !== undefined && !isIsoDate(file.data.updated)) {
      problems.push({ text: `${file.path}: updated = "${file.data.updated}"`, detail: "expected YYYY-MM-DD" });
    }
    if (file.data.occurred !== undefined) {
      dated++;
      if (!isOccurred(file.data.occurred)) {
        problems.push({
          text: `${file.path}: occurred = "${file.data.occurred}"`,
          detail: "expected YYYY[-MM[-DD]] , optionally /END or a trailing / for ongoing",
        });
      }
    }
  }

  if (problems.length) {
    return check("dates", "Date formats", "fail", `${problems.length} malformed date${problems.length === 1 ? "" : "s"}`, problems);
  }
  return check("dates", "Date formats", "pass", `${dated} occurred: value${dated === 1 ? "" : "s"}, all valid`);
}

// ---------------------------------------------------------------------------
// Date helpers
//
// These interpret dates for comparison. They never write an interpreted value
// back — the model keeps the original strings, because "2024" losing its
// imprecision is the one thing this vault's date schema exists to prevent.
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PART = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/** "2024" | "2024-06" | "2024-06-14" | "2024-06/2024-12" | "2026-08-15/" */
function isOccurred(value) {
  if (typeof value !== "string" || value === "") return false;
  const [start, end, ...rest] = value.split("/");
  if (rest.length) return false;
  if (!PART.test(start)) return false;
  if (end === undefined || end === "") return true; // no end, or ongoing
  return PART.test(end);
}

function daysSince(isoDate, today) {
  if (!isIsoDate(isoDate)) return null;
  const then = new Date(`${isoDate}T00:00:00`);
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((now - then) / 86_400_000);
}
