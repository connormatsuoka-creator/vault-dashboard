// model.test.js
//
// Run with:  node --test src/model.test.js
//
// Covers lineCount, which every cap check divides by and which a human reads off
// the panel and acts on. It was wrong by one for every file in the vault: splitting
// on newlines counts the terminator as opening a line that is not there. That
// rendered a 149-line system/decisions.md as 150/150 — the difference between "at
// the cap, split it" and "one line of room". Pure, importable, and never tested.

import test from "node:test";
import assert from "node:assert/strict";

import { buildModel } from "./model.js";

/** lineCount for a single file with the given raw text. */
function lines(text) {
  return buildModel([{ path: "self/a.md", text }]).files[0].lineCount;
}

test("a trailing newline terminates the last line, it does not open a new one", () => {
  assert.equal(lines("a\nb\n"), 2);
});

test("an unterminated final line still counts", () => {
  assert.equal(lines("a\nb"), 2);
});

test("CRLF counts the same as LF", () => {
  assert.equal(lines("a\r\nb\r\n"), 2);
  assert.equal(lines("a\r\nb"), 2);
});

test("a single line is one, terminated or not", () => {
  assert.equal(lines("a"), 1);
  assert.equal(lines("a\n"), 1);
});

test("an empty file is zero lines, not one", () => {
  assert.equal(lines(""), 0);
});

test("blank lines inside the file count", () => {
  assert.equal(lines("a\n\nb\n"), 3);
});

test("a file written to exactly the cap reports exactly the cap", () => {
  // The regression, at the size it actually mattered: 150 terminated lines must
  // read 150, not 151, or the panel calls a compliant file over its cap.
  const text = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  assert.equal(lines(text), 150);
});
