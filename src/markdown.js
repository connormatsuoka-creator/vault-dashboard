// markdown.js
//
// Parses the markdown this vault actually contains — measured, not guessed —
// into a block tree. It builds no DOM. Same seam as graph.js's scene: this
// decides structure, the renderer decides shapes, and that is what makes it
// testable in Node rather than judged by eye in a browser.
//
// WHAT THE VAULT NEEDS, AND WHAT IT DOES NOT
//
// Present: headings (3 levels), bold, single-* italic, inline code, tables,
// bullet and numbered lists, blockquotes, fenced and indented code, one rule.
//
// Absent everywhere: nested lists, escaped markdown characters, nested
// blockquotes, headings past ###, images, task lists. **The vault has no block
// nesting at all**, which is what makes a two-pass parser correct here rather
// than merely adequate.
//
// THE TWO RULES THAT MAKE IT CORRECT
//
// 1. At every position, code spans and wiki-links are checked BEFORE emphasis.
//    99 lines carry inline code holding characters a naive parser would eat —
//    `_index.md`, `**bold**`, `[[target]]`. Checking code first is why they
//    survive. Emphasis then recurses into its own content, because 18 lines
//    wrap inline code in bold and a flat scan would print their backticks.
//
// 2. A code span is literal EXCEPT that wiki-links inside it still resolve.
//    Strict markdown says code is inert, but 83 of this vault's 88 links are
//    written inside backticks — that is the house style, and segmentBody
//    already made the same call. Honouring markdown here would silently kill
//    94% of the links.

import { classifyLines, LINK_SOURCE } from "./model.js";

/** Anchored at a position, for the left-to-right scan below. */
const linkAt = () => new RegExp(LINK_SOURCE, "y");

/**
 * @typedef {{type:'text',value:string}
 *         | {type:'code',value:string}
 *         | {type:'link',target:string,status:string,resolvedPath:string|null,inCode:boolean}
 *         | {type:'strong'|'em',children:Inline[]}} Inline
 */

/**
 * Parse a file body into blocks.
 *
 * @param {string} body
 * @param {Map<string,{status:string,resolvedPath:string|null}>} resolutions
 * @returns {Array<object>} blocks
 */
export function parseMarkdown(body, resolutions = new Map()) {
  const lines = classifyLines(body);
  const blocks = [];
  let i = 0;

  const inline = (text) => tokenize(text, resolutions);

  while (i < lines.length) {
    const { line, isCode } = lines[i];

    // ---- fenced and indented code ----------------------------------------
    // classifyLines already decided what is code; trusting it is what keeps
    // this parser and the link audit agreeing about the same document.
    if (isCode) {
      const start = i;
      const fenced = /^\s*```/.test(line);
      const lang = fenced ? line.replace(/^\s*```/, "").trim() : "";
      if (fenced) i++;

      const collected = [];
      while (i < lines.length && lines[i].isCode) {
        if (fenced && /^\s*```/.test(lines[i].line)) { i++; break; }
        collected.push(fenced ? lines[i].line : lines[i].line.replace(/^ {4}/, ""));
        i++;
      }
      // A fence that opens and never closes still has content worth showing.
      if (collected.length || i > start) blocks.push({ type: "code", lang, text: collected.join("\n") });
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // ---- horizontal rule --------------------------------------------------
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // ---- heading ----------------------------------------------------------
    // The space is required: "#tag" is not a heading, and treating it as one
    // would swallow a line of prose.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: inline(heading[2].trim()) });
      i++;
      continue;
    }

    // ---- table ------------------------------------------------------------
    // A table is a header row followed by a separator row. Without the
    // separator it is just a line that happens to contain pipes.
    if (isRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1].line)) {
      const head = cells(line).map(inline);
      const align = alignments(lines[i + 1].line);
      i += 2;

      const rows = [];
      while (i < lines.length && !lines[i].isCode && isRow(lines[i].line)) {
        const row = cells(lines[i].line).map(inline);
        // Pad or trim so every row matches the header. A ragged table should
        // render as a table with a blank cell, not collapse into prose.
        while (row.length < head.length) row.push([]);
        rows.push(row.slice(0, head.length));
        i++;
      }
      blocks.push({ type: "table", head, align, rows });
      continue;
    }

    // ---- blockquote -------------------------------------------------------
    if (/^\s*>/.test(line)) {
      const collected = [];
      while (i < lines.length && !lines[i].isCode && /^\s*>/.test(lines[i].line)) {
        collected.push(lines[i].line.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", inline: inline(collected.join(" ").trim()) });
      continue;
    }

    // ---- list -------------------------------------------------------------
    const bullet = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      // The router's session-start list begins at 0. Renumbering it from 1
      // quietly changes what the document says.
      const start = ordered ? parseInt(bullet[1], 10) : 1;
      const items = [];

      while (i < lines.length && !lines[i].isCode) {
        const m = lines[i].line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        let text = m[2].trim();
        i++;

        // Absorb continuation lines — indented, not a new bullet. 75 of these
        // exist across 12 files, all at 2 or 3 spaces, which is why they never
        // collide with the 4-space indented-code rule. Without this, an item's
        // second line splits the list in two and the numbering restarts.
        while (
          i < lines.length &&
          !lines[i].isCode &&
          lines[i].line.trim() &&
          /^\s{2,}/.test(lines[i].line) &&
          !/^\s*([-*+]|\d+\.)\s+(.*)$/.test(lines[i].line)
        ) {
          text += " " + lines[i].line.trim();
          i++;
        }

        items.push(inline(text));
      }

      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    // ---- paragraph --------------------------------------------------------
    // Runs until a blank line or anything that starts a different block. The
    // vault hard-wraps its prose, so joining is what restores the sentence.
    const collected = [];
    while (i < lines.length && !lines[i].isCode && lines[i].line.trim() && !startsBlock(lines, i)) {
      collected.push(lines[i].line.trim());
      i++;
    }
    if (collected.length) blocks.push({ type: "paragraph", inline: inline(collected.join(" ")) });
    else i++; // never stall
  }

  return blocks;
}

/** Would this line begin a block other than a paragraph? */
function startsBlock(lines, i) {
  const line = lines[i].line;
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    (isRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1].line))
  );
}

const isRow = (line) => /^\s*\|.*\|\s*$/.test(line.trim()) || /^\s*\|/.test(line);
const isSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-") && line.includes("|");

/** Split a row on unescaped pipes, dropping the leading and trailing ones. */
function cells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function alignments(separator) {
  return cells(separator).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
  );
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * Left-to-right scan producing inline tokens.
 *
 * The order of the checks IS the correctness argument. Code and links are
 * consumed first at every position, so `**bold**` inside backticks is never
 * seen as emphasis. Emphasis then recurses, so **bold with `code`** — which
 * occurs 18 times in this vault — keeps its code span instead of printing
 * backticks.
 *
 * Unmatched delimiters degrade to text rather than swallowing the rest of the
 * line, because a stray asterisk in prose is far more likely than an author
 * meaning emphasis to run to the end of a paragraph.
 */
export function tokenize(text, resolutions = new Map()) {
  const out = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) out.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (i < text.length) {
    // --- inline code (may still contain a wiki-link) ---
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        out.push(...codeSpan(text.slice(i + 1, end), resolutions));
        i = end + 1;
        continue;
      }
    }

    // --- wiki-link ---
    if (text.startsWith("[[", i)) {
      const re = linkAt();
      re.lastIndex = i;
      const m = re.exec(text);
      if (m) {
        flush();
        out.push(linkToken(m[1].trim(), resolutions, false));
        i = re.lastIndex;
        continue;
      }
    }

    // --- bold, then italic ---
    const emphasis = tryEmphasis(text, i, resolutions);
    if (emphasis) {
      flush();
      out.push(emphasis.token);
      i = emphasis.next;
      continue;
    }

    buffer += text[i];
    i++;
  }

  flush();
  return out;
}

/**
 * Try to open emphasis at this position, longest marker first.
 *
 * Returns the token and where the scan resumes, or null. Written as a helper
 * because the alternative — a loop over markers inside the main scan — cannot
 * `continue` the outer loop, and every workaround for that is worse than this.
 *
 * An unmatched or empty delimiter returns null, so a stray asterisk in prose
 * stays a stray asterisk instead of italicising the rest of the line.
 */
function tryEmphasis(text, i, resolutions) {
  for (const [marker, type] of [["**", "strong"], ["*", "em"]]) {
    if (!text.startsWith(marker, i)) continue;
    const end = findClose(text, i + marker.length, marker);
    if (end === -1) continue;
    const inner = text.slice(i + marker.length, end);
    if (!inner.trim()) continue;
    return { token: { type, children: tokenize(inner, resolutions) }, next: end + marker.length };
  }
  return null;
}

/**
 * Find the closing delimiter, skipping any that sit inside a code span.
 *
 * Without the skip, `a **b `x**y` c**` would close on the asterisks inside the
 * backticks and produce nonsense.
 */
function findClose(text, from, marker) {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith(marker, i)) {
      // For single "*", a "**" here is a different delimiter, not this one.
      if (marker === "*" && text.startsWith("**", i)) { i += 2; continue; }
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * A code span. Literal, except that wiki-links inside it still resolve — see
 * the note at the top of this file for why that is not a markdown bug.
 */
function codeSpan(content, resolutions) {
  const re = linkAt();
  const out = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) out.push({ type: "code", value: buffer });
    buffer = "";
  };

  while (i < content.length) {
    if (content.startsWith("[[", i)) {
      re.lastIndex = i;
      const m = re.exec(content);
      if (m) {
        flush();
        out.push(linkToken(m[1].trim(), resolutions, true));
        i = re.lastIndex;
        continue;
      }
    }
    buffer += content[i];
    i++;
  }

  flush();
  return out.length ? out : [{ type: "code", value: "" }];
}

function linkToken(target, resolutions, inCode) {
  const r = resolutions.get(target) ?? { status: "unknown", resolvedPath: null };
  return { type: "link", target, status: r.status, resolvedPath: r.resolvedPath, inCode };
}
