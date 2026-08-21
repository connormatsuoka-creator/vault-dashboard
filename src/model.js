// model.js
//
// Turns a flat list of files into something you can ask questions of.
//
// The shape it produces is chosen so that the vault's own audits fall out of
// the data rather than needing separate logic. `byTopic` is the clearest
// example: any topic that maps to more than one file IS drift, by definition.
// The check does not need writing — it needs reading off.
//
// This module is structural only. It records that a link is ambiguous, or that
// two files claim a topic, because those are facts about the data. It does not
// decide that 30 days is stale or that 150 lines is too long — those are
// thresholds, they live with the health panel, and they should be changeable
// without touching the model.

import { parseFrontmatter } from "./frontmatter.js";

const ROOT_DOMAIN = "(root)";

/**
 * @typedef {Object} VaultFile
 * @property {string} path       - vault-relative, e.g. "domain/some-note.md"
 * @property {string} name       - basename without extension, e.g. "some-note"
 * @property {string} domain     - first path segment, or "(root)" for top-level files
 * @property {Object} data       - parsed frontmatter (all values are strings or string arrays)
 * @property {string} body       - markdown after the frontmatter
 * @property {boolean} hasFrontmatter
 * @property {number} lineCount  - lines in the whole file, for cap checks
 * @property {string[]} linkTargets - raw [[targets]] found in the body
 */

/**
 * Build the queryable model from what readVault() returns.
 *
 * Parsing happens here rather than in the caller so there is one entry point:
 *   buildModel(await readVault(handle))
 *
 * @param {Array<{path: string, text: string}>} rawFiles
 */
export function buildModel(rawFiles) {
  const warnings = [];

  // ---- 1. Parse every file into a VaultFile -------------------------------
  const files = rawFiles.map(({ path, text }) => {
    const { hasFrontmatter, data, body, warnings: fileWarnings } = parseFrontmatter(text, path);
    warnings.push(...fileWarnings);

    return {
      path,
      name: basename(path).replace(/\.md$/i, ""),
      domain: domainOf(path),
      data,
      body,
      hasFrontmatter,
      // Counted from the raw text, not the body — cap rules apply to whole files.
      lineCount: text.split(/\r?\n/).length,
      linkTargets: extractLinkTargets(body),
    };
  });

  // ---- 2. Lookup indexes --------------------------------------------------
  const byPath = new Map(files.map((f) => [f.path, f]));

  // basename -> [paths]. An array, not a single path, precisely so we can tell
  // when a short link is ambiguous instead of silently picking a winner.
  const byBasename = new Map();
  for (const f of files) {
    const key = basename(f.path);
    if (!byBasename.has(key)) byBasename.set(key, []);
    byBasename.get(key).push(f.path);
  }

  const byDomain = new Map();
  for (const f of files) {
    if (!byDomain.has(f.domain)) byDomain.set(f.domain, []);
    byDomain.get(f.domain).push(f);
  }

  // topic -> [files that declare it in owns:]
  // Any entry with more than one file is drift. That is the whole audit.
  const byTopic = new Map();
  for (const f of files) {
    const owns = f.data.owns;
    if (!Array.isArray(owns)) continue;
    for (const topic of owns) {
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic).push(f);
    }
  }

  // ---- 3. Resolve every link ---------------------------------------------
  const links = [];
  for (const f of files) {
    for (const target of f.linkTargets) {
      links.push({ from: f.path, target, ...resolveLink(target, f.path, byPath, byBasename) });
    }
  }

  // ---- 4. Invert the links -----------------------------------------------
  // path -> [paths that link to it]. Inverted from `links` rather than gathered
  // in a second pass, so the two directions cannot disagree about what a link
  // is. Only resolved links participate: a broken link points at no file, so
  // there is nothing to hang a backlink on.
  const backlinks = new Map(files.map((f) => [f.path, []]));
  for (const link of links) {
    if (link.status !== "resolved") continue;
    const sources = backlinks.get(link.resolvedPath);
    // A file that links to the same target twice is one backlink, not two.
    if (sources && !sources.includes(link.from)) sources.push(link.from);
  }

  return { files, byPath, byBasename, byDomain, byTopic, links, backlinks, warnings };
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/**
 * Work out what a [[target]] points at.
 *
 * The vault uses two link styles, and they need different treatment:
 *
 *   [[self/bottleneck]]  - a PATH. The author said where the file is.
 *   [[bottleneck]]       - a NAME. Resolved by finding the unique file so named.
 *
 * THE IMPORTANT RULE: a target containing "/" is never resolved by basename.
 *
 * This is not a stylistic choice. A link to a deleted `notes/status`
 * once resolved against an unrelated `archive/status.md` purely
 * because both end in "status.md" — and that false match let a genuinely broken
 * link survive three audits that all reported clean. If an author wrote a path,
 * a missing file at that path is broken, not an invitation to guess.
 *
 * @returns {{status: 'resolved'|'broken'|'ambiguous', resolvedPath: string|null, candidates?: string[]}}
 */
function resolveLink(target, fromPath, byPath, byBasename) {
  const wanted = target.endsWith(".md") ? target : `${target}.md`;

  if (target.includes("/")) {
    // Path-style. Try from the vault root, then relative to the linking file's
    // own directory — both appear in the vault. No basename fallback.
    if (byPath.has(wanted)) {
      return { status: "resolved", resolvedPath: wanted };
    }

    const dir = dirname(fromPath);
    const relative = dir ? `${dir}/${wanted}` : wanted;
    if (byPath.has(relative)) {
      return { status: "resolved", resolvedPath: relative };
    }

    return { status: "broken", resolvedPath: null };
  }

  // Name-style. Exactly one match is a resolution; more than one is ambiguous
  // and must be reported, because which one "wins" depends on lookup order.
  const matches = byBasename.get(wanted) ?? [];

  if (matches.length === 1) return { status: "resolved", resolvedPath: matches[0] };
  if (matches.length === 0) return { status: "broken", resolvedPath: null };
  return { status: "ambiguous", resolvedPath: null, candidates: matches };
}

/**
 * The one link pattern, and the one rule for which lines may contain a link.
 *
 * Extraction (for the audit) and segmentation (for rendering) both build from
 * these. If they disagreed, the browse view would linkify something the audit
 * never checked, or show as plain text something the audit counted — and the
 * discrepancy would be invisible from either side.
 */
export const LINK_SOURCE = String.raw`\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]`;
export const linkRegex = () => new RegExp(LINK_SOURCE, "g"); // fresh: /g carries lastIndex

/**
 * Split body text into lines, marking which are code.
 *
 * Code BLOCKS are excluded. Files that document the vault's own conventions
 * contain [[...]] inside example commands, and those are illustrations, not
 * links — counting them would make the file that explains the link audit fail
 * it.
 *
 * Inline code spans are deliberately NOT excluded. The vault writes almost
 * every link as `[[target]]` — backticked for visual weight — so nearly every
 * link lives inside an inline span. Excluding spans finds zero links in a vault
 * full of them. The block rule already covers the documentation case, which is
 * the only place illustrative brackets actually appear.
 */
export function classifyLines(body) {
  let inFence = false;
  return body.split(/\r?\n/).map((line) => {
    // The fence line itself is code, and it flips the state for what follows.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return { line, isCode: true };
    }
    return { line, isCode: inFence || /^ {4,}/.test(line) };
  });
}

/** Pull [[targets]] out of markdown body text, skipping code. */
function extractLinkTargets(body) {
  const targets = [];
  for (const { line, isCode } of classifyLines(body)) {
    if (isCode) continue;
    const re = linkRegex();
    let match;
    while ((match = re.exec(line)) !== null) {
      const target = match[1].trim();
      if (target) targets.push(target);
    }
  }
  return targets;
}

/**
 * Split body text into renderable segments, preserving every character.
 *
 * Extraction above throws positions away, which is fine for counting and
 * useless for rendering. This keeps the text intact and marks where the links
 * are, so the browse view can make them navigable without rebuilding the
 * document — and without a markdown parser, which is a large surface that only
 * fails in a browser.
 *
 * Concatenating every segment's text reproduces the body, with line endings
 * normalised to \n. That is the property to hold onto: rendering can never
 * silently drop content it did not understand.
 *
 * @param {string} body
 * @param {Map<string, {status: string, resolvedPath: string|null}>} resolutions
 * @returns {Array<{type:'text',value:string}|{type:'link',target:string,status:string,resolvedPath:string|null}>}
 */
export function segmentBody(body, resolutions = new Map()) {
  const segments = [];
  let pending = "";

  const flush = () => {
    if (pending) segments.push({ type: "text", value: pending });
    pending = "";
  };

  const lines = classifyLines(body);

  lines.forEach(({ line, isCode }, i) => {
    const newline = i < lines.length - 1 ? "\n" : "";

    if (isCode) {
      pending += line + newline;
      return;
    }

    const re = linkRegex();
    let cursor = 0;
    let match;
    while ((match = re.exec(line)) !== null) {
      const target = match[1].trim();
      if (!target) continue; // matches extractLinkTargets: [[  ]] is not a link

      pending += line.slice(cursor, match.index);
      flush();

      // A target absent from the map was never resolved by the model — which
      // means this body was segmented against the wrong file's links. Say so
      // rather than rendering it as though it worked.
      const r = resolutions.get(target) ?? { status: "unknown", resolvedPath: null };
      segments.push({ type: "link", target, status: r.status, resolvedPath: r.resolvedPath });

      cursor = match.index + match[0].length;
    }

    pending += line.slice(cursor) + newline;
  });

  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// Small path helpers. Written by hand because the browser has no path module,
// and vault paths always use forward slashes regardless of platform.
// ---------------------------------------------------------------------------

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function domainOf(path) {
  const i = path.indexOf("/");
  return i === -1 ? ROOT_DOMAIN : path.slice(0, i);
}
