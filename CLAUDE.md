# CLAUDE.md — Vault Dashboard

## Context lives in the vault, not here

**Read the vault's `CLAUDE.md` first.** Where the vault lives is owned by
`~/.claude/CLAUDE.md`, which is already loaded in every session. This file does not
restate that path, for the same reason it does not restate anything else.

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
| `src/markdown.js` | Parsing markdown into a block tree. Builds no DOM |
| `src/chronology.js` | The date grammar, and turning the vault into a timeline. Emits plain data |
| `src/sky.js` | Deterministic celestial geometry: the starfield, how a body is lit, dust |
| `src/icons.js` | The drawn interface marks. Nothing in the UI may be a text glyph |
| `src/main.js` | Wiring and DOM rendering |
| `styles/tokens.css` | Every colour, space, and size. **The only file a restyle should touch** |
| `styles/app.css` | Layout. Contains no literal colours, and must not |
| `assets/fonts/` | The two self-hosted typefaces and their licences. See its README |

## Rules this repo keeps

- **Read-only.** `showDirectoryPicker({ mode: "read" })`. The dashboard is structurally
  incapable of writing to the vault; do not change this to `readwrite` for convenience.
- **No network.** The CSP is `default-src 'none'`, so `connect-src` inherits it and fetch,
  XHR and WebSockets are all refused. That is what makes public hosting safe for a tool
  that reads private notes — the page cannot send data anywhere.
  `font-src 'self'` is the one addition, permitting a typeface from this origin and
  nothing else; it opens no channel that `img-src 'self'` did not already have.
- **No dependencies.** Adding one puts third-party code between the vault and the disk.
- **No inline styles. They do not work here, and they fail silently.** The CSP is
  `style-src 'self'` with no `'unsafe-inline'`, so a `style` ATTRIBUTE is parsed to zero
  declarations. `getAttribute` returns the string you set, devtools shows correct-looking
  markup, and the computed value is whatever the stylesheet said — there is no error
  anywhere. Colour by class; set geometry through the CSSOM (`el.style.width = …`), which
  is not blocked. This cost an afternoon once: every planet in the orrery came out the
  wrong colour with markup that looked right.
- **No colours outside `tokens.css`.** A literal colour anywhere else breaks the promise
  that the visual identity can be swapped by editing one file.
- **The graph mechanic is not the graph visual.** Drill-down, layout and view state live in
  `graph.js`; `main.js` only draws the scene it is handed. A restyle must not need to touch
  behaviour, and nothing may start deciding what a click does on the drawing side.
- **The dashboard stores nothing.** No persisted folder handle, no IndexedDB, no
  localStorage. Re-picking the vault each session is the cost of that, and it is the
  intended trade — the same kind of structural promise as read-only and no-network.
- **Two brushes, one control, two meanings.** `createBrush` is a factory because
  each instance owns a drag and a focused grip; two brushes sharing module-level state
  would break the first time someone dragged one strip and arrowed the other. On the
  connections the window FILTERS and nothing moves; on the timeline it ZOOMS, rebuilding
  the scale over the window. The strips always show the whole axis — they are the
  overview. The windows are deliberately NOT shared: linking them is a coherent design,
  but it must be chosen, not inherited.
- **The keyboard steps between events, never by a duration.** The axis is discrete, so
  `stepWindow` moves to the next moment that exists. That is what removes any need to
  type a date. Never replace it with a time step.
- **Label placement is measured, not calculated.** Where a label GOES is pure maths in
  `graph.js`; whether it collides is not knowable until it is rendered, because that
  depends on how long its text is. `renderGraph` measures and nudges after insertion.
  Two rules follow: keep the frame computed from those measured boxes rather than from a
  padding guess, and reuse the boxes — `getBBox` forces a layout flush and this path runs
  on every frame of a brush drag.
- **Anything drawn must be deterministic.** `renderGraph` and `renderTimeline` run again on
  every view change, so geometry from `Math.random` reshuffles each time — the starfield
  shimmers, the dust crawls. `sky.js` is seeded for that reason and is tested for it.
- **Thresholds belong to the vault.** `system/config.md` owns them; `THRESHOLDS` in
  `health.js` is only what to use when a vault has no config, and the panel prints which of
  the two it used.

## Testing

`node --test src/*.test.js` (pass the files; `node --test src/` does not work) — 177 cases
covering search, `segmentBody`, backlinks, `loadThresholds`, `lineCount`, the graph, the
markdown parser, the date grammar and timeline, the brush, and the celestial geometry. Node's built-in runner, so there is nothing to install and still no `package.json`.

`frontmatter.js` and `health.js` have no test file but are equally pure, and can be
exercised from Node directly — they import cleanly and take plain objects.

**`vault-access.js` and the DOM rendering in `main.js` cannot be tested that way.** Both
need a real browser and a real folder-pick, which requires a human gesture.

**Pure-but-untested is not safe either**, and this file used to claim otherwise — that every
bug reaching the browser had lived in those two modules. `lineCount` disproved it on
2026-08-22: in `model.js`, pure and importable, it counted a file's trailing newline as a
line and reported all 35 vault files one over, including a false `150/150` that nearly
forced a split of a 149-line file. It had no test because nothing there did.
