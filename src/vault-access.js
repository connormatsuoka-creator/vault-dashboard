// vault-access.js
//
// Everything that touches the filesystem lives in this file, and nothing else
// in the app knows the File System Access API exists. If we ever move to a
// local server instead, this is the only file that has to change.
//
// Two hard rules enforced here:
//   1. Read-only. We ask the browser for 'read' permission, so the dashboard
//      is physically incapable of writing to the vault even if a bug tried.
//   2. Raw text out. This file does not interpret file contents at all —
//      parsing is frontmatter.js's job.

// Directories we never descend into. .git is huge and full of binary objects;
// .obsidian is local editor state that isn't vault content.
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules"]);

/**
 * Errors we throw deliberately, so main.js can show a useful message instead
 * of a raw DOMException. `code` is what the UI switches on; `message` is what
 * a human reads.
 */
export class VaultAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultAccessError";
    this.code = code;
  }
}

/**
 * Is the File System Access API available at all?
 * False in Firefox and Safari, and false on any page not served over
 * https:// or http://localhost — including file://, which has an opaque
 * origin the browser refuses to grant file permissions to.
 */
export function isSupported() {
  return typeof window.showDirectoryPicker === "function";
}

/**
 * Ask the user to choose their vault folder.
 * Must be called from inside a click handler — the browser requires a real
 * user gesture and will reject the call otherwise.
 *
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function pickVault() {
  if (!isSupported()) {
    throw new VaultAccessError(
      "UNSUPPORTED",
      "This browser can't open local folders. Use Chrome or Edge, and make " +
        "sure the page is served over https or localhost — not opened as a file."
    );
  }

  try {
    return await window.showDirectoryPicker({
      mode: "read", // read-only: we cannot write to the vault, by construction
      id: "second-brain-vault", // lets the browser reopen at the same folder next time
    });
  } catch (err) {
    // The user closed the picker without choosing. Not an error worth shouting about.
    if (err.name === "AbortError") {
      throw new VaultAccessError("CANCELLED", "No folder was chosen.");
    }
    // Thrown when the page isn't a secure context, or wasn't triggered by a click.
    if (err.name === "SecurityError") {
      throw new VaultAccessError(
        "INSECURE_CONTEXT",
        "The browser blocked folder access. The page must be served over " +
          "https or localhost, and the picker must open from a click."
      );
    }
    throw err; // anything unexpected keeps its original identity
  }
}

/**
 * Walk the directory tree and collect every markdown file handle.
 *
 * Recursive: for each entry, either descend (directory) or keep it (a .md file).
 *
 * Returns a flat array rather than an async generator. The vault is ~30 files,
 * so streaming buys nothing and an array is far easier to reason about.
 *
 * If the vault ever grows enormous, note that the array is NOT the first thing
 * to strain — Promise.all() in readVault() opening thousands of concurrent
 * reads is. The fix then is to batch those reads (~50 at a time) inside
 * readVault, which leaves this function and the public interface untouched.
 * Switching to a generator would only pay off if model.js and main.js also
 * consumed a stream, which is a much larger change for no benefit at this size.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} prefix - path accumulated so far, e.g. "ventures/coaching-admin"
 * @returns {Promise<Array<{path: string, handle: FileSystemFileHandle}>>}
 */
async function collectMarkdownHandles(dirHandle, prefix = "") {
  const found = [];

  // .entries() is an async iterator — each turn of the loop may wait on disk,
  // which is why this is `for await` and not a plain `for`.
  for await (const [name, handle] of dirHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;

    if (handle.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      // Recurse, and splice the child's results into ours.
      found.push(...(await collectMarkdownHandles(handle, path)));
    } else if (name.toLowerCase().endsWith(".md")) {
      found.push({ path, handle });
    }
  }

  return found;
}

/**
 * Read the whole vault into memory as raw text.
 *
 * Paths are vault-relative and always use forward slashes, e.g.
 * "ventures/coaching-admin/postmortem.md" — so they match the [[wikilink]]
 * format used inside the notes.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<Array<{path: string, text: string}>>}
 */
export async function readVault(dirHandle) {
  const handles = await collectMarkdownHandles(dirHandle);

  if (handles.length === 0) {
    throw new VaultAccessError(
      "EMPTY",
      "No markdown files found in that folder. Is it the right one?"
    );
  }

  // Read every file at once rather than one after another. These are
  // independent I/O operations, so waiting for each in turn would be slower
  // for no reason.
  const files = await Promise.all(
    handles.map(async ({ path, handle }) => {
      const file = await handle.getFile();
      return { path, text: await file.text() };
    })
  );

  // Stable alphabetical order, so the UI doesn't reshuffle between loads.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
