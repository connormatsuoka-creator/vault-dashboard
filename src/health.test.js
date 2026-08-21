// health.test.js
//
// Run with:  node --test src/health.test.js
//
// Covers loadThresholds, which is the piece that decides whether the numbers the
// panel checks against came from the vault or from this repo's fallback copy.
// Getting that wrong is quiet — the panel still renders, just against the wrong
// figures — so the source string is asserted as carefully as the values.

import test from "node:test";
import assert from "node:assert/strict";

import { buildModel } from "./model.js";
import { loadThresholds, THRESHOLDS } from "./health.js";

const CONFIG = "system/config.md";

/** A model containing one config file with the given frontmatter body. */
function withConfig(lines) {
  return buildModel([
    { path: CONFIG, text: `---\n${lines}\n---\n\n# Config\n` },
    { path: "self/a.md", text: "---\nupdated: 2026-08-21\nstatus: hot\n---\n\ntext\n" },
  ]);
}

const FULL = [
  "updated: 2026-08-21",
  "status: cold",
  "owns: [vault-thresholds]",
  "cap-router: 90",
  "cap-index: 45",
  "cap-leaf: 200",
  "cap-exempt: [system/setup.md, system/other.md]",
  "inbox-max: 25",
  "stale-days: 60",
  "warn-at-fraction: 0.75",
  "warn-at-inbox: 20",
  "warn-at-stale-days: 45",
].join("\n");

test("no config file falls back entirely, and says so", () => {
  const model = buildModel([{ path: "self/a.md", text: "---\nstatus: hot\n---\n\nx\n" }]);
  const t = loadThresholds(model);
  assert.equal(t.caps.leaf, THRESHOLDS.caps.leaf);
  assert.equal(t.inboxMax, THRESHOLDS.inboxMax);
  assert.match(t.source, /built-in fallback/);
  assert.match(t.source, /system\/config\.md/);
});

test("a complete config wins on every value", () => {
  const t = loadThresholds(withConfig(FULL));
  assert.deepEqual(t.caps, { router: 90, index: 45, leaf: 200 });
  assert.deepEqual(t.capExempt, ["system/setup.md", "system/other.md"]);
  assert.equal(t.inboxMax, 25);
  assert.equal(t.staleDays, 60);
  assert.equal(t.warnAtFraction, 0.75);
  assert.equal(t.warnAtInbox, 20);
  assert.equal(t.warnAtStaleDays, 45);
  assert.equal(t.source, `vault ${CONFIG}`);
});

test("frontmatter strings are coerced to numbers, not left as text", () => {
  const t = loadThresholds(withConfig(FULL));
  for (const v of [t.caps.router, t.caps.index, t.caps.leaf, t.inboxMax, t.staleDays, t.warnAtFraction]) {
    assert.equal(typeof v, "number", "a string here would break every comparison silently");
  }
});

test("a partial config falls back per key, and names which", () => {
  // Only two keys present. Everything else must come from the fallback — and
  // still work, rather than the whole file being rejected.
  const t = loadThresholds(withConfig("updated: 2026-08-21\ncap-leaf: 500\ninbox-max: 3"));
  assert.equal(t.caps.leaf, 500);
  assert.equal(t.inboxMax, 3);
  assert.equal(t.caps.router, THRESHOLDS.caps.router);
  assert.equal(t.staleDays, THRESHOLDS.staleDays);
  assert.match(t.source, /fell back/);
  assert.match(t.source, /cap-router/);
  assert.ok(!/cap-leaf/.test(t.source), "a key that loaded must not be listed as fallen back");
});

test("a non-numeric value falls back rather than poisoning the check", () => {
  const t = loadThresholds(withConfig(FULL.replace("cap-leaf: 200", "cap-leaf: soon")));
  assert.equal(t.caps.leaf, THRESHOLDS.caps.leaf);
  assert.match(t.source, /cap-leaf/);
  assert.equal(t.caps.router, 90, "the other values must be unaffected");
});

test("nonsense-but-numeric values fall back too", () => {
  const bad = FULL
    .replace("cap-router: 90", "cap-router: -5")
    .replace("warn-at-fraction: 0.75", "warn-at-fraction: 5");
  const t = loadThresholds(withConfig(bad));
  assert.equal(t.caps.router, THRESHOLDS.caps.router, "a negative cap is not a cap");
  assert.equal(t.warnAtFraction, THRESHOLDS.warnAtFraction, "a fraction above 1 never warns");
});

test("a single cap-exempt entry still arrives as a list", () => {
  const t = loadThresholds(withConfig(FULL.replace("cap-exempt: [system/setup.md, system/other.md]", "cap-exempt: system/setup.md")));
  assert.deepEqual(t.capExempt, ["system/setup.md"]);
});

test("an explicit fallback is honoured over the built-in one", () => {
  const mine = { ...THRESHOLDS, caps: { router: 1, index: 2, leaf: 3 }, capExempt: [] };
  const t = loadThresholds(withConfig("updated: 2026-08-21"), mine);
  assert.deepEqual(t.caps, { router: 1, index: 2, leaf: 3 });
});

test("a config file with no frontmatter is treated as absent", () => {
  const model = buildModel([{ path: CONFIG, text: "# Config\n\nno frontmatter here\n" }]);
  assert.match(loadThresholds(model).source, /built-in fallback/);
});
