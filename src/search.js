// search.js
//
// Finding a file in the vault.
//
// The ranking is not generic relevance scoring — it mirrors how the vault is
// actually organised. A file declares in `owns:` which facts it is canonical
// for, so a topic match IS the vault's own answer to "where does this live",
// and it outranks a filename match, which outranks a mention in prose.
//
// Deliberately substring, not fuzzy. Fuzzy matching needs tuning against a
// corpus to stop being annoying, and at this size every query is exact enough.
// The whole vault is scanned per keystroke and that costs microseconds.
//
// Pure: no DOM, and the model is never mutated. This is the layer that gets
// tested, because it is the layer that can be.

/** Results shown before the list stops being information. */
export const MAX_RESULTS = 50;

/** A matching line longer than this is windowed around the match. */
const SNIPPET_WIDTH = 160;

/** Group order IS the ranking. Rendering walks this array as given. */
const GROUPS = [
  { kind: "topic", label: "Owns a matching topic" },
  { kind: "path", label: "Matching file name" },
  { kind: "body", label: "Mentioned in content" },
];

/**
 * @typedef {Object} SearchResult
 * @property {string} path
 * @property {string} name
 * @property {string} domain
 * @property {'topic'|'path'|'body'} kind
 * @property {string} evidence  - the topic, path, or matching line
 * @property {number} offset    - where the match starts inside `evidence`
 * @property {number} length    - how much of `evidence` matched
 * @property {number} extra     - further matches in this file beyond `evidence`
 */

/**
 * Search the vault.
 *
 * A file appears **once**, under its strongest match kind. Listing the same
 * file three times because the query hit its topic, its name and its prose is
 * noise, not thoroughness — and the strongest match is already the reason worth
 * showing.
 *
 * @param {ReturnType<import('./model.js').buildModel>} model
 * @param {string} query
 * @param {number} limit
 * @returns {{groups: Array<{kind: string, label: string, results: SearchResult[]}>, total: number, truncated: number}}
 */
export function searchVault(model, query, limit = MAX_RESULTS) {
  const q = query.trim().toLowerCase();
  if (!q) return { groups: [], total: 0, truncated: 0 };

  const claimed = new Set(); // paths already placed in a higher-ranked group
  const buckets = new Map(GROUPS.map((g) => [g.kind, []]));

  // ---- topic: the vault's own ownership map -------------------------------
  // Sorted so an exact topic match leads. Searching "capture" should surface
  // the file that owns `capture` above one that owns `capture-bar`.
  for (const [topic, files] of model.byTopic) {
    const at = topic.toLowerCase().indexOf(q);
    if (at === -1) continue;
    for (const file of files) {
      if (claimed.has(file.path)) continue;
      claimed.add(file.path);
      buckets.get("topic").push({ ...base(file), kind: "topic", evidence: topic, offset: at, length: q.length, extra: 0, exact: topic.toLowerCase() === q });
    }
  }

  // ---- path ---------------------------------------------------------------
  for (const file of model.files) {
    if (claimed.has(file.path)) continue;
    const at = file.path.toLowerCase().indexOf(q);
    if (at === -1) continue;
    claimed.add(file.path);
    buckets.get("path").push({ ...base(file), kind: "path", evidence: file.path, offset: at, length: q.length, extra: 0 });
  }

  // ---- body ---------------------------------------------------------------
  for (const file of model.files) {
    if (claimed.has(file.path)) continue;
    const hit = firstBodyMatch(file.body, q);
    if (!hit) continue;
    claimed.add(file.path);
    buckets.get("body").push({ ...base(file), kind: "body", ...hit });
  }

  // ---- order within each group -------------------------------------------
  buckets.get("topic").sort((a, b) => Number(b.exact) - Number(a.exact) || a.path.localeCompare(b.path));
  buckets.get("path").sort((a, b) => a.path.localeCompare(b.path));
  // More mentions is a better signal than alphabetical when the match is prose.
  buckets.get("body").sort((a, b) => b.extra - a.extra || a.path.localeCompare(b.path));

  // ---- cap, preserving rank ----------------------------------------------
  // The cap spends its budget top-down, so truncation drops the weakest
  // matches rather than an arbitrary slice of each group.
  const total = [...buckets.values()].reduce((n, r) => n + r.length, 0);
  let budget = limit;
  const groups = [];

  for (const { kind, label } of GROUPS) {
    const all = buckets.get(kind);
    if (all.length === 0) continue;
    const results = all.slice(0, Math.max(0, budget));
    budget -= results.length;
    if (results.length) groups.push({ kind, label, results });
  }

  return { groups, total, truncated: Math.max(0, total - limit) };
}

/** The fields every result carries, whatever matched. */
function base(file) {
  return { path: file.path, name: file.name, domain: file.domain };
}

/**
 * Find the first matching line, and count the rest.
 *
 * The count matters: one passing mention and fifteen mentions are different
 * answers, and only the first line is worth the space to show.
 */
function firstBodyMatch(body, q) {
  const lines = body.split(/\r?\n/);
  let first = null;
  let matches = 0;

  for (const line of lines) {
    const at = line.toLowerCase().indexOf(q);
    if (at === -1) continue;
    matches++;
    if (!first) first = snippet(line, at, q.length);
  }

  return first ? { ...first, extra: matches - 1 } : null;
}

/**
 * Trim a line down to something displayable, keeping the match visible and the
 * offset honest — the caller highlights by slicing, so a stale offset would
 * highlight the wrong characters rather than fail loudly.
 */
function snippet(line, at, length) {
  const lead = line.length - line.trimStart().length;
  let text = line.trim();
  let offset = at - lead;

  if (text.length > SNIPPET_WIDTH) {
    // Window around the match rather than truncating from the left, or a match
    // late in a long line would be cut off entirely.
    const start = Math.max(0, offset - Math.floor((SNIPPET_WIDTH - length) / 2));
    const end = Math.min(text.length, start + SNIPPET_WIDTH);
    const head = start > 0 ? "…" : "";
    const tail = end < text.length ? "…" : "";
    offset = offset - start + head.length;
    text = head + text.slice(start, end) + tail;
  }

  return { evidence: text, offset, length };
}
