// frontmatter.js
//
// Splits a markdown file into its YAML frontmatter and its body.
//
// This is a deliberately small parser, not a YAML implementation. The vault
// uses exactly two shapes:
//
//     key: some scalar value
//     owns: [topic-one, topic-two]
//
// No nesting, no block arrays, no multi-line strings. A real YAML library
// would be ~40KB to handle six field types, and would break the
// zero-dependency rule for no gain.
//
// TWO RULES THIS FILE ENFORCES — both easy to "helpfully" break later:
//
//   1. EVERY VALUE STAYS A STRING. `updated: 2026-08-19` becomes the string
//      "2026-08-19", never a Date. `occurred: 2024` stays "2024" and must NOT
//      become Date(2024-01-01) — that would silently invent a month and a day
//      the vault does not know. Precision is information; converting destroys
//      it. Only the renderer may interpret a date, and only for layout.
//
//   2. UNPARSEABLE LINES BECOME WARNINGS, NEVER SILENT DROPS. If a line does
//      not match a shape we understand, we record it so the health panel can
//      surface it. Silently discarding metadata is how a dashboard ends up
//      confidently showing an incomplete picture.

/**
 * @typedef {Object} ParsedFile
 * @property {boolean} hasFrontmatter - false for files like the router, which legitimately has none
 * @property {Object<string, string|string[]>} data - parsed fields; values are strings or arrays of strings
 * @property {string} body - everything after the closing delimiter
 * @property {string[]} warnings - human-readable notes about anything we could not parse
 */

const DELIMITER = "---";

// key: value  — key is lowercase word characters and hyphens, value is the rest of the line.
// Anchored at the start so an indented line (which would imply nesting we do not
// support) fails to match and becomes a warning rather than being misread.
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

/**
 * Split a raw markdown file into frontmatter and body.
 *
 * @param {string} text - the raw file contents
 * @param {string} [path] - optional, only used to make warnings more useful
 * @returns {ParsedFile}
 */
export function parseFrontmatter(text, path = "") {
  const where = path ? `${path}: ` : "";

  // Normalise line endings before anything else.
  // The vault repo has core.autocrlf=true, so a fresh clone on Windows writes
  // CRLF files. Splitting on \n alone would leave a trailing \r on every line,
  // and "---\r" would not equal "---" — the delimiter check would fail on every
  // single file, for a reason that is invisible when you look at the text.
  const lines = text.split(/\r?\n/);

  // Frontmatter must open on the very first line. A "---" further down is a
  // horizontal rule in the body, not metadata.
  if (lines[0]?.trim() !== DELIMITER) {
    return { hasFrontmatter: false, data: {}, body: text, warnings: [] };
  }

  // Find the closing delimiter.
  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === DELIMITER);

  if (closingIndex === -1) {
    // An opening delimiter with no closing one. Treat the whole file as body
    // rather than guessing where the metadata was meant to stop.
    return {
      hasFrontmatter: false,
      data: {},
      body: text,
      warnings: [`${where}frontmatter opens with --- but never closes; treated as body`],
    };
  }

  const fieldLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n");

  const data = {};
  const warnings = [];

  for (const raw of fieldLines) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) continue; // blank or comment

    // Leading whitespace implies nesting, which this parser does not support.
    // Checked against the raw line, before trimming — trimming first would strip
    // the indentation and let a nested key through as a top-level one, silently
    // misrepresenting the file's structure.
    if (/^\s/.test(raw)) {
      warnings.push(`${where}indented frontmatter line — nesting is not supported: "${line}"`);
      continue;
    }

    const match = FIELD_RE.exec(line);
    if (!match) {
      warnings.push(`${where}could not parse frontmatter line: "${line}"`);
      continue;
    }

    const [, key, rawValue] = match;

    if (key in data) {
      warnings.push(`${where}duplicate frontmatter key "${key}"; keeping the first`);
      continue;
    }

    data[key] = parseValue(rawValue);
  }

  return { hasFrontmatter: true, data, body, warnings };
}

/**
 * Turn the text after "key:" into either a string or an array of strings.
 * Never returns a number, Date, or boolean — see rule 1 at the top of this file.
 *
 * @param {string} rawValue
 * @returns {string|string[]}
 */
function parseValue(rawValue) {
  const value = rawValue.trim();

  // Inline array: [a, b, c] or the empty [] used by index files.
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""); // "[]" and "[ ]" both yield []
  }

  return value;
}

// Note: quoted values are deliberately NOT handled. Nothing in the vault quotes
// anything, and building for a need that does not exist is how a small parser
// stops being small. If quoting ever appears, the quote characters will show up
// inside the value — visibly wrong, which is the failure mode we want. Add
// handling then, against a real case.

/**
 * Convenience wrapper for a whole vault: parse every file and gather warnings.
 *
 * Takes what readVault() returns and produces the shape model.js expects.
 *
 * @param {Array<{path: string, text: string}>} files
 * @returns {{parsed: Array<ParsedFile & {path: string}>, warnings: string[]}}
 */
export function parseAll(files) {
  const parsed = [];
  const warnings = [];

  for (const { path, text } of files) {
    const result = parseFrontmatter(text, path);
    parsed.push({ path, ...result });
    warnings.push(...result.warnings);
  }

  return { parsed, warnings };
}
