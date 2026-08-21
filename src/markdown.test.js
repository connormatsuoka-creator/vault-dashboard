// markdown.test.js
//
// Run with:  node --test src/markdown.test.js
//
// Most of these come from measuring the real vault rather than from a spec. The
// cases that matter here are the ones that actually occur: 99 lines with inline
// code holding markdown characters, 18 with code nested inside bold, and 83 of
// 88 wiki-links written inside backticks.

import test from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, tokenize } from "./markdown.js";

const RES = new Map([
  ["target", { status: "resolved", resolvedPath: "a/target.md" }],
  ["gone", { status: "broken", resolvedPath: null }],
]);

const parse = (md) => parseMarkdown(md, RES);
const tok = (text) => tokenize(text, RES);
/** Flatten a token tree back to its visible text. */
const flat = (nodes) =>
  nodes.map((t) => (t.children ? flat(t.children) : t.type === "link" ? `[[${t.target}]]` : t.value)).join("");

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

test("headings carry their level", () => {
  const b = parse("# One\n\n## Two\n\n### Three\n");
  assert.deepEqual(b.map((x) => x.level), [1, 2, 3]);
  assert.equal(flat(b[1].inline), "Two");
});

test("a hash without a space is not a heading", () => {
  const b = parse("#notaheading is prose\n");
  assert.equal(b[0].type, "paragraph");
});

test("hard-wrapped lines rejoin into one paragraph", () => {
  // The vault wraps at ~95 chars; joining is what restores the sentence.
  const b = parse("one line\nsecond line\nthird line\n\nnew para\n");
  assert.equal(b.length, 2);
  assert.equal(flat(b[0].inline), "one line second line third line");
});

test("bullet and numbered lists", () => {
  const b = parse("- a\n- b\n\n1. first\n2. second\n");
  assert.equal(b[0].type, "list");
  assert.equal(b[0].ordered, false);
  assert.deepEqual(b[0].items.map(flat), ["a", "b"]);
  assert.equal(b[1].ordered, true);
  assert.deepEqual(b[1].items.map(flat), ["first", "second"]);
});

test("switching bullet style starts a new list", () => {
  const b = parse("- a\n1. b\n");
  assert.equal(b.length, 2);
  assert.equal(b[0].ordered, false);
  assert.equal(b[1].ordered, true);
});

test("a table needs a separator row", () => {
  const table = parse("| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(table[0].type, "table");
  assert.deepEqual(table[0].head.map(flat), ["a", "b"]);
  assert.deepEqual(table[0].rows[0].map(flat), ["1", "2"]);

  // Pipes alone are just prose — a line of them must not become a table.
  assert.equal(parse("this | has | pipes\nand more\n")[0].type, "paragraph");
});

test("table alignment is read from the separator", () => {
  const b = parse("| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
  assert.deepEqual(b[0].align, ["left", "center", "right"]);
});

test("a ragged row is padded rather than collapsing the table", () => {
  const b = parse("| a | b | c |\n|---|---|---|\n| 1 | 2 |\n");
  assert.equal(b[0].rows[0].length, 3);
  assert.deepEqual(b[0].rows[0].map(flat), ["1", "2", ""]);
});

test("blockquotes join and keep their markup", () => {
  const b = parse("> **Pointers may be duplicated freely.**\n> Facts may never be.\n");
  assert.equal(b[0].type, "quote");
  assert.equal(flat(b[0].inline), "Pointers may be duplicated freely. Facts may never be.");
  assert.equal(b[0].inline[0].type, "strong");
});

test("fenced code keeps its content and language verbatim", () => {
  const b = parse("```bash\ngrep -rn '**not bold**' .\n```\n");
  assert.equal(b[0].type, "code");
  assert.equal(b[0].lang, "bash");
  assert.equal(b[0].text, "grep -rn '**not bold**' .");
});

test("indented code is code, with the indent removed", () => {
  const b = parse("text\n\n    node tools/duplication.mjs\n\nmore\n");
  const code = b.find((x) => x.type === "code");
  assert.equal(code.text, "node tools/duplication.mjs");
});

test("an unclosed fence still yields its content", () => {
  const b = parse("```\nstill here\n");
  assert.equal(b[0].type, "code");
  assert.match(b[0].text, /still here/);
});

test("a horizontal rule is its own block", () => {
  assert.equal(parse("a\n\n---\n\nb\n")[1].type, "rule");
});

test("an empty body produces no blocks", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse("\n\n   \n"), []);
});

// ---------------------------------------------------------------------------
// Inline — the measured cases
// ---------------------------------------------------------------------------

test("inline code is literal, even when it holds markdown", () => {
  // 99 lines in the vault do this. A replace-chain parser eats them.
  const t = tok("the `**bold**` literal");
  assert.deepEqual(t.map((x) => x.type), ["text", "code", "text"]);
  assert.equal(t[1].value, "**bold**");
});

test("an underscore inside code does not become emphasis", () => {
  const t = tok("read `_index.md` first");
  assert.equal(t[1].type, "code");
  assert.equal(t[1].value, "_index.md");
  assert.ok(!t.some((x) => x.type === "em"));
});

test("a wiki-link inside code is still a link, and marked as code", () => {
  // 83 of the vault's 88 links are written this way. Treating code as inert
  // here would silently kill almost all of them.
  const t = tok("see `[[target]]` here");
  const link = t.find((x) => x.type === "link");
  assert.equal(link.target, "target");
  assert.equal(link.status, "resolved");
  assert.equal(link.inCode, true);
});

test("bold containing inline code keeps the code span", () => {
  // 18 real lines. A flat tokenizer prints the backticks instead.
  const t = tok("**read `sys/setup.md` first**");
  assert.equal(t[0].type, "strong");
  assert.deepEqual(t[0].children.map((c) => c.type), ["text", "code", "text"]);
  assert.equal(t[0].children[1].value, "sys/setup.md");
});

test("bold and italic coexist on one line", () => {
  const t = tok("*soft* and **hard**");
  assert.deepEqual(t.map((x) => x.type), ["em", "text", "strong"]);
});

test("an unmatched delimiter stays literal text", () => {
  assert.equal(flat(tok("a * b c")), "a * b c");
  assert.equal(flat(tok("**unclosed bold")), "**unclosed bold");
  assert.equal(flat(tok("an ` unclosed backtick")), "an ` unclosed backtick");
});

test("empty emphasis is just characters", () => {
  assert.equal(flat(tok("nothing ** here")), "nothing ** here");
});

test("emphasis does not close on a delimiter inside a code span", () => {
  const t = tok("**a `x**y` b**");
  assert.equal(t[0].type, "strong");
  assert.equal(flat(t[0].children), "a x**y b");
});

test("a link with no resolution is reported unknown rather than assumed good", () => {
  const [link] = tokenize("`[[target]]`", new Map()).filter((x) => x.type === "link");
  assert.equal(link.status, "unknown");
});

test("a broken link keeps its status through the tokenizer", () => {
  const link = tok("`[[gone]]`").find((x) => x.type === "link");
  assert.equal(link.status, "broken");
  assert.equal(link.resolvedPath, null);
});

// ---------------------------------------------------------------------------
// Tables carry real markup — 66 cells hold code, 19 bold, 6 wiki-links
// ---------------------------------------------------------------------------

test("table cells run the full inline tokenizer", () => {
  const b = parse("| File | What |\n|---|---|\n| `capture.md` | **Filling** it, see `[[target]]` |\n");
  const [nameCell, whatCell] = b[0].rows[0];
  assert.equal(nameCell[0].type, "code");
  assert.equal(whatCell[0].type, "strong");
  assert.ok(whatCell.some((x) => x.type === "link" && x.target === "target"));
});

test("a table header can hold markup too", () => {
  const b = parse("| **Bold** | `code` |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(b[0].head[0][0].type, "strong");
  assert.equal(b[0].head[1][0].type, "code");
});

test("a pipe inside a code span still splits the cell", () => {
  // Known and accepted: escaping pipes in cells is not something the vault
  // does, and supporting it costs more than it is worth. Asserted so the
  // behaviour is deliberate rather than discovered.
  const b = parse("| a | `x|y` |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(b[0].head.length, 3);
});

// ---------------------------------------------------------------------------
// List continuation — 75 lines across 12 files, all found by looking at the
// rendered router rather than by any test
// ---------------------------------------------------------------------------

test("an indented continuation line joins its item instead of splitting the list", () => {
  const b = parse("0. First thing\n   continued here\n1. Second\n2. Third\n   also continued\n");
  assert.equal(b.length, 1, "the list must stay one block");
  assert.deepEqual(b[0].items.map(flat), [
    "First thing continued here",
    "Second",
    "Third also continued",
  ]);
});

test("an ordered list keeps the number it starts at", () => {
  // The router's session-start list begins at 0. Renumbering from 1 changes
  // what the document says.
  assert.equal(parse("0. zero\n1. one\n")[0].start, 0);
  assert.equal(parse("3. three\n4. four\n")[0].start, 3);
  assert.equal(parse("1. one\n")[0].start, 1);
});

test("an unindented line still ends the list", () => {
  const b = parse("- a\n- b\nplain paragraph text\n");
  assert.equal(b.length, 2);
  assert.equal(b[0].items.length, 2);
  assert.equal(b[1].type, "paragraph");
});

test("a continuation line keeps its inline markup", () => {
  const b = parse("1. Start here\n   and `code` plus **bold** on the next line\n");
  const types = b[0].items[0].map((t) => t.type);
  assert.ok(types.includes("code"));
  assert.ok(types.includes("strong"));
});
