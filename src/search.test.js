// search.test.js
//
// Run with:  node --test src/search.test.js
//
// Node's built-in runner, so there is nothing to install — the repo has no
// package.json and should not grow one.
//
// These cover the pure layer only. That is the whole point: this project's
// recorded pattern is that pure modules got tests and were fine, while every
// bug that reached the browser came through code that needed a human gesture to
// run. Anything testable here should be tested here.

import test from "node:test";
import assert from "node:assert/strict";

import { buildModel, segmentBody } from "./model.js";
import { searchVault } from "./search.js";

/** Build a model from inline fixtures, exercising the real parser. */
function fixture(files) {
  return buildModel(Object.entries(files).map(([path, text]) => ({ path, text })));
}

const fm = (owns) => `---\nupdated: 2026-08-20\nstatus: hot\nowns: [${owns}]\n---\n`;

const VAULT = fixture({
  "system/capture.md": fm("capture-bar, push-hook") + "\n# Capture\n\nThe bar for capture.\nSee `[[reconciliation]]`.\n",
  "system/reconciliation.md": fm("reconciliation-procedure") + "\n# Reconciliation\n\nEmpties the inbox.\nSee `[[capture]]` and `[[capture]]` again.\n",
  "self/capture-notes.md": fm("note-taking") + "\n# Notes\n\nNothing relevant here.\n",
  "self/values.md": fm("hard-lines") + "\n# Values\n\nA line mentioning capture in prose.\nAnd capture again.\nAnd capture once more.\n",
  "system/broken.md": fm("orphan") + "\n# Broken\n\nSee `[[does-not-exist]]`.\n",
});

// ---------------------------------------------------------------------------
// searchVault
// ---------------------------------------------------------------------------

test("empty query returns nothing", () => {
  for (const q of ["", "   "]) {
    const r = searchVault(VAULT, q);
    assert.deepEqual(r.groups, []);
    assert.equal(r.total, 0);
  }
});

test("groups rank topic above path above body", () => {
  const r = searchVault(VAULT, "capture");
  assert.deepEqual(r.groups.map((g) => g.kind), ["topic", "path", "body"]);
});

test("an exact topic match leads its group", () => {
  // "push-hook" is exact; nothing else owns a topic containing it.
  const r = searchVault(VAULT, "push-hook");
  assert.equal(r.groups[0].kind, "topic");
  assert.equal(r.groups[0].results[0].path, "system/capture.md");
  assert.equal(r.groups[0].results[0].evidence, "push-hook");
});

test("a file appears only once, under its strongest match", () => {
  // capture.md matches by topic, by path AND in body. It must appear once.
  const r = searchVault(VAULT, "capture");
  const all = r.groups.flatMap((g) => g.results.map((x) => x.path));
  assert.equal(new Set(all).size, all.length, "duplicate paths across groups");
  assert.equal(r.groups[0].results.some((x) => x.path === "system/capture.md"), true);
});

test("matching is case-insensitive", () => {
  const lower = searchVault(VAULT, "capture");
  const upper = searchVault(VAULT, "CaPtUrE");
  assert.deepEqual(
    upper.groups.flatMap((g) => g.results.map((r) => r.path)),
    lower.groups.flatMap((g) => g.results.map((r) => r.path))
  );
});

test("no match returns empty groups, not an error", () => {
  const r = searchVault(VAULT, "zzzznotpresent");
  assert.deepEqual(r.groups, []);
  assert.equal(r.total, 0);
  assert.equal(r.truncated, 0);
});

test("body results count further matches in the same file", () => {
  const r = searchVault(VAULT, "capture");
  const body = r.groups.find((g) => g.kind === "body");
  const values = body.results.find((x) => x.path === "self/values.md");
  assert.equal(values.extra, 2, "three mentions = one shown + two extra");
});

test("offset and length always select the query inside evidence", () => {
  // The renderer highlights by slicing. A stale offset highlights the wrong
  // characters silently rather than throwing, so assert the invariant directly.
  for (const q of ["capture", "reconciliation", "line"]) {
    for (const g of searchVault(VAULT, q).groups) {
      for (const r of g.results) {
        const picked = r.evidence.slice(r.offset, r.offset + r.length).toLowerCase();
        assert.equal(picked, q, `${r.kind} ${r.path}: evidence "${r.evidence}" offset ${r.offset}`);
      }
    }
  }
});

test("a long line is windowed and the offset stays correct", () => {
  const filler = "padding words ".repeat(40); // ~560 chars before the match
  const v = fixture({ "a/long.md": fm("x") + "\n" + filler + "NEEDLE" + filler + "\n" });
  const r = searchVault(v, "needle");
  const hit = r.groups[0].results[0];
  assert.ok(hit.evidence.length < 200, `snippet not windowed: ${hit.evidence.length}`);
  assert.equal(hit.evidence.slice(hit.offset, hit.offset + hit.length).toLowerCase(), "needle");
});

test("the cap limits total results and reports the remainder", () => {
  const many = {};
  for (let i = 0; i < 30; i++) many[`d/f${i}.md`] = fm("t") + "\nwidget\n";
  const r = searchVault(fixture(many), "widget", 10);
  assert.equal(r.groups.reduce((n, g) => n + g.results.length, 0), 10);
  assert.equal(r.total, 30);
  assert.equal(r.truncated, 20);
});

// ---------------------------------------------------------------------------
// segmentBody
// ---------------------------------------------------------------------------

const resolutions = new Map([["target", { status: "resolved", resolvedPath: "a/target.md" }]]);

test("segments concatenate back to the original body", () => {
  const body = "Intro `[[target]]` here.\n\nMore text.\n";
  const out = segmentBody(body, resolutions)
    .map((s) => (s.type === "text" ? s.value : `[[${s.target}]]`))
    .join("");
  assert.equal(out, body);
});

test("brackets inside a fenced code block are not links", () => {
  const body = "Real `[[target]]` link.\n\n```bash\ngrep '\\[\\[target\\]\\]' .\n[[target]]\n```\n\nAfter.\n";
  const links = segmentBody(body, resolutions).filter((s) => s.type === "link");
  assert.equal(links.length, 1, "only the link outside the fence counts");
});

test("brackets inside an indented code block are not links", () => {
  const body = "Real `[[target]]` link.\n\n    [[target]]\n    more code\n\nAfter.\n";
  const links = segmentBody(body, resolutions).filter((s) => s.type === "link");
  assert.equal(links.length, 1);
});

test("segmentation agrees with the model's own link extraction", () => {
  // If these ever diverge, the browse view links something the audit never
  // checked. They share a regex specifically to make that impossible.
  for (const f of VAULT.files) {
    const res = new Map(
      VAULT.links.filter((l) => l.from === f.path).map((l) => [l.target, l])
    );
    const segs = segmentBody(f.body, res).filter((s) => s.type === "link");
    assert.equal(segs.length, f.linkTargets.length, f.path);
  }
});

test("link segments carry their resolution status", () => {
  const capture = VAULT.byPath.get("system/capture.md");
  const res = new Map(VAULT.links.filter((l) => l.from === capture.path).map((l) => [l.target, l]));
  const [link] = segmentBody(capture.body, res).filter((s) => s.type === "link");
  assert.equal(link.status, "resolved");
  assert.equal(link.resolvedPath, "system/reconciliation.md");

  const broken = VAULT.byPath.get("system/broken.md");
  const bres = new Map(VAULT.links.filter((l) => l.from === broken.path).map((l) => [l.target, l]));
  const [bad] = segmentBody(broken.body, bres).filter((s) => s.type === "link");
  assert.equal(bad.status, "broken");
  assert.equal(bad.resolvedPath, null);
});

test("a target missing from the map is reported, not rendered as working", () => {
  const [link] = segmentBody("See `[[target]]`.", new Map()).filter((s) => s.type === "link");
  assert.equal(link.status, "unknown");
});

// ---------------------------------------------------------------------------
// backlinks
// ---------------------------------------------------------------------------

test("backlinks invert resolved links and dedupe repeats", () => {
  // reconciliation.md links to capture twice; that is one backlink.
  assert.deepEqual(VAULT.backlinks.get("system/capture.md"), ["system/reconciliation.md"]);
  assert.deepEqual(VAULT.backlinks.get("system/reconciliation.md"), ["system/capture.md"]);
});

test("every file has a backlinks entry, and broken links create none", () => {
  for (const f of VAULT.files) assert.ok(Array.isArray(VAULT.backlinks.get(f.path)), f.path);
  const total = [...VAULT.backlinks.values()].reduce((n, v) => n + v.length, 0);
  const unique = new Set(
    VAULT.links.filter((l) => l.status === "resolved").map((l) => `${l.from}>${l.resolvedPath}`)
  ).size;
  assert.equal(total, unique);
});
