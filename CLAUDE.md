# CLAUDE.md — Vault Dashboard

## Context lives in the vault, not here

**`C:\Users\squis\second-brain`** — read its `CLAUDE.md` first.

Why this project exists, why it is hosted publicly, why thresholds are duplicated,
what is built and what is next: all in `projects/vault-dashboard/`. **Do not restate any
of it here.** This file carries repo facts only.

## What this repo owns

Static site. **No build step, no dependencies, no package.json.** That is a constraint, not
an omission — see the vault for the reasoning.

**Run it:** `npx --yes serve -l 5501 .` then open `http://localhost:5501`.
`.claude/launch.json` does the same if a session is opened in this folder.

**It cannot be opened as a file.** `file://` gives an opaque origin, and the File System
Access API refuses to grant folder permissions to one. It must be served over `localhost`
or `https`.

**Deployed:** https://connormatsuoka-creator.github.io/vault-dashboard/ — public repo,
GitHub Pages. Pages caches assets for 10 minutes, so a hard refresh (`Ctrl+Shift+R`) is
needed to see a change immediately after pushing.

## Modules

| File | Owns |
|---|---|
| `src/vault-access.js` | Every filesystem interaction. Nothing else knows the File System Access API exists |
| `src/frontmatter.js` | Parsing frontmatter into `{data, body}`. Values stay strings |
| `src/model.js` | Building the queryable model and resolving links |
| `src/health.js` | The checks, and the **fallback** thresholds. The vault owns the real ones |
| `src/search.js` | Ranking a query against the model. Pure — no DOM |
| `src/graph.js` | The connections **mechanic**: what is visible, where, how emphasised. Emits a scene; draws nothing |
| `src/main.js` | Wiring and DOM rendering |
| `styles/tokens.css` | Every colour, space, and size. **The only file a restyle should touch** |
| `styles/app.css` | Layout. Contains no literal colours, and must not |

## Rules this repo keeps

- **Read-only.** `showDirectoryPicker({ mode: "read" })`. The dashboard is structurally
  incapable of writing to the vault; do not change this to `readwrite` for convenience.
- **No network.** The CSP is `default-src 'none'`. That is what makes public hosting safe
  for a tool that reads private notes — the page cannot send data anywhere.
- **No dependencies.** Adding one puts third-party code between the vault and the disk.
- **No colours outside `tokens.css`.** A literal colour anywhere else breaks the promise
  that the visual identity can be swapped by editing one file.
- **The graph mechanic is not the graph visual.** Drill-down, layout and view state live in
  `graph.js`; `main.js` only draws the scene it is handed. A restyle must not need to touch
  behaviour, and nothing may start deciding what a click does on the drawing side.
- **Thresholds belong to the vault.** `system/config.md` owns them; `THRESHOLDS` in
  `health.js` is only what to use when a vault has no config, and the panel prints which of
  the two it used.

## Testing

`node --test src/search.test.js src/health.test.js src/graph.test.js` — 44 cases covering
`search.js`, `segmentBody`, `backlinks`, `loadThresholds` and the graph. Node's built-in runner, so there is nothing
to install and still no `package.json`. (`node --test src/` does not work — pass the files.)

`frontmatter.js`, `model.js`, and `health.js` have no test file but are equally pure, and
can be exercised from Node directly — they import cleanly and take plain objects.

**`vault-access.js` and the DOM rendering in `main.js` cannot be tested that way.** Both
need a real browser and a real folder-pick, which requires a human gesture. Every bug that
has reached the browser so far has been in exactly those two, because the pure modules got
tests and the interactive layer did not.
