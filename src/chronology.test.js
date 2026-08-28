// chronology.test.js
//
// Run with:  node --test src/chronology.test.js
//
// Like the other suites here, most cases come from measuring the real vault
// rather than from a spec. The ones that matter are the ones that actually
// occur: 9 occurred: spans, 37 dates mined from prose, exactly 1 date written
// inside backticks as a format example, 8 year-less dates, 15 files with no
// event date at all, and one date four days in the future.

import test from "node:test";
import assert from "node:assert/strict";

import { buildModel } from "./model.js";
import {
  axisOf,
  defaultWindow,
  stepWindow,
  limitWindow,
  trackSpans,
  parsePart,
  parseOccurred,
  isOccurred,
  extractDates,
  countYearless,
  buildScale,
  buildChronology,
  timelineScene,
  humanDuration,
  humanRange,
} from "./chronology.js";

const DAY = 86_400_000;
const TODAY = new Date("2026-08-24T12:00:00");

/** Build a model from inline markdown, the way the app builds one from a folder. */
const modelOf = (files) => buildModel(files.map(([path, text]) => ({ path, text })));

/** Frontmatter + body, so tests read like the files they stand for. */
const file = (fm, body = "") => `---\n${fm}\n---\n\n${body}\n`;

// ---------------------------------------------------------------------------
// Precision is width
// ---------------------------------------------------------------------------

test("precision sets the width of a period, rather than a guessed day", () => {
  // "2017" is a year. Plotting it at January 1st invents ten months that
  // self/learning.md never claimed.
  const year = parsePart("2017");
  assert.equal(year.precision, "year");
  assert.equal(year.to - year.from, 365 * DAY);

  const month = parsePart("2024-06");
  assert.equal(month.precision, "month");
  assert.equal(month.to - month.from, 30 * DAY);

  const day = parsePart("2026-08-14");
  assert.equal(day.precision, "day");
  assert.equal(day.to - day.from, DAY);
});

test("a date that matches the shape but does not exist is rejected", () => {
  // The old regex-only check passed these. Date.UTC rolls Feb 30th into March,
  // so the shape test alone cannot see it.
  assert.equal(parsePart("2026-02-30"), null);
  assert.equal(parsePart("2024-13"), null);
  assert.equal(parsePart("2024-00-10"), null);
  assert.ok(parsePart("2024-02-29"), "2024 is a leap year");
  assert.equal(parsePart("2025-02-29"), null, "2025 is not");
});

// ---------------------------------------------------------------------------
// occurred: — every shape the vault actually uses
// ---------------------------------------------------------------------------

test("occurred: parses each of the real vault's shapes", () => {
  const ongoing = parseOccurred("2017/");
  assert.equal(ongoing.ongoing, true);
  assert.equal(ongoing.end, null);

  const closed = parseOccurred("2024-06/2024-12");
  assert.equal(closed.ongoing, false);
  assert.equal(closed.end.iso, "2024-12");

  const bare = parseOccurred("2026-08-14");
  assert.equal(bare.ongoing, false, "no slash is a period, not an open end");
  assert.equal(bare.end, null);
});

test("occurred: rejects malformed values without throwing", () => {
  assert.equal(parseOccurred("2024/2025/2026"), null);
  assert.equal(parseOccurred("last summer"), null);
  assert.equal(parseOccurred(""), null);
  assert.equal(parseOccurred(undefined), null);
  assert.equal(isOccurred("2026-08-14/2026-08-18"), true);
  assert.equal(isOccurred("nonsense"), false);
});

// ---------------------------------------------------------------------------
// Mining prose — the measured false positive
// ---------------------------------------------------------------------------

test("a date inside backticks is not an event", () => {
  // system/decisions.md writes this line to document the FORMAT. Mining it puts
  // a venture on the timeline that never happened.
  const body = "**Precision is allowed to vary** (`2024`, `2024-06`, `2026-08-15/`)";
  assert.deepEqual(extractDates(body), []);
});

test("a date inside a fence is not an event", () => {
  const body = "text\n\n```bash\necho 2026-08-19\n```\n\nmore";
  assert.deepEqual(extractDates(body), []);
});

test("removing a code span cannot splice a date out of its neighbours", () => {
  // "2026-08" + "-14" must not become 2026-08-14 once the span between them is
  // dropped. Code becomes a space, not nothing.
  assert.deepEqual(extractDates("2026-08`x`-14"), []);
});

test("dates in prose are found, with the line that carried them", () => {
  const found = extractDates("## Router cap raised 60 → 80 (2026-08-19)\n\nGreenlit 2026-08-19.");
  assert.deepEqual(found.map((d) => d.iso), ["2026-08-19", "2026-08-19"]);
  assert.match(found[0].text, /Router cap raised/);
  assert.equal(found[0].line, 1);
});

test("a date inside bold still counts as prose", () => {
  // vault-dashboard/status.md opens entries as **2026-08-20.**
  assert.deepEqual(extractDates("**2026-08-20.** Inbox review stays.").map((d) => d.iso), ["2026-08-20"]);
});

test("year-less dates are counted rather than guessed at", () => {
  // postmortem.md has 8 rows like "| Fri 8/14 |". The year is inferable from
  // that file's own occurred: span — and inferring is what this module refuses
  // to do, so they are reported instead.
  assert.equal(countYearless("| Fri 8/14 | Desiree |"), 1);
  assert.deepEqual(extractDates("| Fri 8/14 | Desiree |"), []);
  // "60/60" is a cap written as a fraction, not August 60th.
  assert.equal(countYearless("The router sat at exactly 60/60 twice"), 0);
});

// ---------------------------------------------------------------------------
// The piecewise axis
// ---------------------------------------------------------------------------

test("an empty stretch collapses and states the duration it swallowed", () => {
  const a = Date.UTC(2017, 0, 1);
  const b = Date.UTC(2024, 5, 1);
  const scale = buildScale([a, b, b + DAY, b + 2 * DAY, b + 3 * DAY]);

  assert.equal(scale.breaks.length, 1);
  assert.equal(scale.breaks[0].from, a);
  assert.match(scale.breaks[0].label, /years/);
});

test("breaks are capped as a group, so many of them cannot crowd out the events", () => {
  // Six breaks is what the real vault produces. They must stay a minority of
  // the axis or the compression defeats its own purpose.
  const anchors = [];
  for (let i = 0; i < 7; i++) anchors.push(Date.UTC(2017 + i, 0, 1), Date.UTC(2017 + i, 0, 2));
  const scale = buildScale(anchors);
  const spent = scale.breaks.reduce((sum, b) => sum + (b.x1 - b.x0), 0);
  assert.ok(scale.breaks.length >= 5, `expected several breaks, got ${scale.breaks.length}`);
  assert.ok(spent <= 0.31, `breaks took ${(spent * 100).toFixed(1)}% of the axis`);
});

test("projection is monotonic and bounded", () => {
  const base = Date.UTC(2026, 7, 14);
  const scale = buildScale([base, base + DAY, base + 2 * DAY, base + 400 * DAY]);
  let previous = -1;
  for (let i = 0; i <= 20; i++) {
    const x = scale.project(base + (i / 20) * 400 * DAY);
    assert.ok(x >= 0 && x <= 1, `${x} out of range`);
    assert.ok(x >= previous, "projection went backwards");
    previous = x;
  }
  assert.equal(scale.project(base - 999 * DAY), 0, "before the axis clamps to 0");
  assert.equal(scale.project(base + 9999 * DAY), 1, "after the axis clamps to 1");
});

test("a degenerate axis does not divide by zero", () => {
  assert.equal(buildScale([]), null);
  const one = buildScale([Date.UTC(2026, 7, 14)]);
  assert.equal(one.degenerate, true);
  assert.equal(one.project(Date.UTC(2026, 7, 14)), 0.5);
  // Every anchor identical is the same case arriving by a different route.
  const same = buildScale([Date.UTC(2026, 7, 14), Date.UTC(2026, 7, 14)]);
  assert.equal(same.degenerate, true);
});

// ---------------------------------------------------------------------------
// Reading the axis backwards — what a brush needs
// ---------------------------------------------------------------------------

test("every anchor survives a round trip through project and back", () => {
  const anchors = [
    Date.UTC(2017, 0, 1),
    Date.UTC(2024, 5, 1),
    Date.UTC(2026, 7, 14),
    Date.UTC(2026, 7, 15),
    Date.UTC(2026, 7, 24),
    Date.UTC(2026, 7, 28),
  ];
  const scale = buildScale(anchors);
  for (const ms of anchors) {
    const back = scale.unproject(scale.project(ms));
    assert.ok(Math.abs(back - ms) < 1000, `${new Date(ms).toISOString()} came back as ${new Date(back).toISOString()}`);
  }
});

test("unprojection is monotonic and clamps outside the axis", () => {
  const base = Date.UTC(2026, 7, 14);
  const scale = buildScale([base, base + DAY, base + 2 * DAY, base + 400 * DAY]);
  let previous = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const ms = scale.unproject(i / 20);
    assert.ok(ms >= previous, "unprojection went backwards");
    previous = ms;
  }
  assert.equal(scale.unproject(-3), scale.from, "before the axis clamps to its start");
  assert.equal(scale.unproject(9), scale.to, "after the axis clamps to its end");
});

test("a handle dropped inside a break snaps to its nearer edge", () => {
  const scale = buildScale([Date.UTC(2017, 0, 1), Date.UTC(2024, 5, 1), Date.UTC(2024, 5, 2), Date.UTC(2024, 5, 3)]);
  const band = scale.breaks[0];
  const width = band.x1 - band.x0;

  // A day inside the void, not on its edge — the edges are the events that
  // bracket the break, and a closed window boundary landing on one selects it.
  const near = scale.resolve(band.x0 + width * 0.1);
  assert.equal(near.snapped, true);
  assert.equal(near.ms, band.from + DAY);
  assert.ok(near.unit > band.x0 && near.unit < band.x1, "snapped outside the band it snapped within");

  const far = scale.resolve(band.x0 + width * 0.9);
  assert.equal(far.snapped, true);
  assert.equal(far.ms, band.to - DAY);
  assert.ok(far.unit > near.unit, "the two edges resolved to the same side");

  // Outside a break the pointer is taken literally, or the brush would be
  // unable to select a single day in the region that has all the events.
  const dense = scale.resolve(0.97);
  assert.equal(dense.snapped, false);
  assert.equal(dense.unit, 0.97);
});

test("snapping inside a break cannot change which files a window selects", () => {
  // The entire justification for snapping. A break exists BECAUSE nothing is
  // recorded inside it, so every position within one selects the same files and
  // moving the handle to the edge is a normalisation rather than a rounding
  // error. If this ever fails, snapping has started lying.
  const model = modelOf([
    ["self/learning.md", file("occurred: 2017-01-01")],
    ["ventures/a.md", file("occurred: 2024-06-01")],
    ["ventures/b.md", file("occurred: 2024-06-03")],
  ]);
  const { scale, tracks } = buildChronology(model, TODAY);
  const band = scale.breaks[0];
  const width = band.x1 - band.x0;
  const from = (unit) => tracks.filter((t) => t.to >= scale.unproject(unit)).map((t) => t.path).join(" ");

  const inside = [];
  for (let i = 1; i < 10; i++) inside.push(from(band.x0 + width * (i / 10)));
  assert.equal(new Set(inside).size, 1, `positions inside a break disagreed: ${[...new Set(inside)].join(" | ")}`);
  assert.equal(from(scale.resolve(band.x0 + width * 0.4).unit), inside[0]);

  // And the probe genuinely has resolution — otherwise the assertion above
  // would pass for a predicate that selects everything everywhere.
  assert.notEqual(from(Math.max(0, band.x0 - 1e-6)), inside[0], "the window predicate is not sensitive");
});

test("a degenerate axis resolves every position to its one moment", () => {
  const only = Date.UTC(2026, 7, 14);
  const scale = buildScale([only]);
  assert.equal(scale.unproject(0.2), only);
  assert.deepEqual(scale.resolve(0.9), { unit: 0.5, ms: only, snapped: true });
});

test("durations are rounded the way a person would say them", () => {
  assert.equal(humanDuration(5 * DAY), "5 days");
  assert.equal(humanDuration(1 * DAY), "1 day");
  assert.equal(humanDuration(120 * DAY), "~4 months");
  assert.equal(humanDuration(2708 * DAY), "~7.4 years");
});

// ---------------------------------------------------------------------------
// Tiers — and the rule that keeps them honest
// ---------------------------------------------------------------------------

test("updated: is never promoted to an event", () => {
  // The whole point. A file with only updated: has no event date, and giving it
  // one would invent a fact — the same mistake as reconstructing updated: from
  // git blame.
  const model = modelOf([["self/values.md", file("updated: 2026-08-18\nstatus: cold")]]);
  const c = buildChronology(model, TODAY);

  assert.equal(c.tracks.length, 0);
  assert.equal(c.undated.length, 1);
  assert.equal(c.undated[0].updated, "2026-08-18", "carried for reference");
  assert.equal(c.events, 0);
  // The axis exists (today anchors it) but nothing was placed on it.
  assert.deepEqual(timelineScene(c).rows, []);
});

test("a file with no frontmatter at all does not throw", () => {
  // CLAUDE.md is exactly this: data is {}, not even updated:.
  const model = modelOf([["CLAUDE.md", "# Router\n\nNo frontmatter here.\n"]]);
  const c = buildChronology(model, TODAY);
  assert.equal(c.undated.length, 1);
  assert.equal(c.undated[0].updated, null);
});

test("a file with both a span and body dates is one track, not many", () => {
  // projects/focus-timer/status.md: occurred: 2026-08-14/ plus 7 body dates.
  // Picking one would hide the disagreement; the span is the bar and the dates
  // are marks along it.
  const model = modelOf([
    [
      "projects/focus-timer/status.md",
      file("updated: 2026-08-19\noccurred: 2026-08-14/", "Fixed 2026-08-18.\n\nMerged 2026-08-16.\n"),
    ],
  ]);
  const c = buildChronology(model, TODAY);

  assert.equal(c.tracks.length, 1);
  assert.ok(c.tracks[0].span);
  assert.equal(c.tracks[0].marks.length, 2);
  assert.equal(c.events, 3, "the span counts as one event, plus two marks");
});

test("an ongoing span runs to today rather than stopping at its start", () => {
  const model = modelOf([["self/learning.md", file("occurred: 2017/")]]);
  const c = buildChronology(model, TODAY);
  const span = c.tracks[0].span;

  assert.equal(span.ongoing, true);
  assert.equal(span.to, Date.UTC(2026, 7, 24) + DAY);
  assert.match(span.label, /ongoing/);
});

test("a date after today is marked ahead rather than shown as history", () => {
  // focus-timer's freeze runs "until roughly 2026-08-28" — a commitment, not a
  // thing that happened.
  const model = modelOf([
    ["projects/focus-timer/status.md", file("occurred: 2026-08-14/", "## FEATURE FREEZE until roughly 2026-08-28")],
  ]);
  const c = buildChronology(model, TODAY);
  const marks = c.tracks[0].marks;

  assert.equal(marks.length, 1);
  assert.equal(marks[0].future, true);
  assert.match(timelineScene(c).caption, /1 ahead of today/);
});

test("today is injected, so the suite does not drift with the wall clock", () => {
  const model = modelOf([["a/x.md", file("occurred: 2026-08-14/", "Later: 2026-08-28")]]);
  assert.equal(buildChronology(model, new Date("2026-08-24T12:00:00")).tracks[0].marks[0].future, true);
  assert.equal(buildChronology(model, new Date("2026-09-01T12:00:00")).tracks[0].marks[0].future, false);
});

// ---------------------------------------------------------------------------
// Malformed input degrades rather than failing
// ---------------------------------------------------------------------------

test("a malformed occurred: warns but does not take the body dates with it", () => {
  // The tiers are independent on purpose: the health panel already reports the
  // malformation, and losing the prose dates too would punish the file twice.
  const model = modelOf([["a/x.md", file("occurred: last summer", "Decided 2026-08-19.")]]);
  const c = buildChronology(model, TODAY);

  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0].text, /not a valid date span/);
  assert.equal(c.tracks.length, 1);
  assert.equal(c.tracks[0].span, null);
  assert.equal(c.tracks[0].marks.length, 1);
});

test("a span that ends before it starts is warned about and drawn as a point", () => {
  const model = modelOf([["a/x.md", file("occurred: 2026-08-18/2026-08-14")]]);
  const c = buildChronology(model, TODAY);

  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0].text, /ends before it starts/);
  assert.equal(c.tracks[0].span.invalid, true);
  assert.equal(c.tracks[0].span.to - c.tracks[0].span.from, DAY);
});

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

test("a vault with no dated files renders an explanation, not an empty axis", () => {
  const model = modelOf([["a/x.md", "# nothing\n"], ["a/y.md", "# nothing either\n"]]);
  const scene = timelineScene({ ...buildChronology(model, TODAY), scale: null });

  assert.equal(scene.empty, true);
  assert.deepEqual(scene.rows, []);
  assert.match(scene.caption, /no dated files/);
  assert.equal(scene.undated.length, 2);
});

test("the scene projects every bar and mark into 0..1", () => {
  const model = modelOf([
    ["v/clothing-brand.md", file("occurred: 2024-06/2024-12")],
    ["v/postmortem.md", file("occurred: 2026-08-14/2026-08-18", "Killed 2026-08-18.")],
  ]);
  const scene = timelineScene(buildChronology(model, TODAY));

  assert.equal(scene.rows.length, 2);
  for (const row of scene.rows) {
    if (row.bar) {
      assert.ok(row.bar.x0 >= 0 && row.bar.x1 <= 1);
      assert.ok(row.bar.x1 >= row.bar.x0);
    }
    for (const mark of row.marks) assert.ok(mark.x >= 0 && mark.x <= 1);
  }
  assert.ok(scene.today >= 0 && scene.today <= 1);
});

test("rows are ordered by when they start", () => {
  const model = modelOf([
    ["b/late.md", file("occurred: 2026-06/2026-08")],
    ["a/early.md", file("occurred: 2017/")],
  ]);
  const scene = timelineScene(buildChronology(model, TODAY));
  assert.deepEqual(scene.rows.map((r) => r.path), ["a/early.md", "b/late.md"]);
});

test("the scene can be narrowed to one domain without changing the axis", () => {
  const model = modelOf([
    ["ventures/a.md", file("occurred: 2024-06/2024-12")],
    ["system/b.md", file("occurred: 2026-06/2026-08")],
  ]);
  const chronology = buildChronology(model, TODAY);
  const all = timelineScene(chronology);
  const one = timelineScene(chronology, { domain: "ventures" });

  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].path, "ventures/a.md");
  // Same axis: filtering must not re-scale and move the remaining bar.
  assert.equal(one.rows[0].bar.x0, all.rows.find((r) => r.path === "ventures/a.md").bar.x0);
});

test("the caption counts what is on the axis and what is not", () => {
  const model = modelOf([
    ["a/dated.md", file("occurred: 2026-08-14/2026-08-18")],
    ["a/undated.md", file("updated: 2026-08-19")],
  ]);
  const scene = timelineScene(buildChronology(model, TODAY));
  assert.match(scene.caption, /1 dated file/);
  assert.match(scene.caption, /1 undated/);
});

// ---------------------------------------------------------------------------
// Imprecise span ends
//
// "occurred: 2026-06/2026-08" says Silvia AI ended somewhere in August. Drawing
// that as a solid bar to August 31st claimed a precision the author never wrote
// — and, because today is the 24th, drew a finished venture eight days into the
// future, where it read as still running.
// ---------------------------------------------------------------------------

test("a finished span never extends past today", () => {
  const model = modelOf([["ventures/silvia-ai.md", file("occurred: 2026-06/2026-08")]]);
  const span = buildChronology(model, TODAY).tracks[0].span;

  assert.ok(span.to <= Date.UTC(2026, 7, 24) + DAY, "a span with a stated end cannot still be running");
  assert.equal(span.clamped, true);
  assert.equal(span.ongoing, false);
});

test("a coarse span is certain in the middle and uncertain at both ends", () => {
  const model = modelOf([["ventures/clothing-brand.md", file("occurred: 2024-06/2024-12")]]);
  const span = buildChronology(model, TODAY).tracks[0].span;

  assert.deepEqual(span.parts.map((p) => p.certain), [false, true, false]);
  // It started somewhere in June and ended somewhere in December, so July
  // through November is the stretch it was definitely running.
  assert.equal(span.parts[1].from, Date.UTC(2024, 6, 1));
  assert.equal(span.parts[1].to, Date.UTC(2024, 11, 1));
  assert.equal(span.uncertain, true);
});

test("day precision carries no uncertainty", () => {
  // "2026-08-14" is that day. The band is the event, not a guess about it, so
  // hatching it would invent doubt the vault does not have.
  const model = modelOf([["v/postmortem.md", file("occurred: 2026-08-14/2026-08-18")]]);
  const span = buildChronology(model, TODAY).tracks[0].span;

  assert.equal(span.parts.length, 1);
  assert.equal(span.parts[0].certain, true);
  assert.equal(span.uncertain, false);
  assert.equal(span.clamped, false);
});

test("an ongoing span is uncertain only where its start is coarse", () => {
  const year = buildChronology(modelOf([["a/x.md", file("occurred: 2017/")]]), TODAY).tracks[0].span;
  assert.deepEqual(year.parts.map((p) => p.certain), [false, true]);
  assert.equal(year.parts[0].to, Date.UTC(2018, 0, 1));

  const day = buildChronology(modelOf([["a/y.md", file("occurred: 2026-08-14/")]]), TODAY).tracks[0].span;
  assert.deepEqual(day.parts.map((p) => p.certain), [true]);
});

test("touching periods leave nothing certain", () => {
  // Start and end inside the same month: it began and ended somewhere in there,
  // and no instant is guaranteed to be inside.
  const span = buildChronology(modelOf([["a/x.md", file("occurred: 2024-06/2024-06")]]), TODAY).tracks[0].span;
  assert.deepEqual(span.parts.map((p) => p.certain), [false]);
});

test("parts are contiguous and cover the whole span", () => {
  for (const value of ["2017/", "2024-06/2024-12", "2026-08-14/2026-08-18", "2026-06/2026-08", "2026-08-14/"]) {
    const span = buildChronology(modelOf([["a/x.md", file(`occurred: ${value}`)]]), TODAY).tracks[0].span;
    assert.equal(span.parts[0].from, span.from, `${value}: first part must start at the span`);
    assert.equal(span.parts[span.parts.length - 1].to, span.to, `${value}: last part must end at the span`);
    for (let i = 1; i < span.parts.length; i++) {
      assert.equal(span.parts[i].from, span.parts[i - 1].to, `${value}: parts must not leave a hole`);
    }
  }
});

test("a duration range uses one unit for both ends", () => {
  // "31 days–~3 months" makes the reader convert before they can compare.
  assert.equal(humanRange(31 * DAY, 92 * DAY), "~1–3 months");
  assert.equal(humanRange(153 * DAY, 214 * DAY), "~5–7 months");
  assert.equal(humanRange(5 * DAY, 5 * DAY), "5 days");
  assert.match(humanRange(3158 * DAY, 3523 * DAY), /^~8\.6–9\.6 years$/);
});

test("the scene projects every part of a bar into 0..1", () => {
  const model = modelOf([
    ["a/coarse.md", file("occurred: 2024-06/2024-12")],
    ["a/fine.md", file("occurred: 2026-08-14/2026-08-18")],
  ]);
  const scene = timelineScene(buildChronology(model, TODAY));
  for (const row of scene.rows) {
    for (const part of row.bar.parts) {
      assert.ok(part.x0 >= 0 && part.x1 <= 1, "part outside the axis");
      assert.ok(part.x1 >= part.x0, "part runs backwards");
    }
  }
});

test("trackSpans hands the graph intervals and nothing else", () => {
  // The join between when and where. It must carry no frontmatter, no
  // precision and no notion of a date's shape — the graph never learns any of
  // that, and an undated file is simply absent rather than present with a null.
  const model = modelOf([
    ["ventures/dated.md", file("occurred: 2024-06/2024-08")],
    ["system/undated.md", file("updated: 2026-08-24")],
  ]);
  const chronology = buildChronology(model, TODAY);
  const spans = trackSpans(chronology);

  assert.equal(spans.size, 1);
  assert.equal(spans.has("system/undated.md"), false, "an undated file must be absent, not null");
  assert.deepEqual(Object.keys(spans.get("ventures/dated.md")).sort(), ["from", "to"]);
});

test("the axis reports where events are, not only where the voids are", () => {
  // Two voids meeting at a single instant. b.md's whole span is one anchor, so
  // it has zero width on the axis: a strip drawing only the breaks shows one
  // dead block where there is in fact a recorded moment. Six of the real
  // vault's breaks are contiguous exactly like this.
  const model = modelOf([
    ["a.md", file("occurred: 2017-01-01")],
    ["b.md", file("occurred: 2024-06-01")],
    ["c.md", file("occurred: 2025-01-01")],
  ]);
  const axis = axisOf(buildChronology(model, TODAY));

  assert.ok(axis.breaks.length >= 2, `expected contiguous breaks, got ${axis.breaks.length}`);
  assert.ok(axis.events.length > axis.breaks.length, "events must outnumber the voids between them");

  // Every void's edges are event positions — which is exactly why a handle
  // dropped in a void must not snap to one.
  const at = axis.events.map((e) => e.x);
  for (const band of axis.breaks) {
    assert.ok(at.includes(band.x0), "a break's start is an event position");
    assert.ok(at.includes(band.x1), "a break's end is an event position");
  }

  // Sorted and deduped, so a renderer can draw them straight through.
  assert.deepEqual(at, [...new Set(at)].sort((x, y) => x - y));
  assert.ok(at.every((x) => x >= 0 && x <= 1));

  // Each carries the moment it stands for, not only where to draw it. The
  // keyboard steps between these, so a position with no date behind it would be
  // a stop the reader could reach and nothing could explain.
  assert.ok(axis.events.every((e) => Number.isFinite(e.ms)));
  assert.deepEqual(
    axis.events.map((e) => e.ms),
    [...axis.events.map((e) => e.ms)].sort((a, b) => a - b)
  );
});

test("the timeline and the strip read the same axis", () => {
  // One scale, three consumers. Two axes computed separately would drift apart
  // the first time either threshold moved, and a break would then mean a
  // different stretch on each panel.
  const model = modelOf([
    ["a.md", file("occurred: 2017-01-01")],
    ["b.md", file("occurred: 2026-08-14/2026-08-20")],
  ]);
  const chronology = buildChronology(model, TODAY);
  const scene = timelineScene(chronology);
  const axis = axisOf(chronology);

  assert.deepEqual(scene.axis.breaks, axis.breaks);
  assert.deepEqual(scene.axis.ticks, axis.ticks);
  assert.equal(scene.today, axis.today);
});

test("an axis with no scale reports empty rather than throwing", () => {
  const axis = axisOf({ scale: null, today: 0 });
  assert.equal(axis.empty, true);
  assert.deepEqual([axis.ticks, axis.breaks, axis.events], [[], [], []]);
  assert.equal(axis.today, null);
});

// ---------------------------------------------------------------------------
// The keyboard path — stepping between the moments that exist
// ---------------------------------------------------------------------------

/** Three ventures and a long-running one, which is the shape of the real vault. */
const STEPPABLE = () =>
  buildChronology(
    modelOf([
      ["self/learning.md", file("occurred: 2017/")],
      ["ventures/a.md", file("occurred: 2024-06-01")],
      ["ventures/b.md", file("occurred: 2026-08-14/2026-08-20")],
      ["ventures/c.md", file("occurred: 2026-08-22")],
    ]),
    TODAY
  );

test("a window opens on the current run of activity, with nothing typed", () => {
  // Everything since the last collapsed void. The whole axis would filter
  // nothing and a fixed "last 30 days" would be a guess about a vault it has
  // not looked at; this is read off the data.
  const chronology = STEPPABLE();
  const win = defaultWindow(chronology);
  const lastBreak = chronology.scale.breaks[chronology.scale.breaks.length - 1];

  assert.equal(win.from, lastBreak.to);
  assert.equal(win.to, chronology.scale.to);
  assert.ok(win.from < win.to);
  // And it holds the recent cluster rather than the nine dead years before it.
  const held = chronology.tracks.filter((t) => t.from <= win.to && t.to >= win.from);
  assert.ok(held.length >= 2, `default window held ${held.length} tracks`);
});

test("an arrow steps to the next moment that exists, not by a duration", () => {
  const chronology = STEPPABLE();
  const axis = axisOf(chronology);
  const moments = [...new Set(axis.events.map((e) => e.ms))].sort((a, b) => a - b);

  // Walk the start handle all the way back, one press at a time.
  let win = { from: moments[moments.length - 1], to: chronology.scale.to };
  const visited = [win.from];
  for (let i = 0; i < 50; i++) {
    const next = stepWindow(axis, win, "from", -1);
    if (next.from === win.from) break;
    win = next;
    visited.push(win.from);
  }

  // Every stop is a real recorded moment, and the whole axis is crossable in
  // about as many presses as there are moments.
  assert.ok(visited.every((ms) => moments.includes(ms)), "landed on a moment nothing happened at");
  assert.ok(visited.length <= moments.length, "took more presses than there are moments");
  assert.equal(win.from, moments[0], "could not reach the start of the axis");
});

test("a coarse step uses the ticks already drawn under the strip", () => {
  const chronology = STEPPABLE();
  const axis = axisOf(chronology);
  const ticks = axis.ticks.map((t) => t.ms);

  const win = stepWindow(axis, { from: chronology.scale.from, to: chronology.scale.to }, "from", 1, true);
  assert.ok(ticks.includes(win.from), "a coarse step left the labelled landmarks");
  // Coarse must actually be coarser: it skips moments a fine step would stop at.
  const fine = stepWindow(axis, { from: chronology.scale.from, to: chronology.scale.to }, "from", 1);
  assert.ok(win.from >= fine.from, "the coarse step went less far than the fine one");
});

test("the handles cannot cross", () => {
  const chronology = STEPPABLE();
  const axis = axisOf(chronology);
  const DAY_MS = 86_400_000;

  // Drive the start handle hard against the end, and past it.
  let win = { from: chronology.scale.from, to: chronology.scale.from + 2 * DAY_MS };
  for (let i = 0; i < 40; i++) win = stepWindow(axis, win, "from", 1);
  assert.ok(win.from <= win.to - DAY_MS, "start overtook end");

  // And the end handle back against the start.
  win = { from: chronology.scale.to - 2 * DAY_MS, to: chronology.scale.to };
  for (let i = 0; i < 40; i++) win = stepWindow(axis, win, "to", -1);
  assert.ok(win.to - DAY_MS >= win.from, "end overtook start");
});

test("Home and End send an edge as far as it can go, not past the other one", () => {
  const chronology = STEPPABLE();
  const win = defaultWindow(chronology);
  const DAY_MS = 86_400_000;

  assert.equal(limitWindow(chronology, win, "from", -1).from, chronology.scale.from);
  assert.equal(limitWindow(chronology, win, "to", 1).to, chronology.scale.to);

  // And the bounded direction stops against the other handle rather than
  // inverting the window.
  assert.equal(limitWindow(chronology, win, "from", 1).from, win.to - DAY_MS);
  assert.equal(limitWindow(chronology, win, "to", -1).to, win.from + DAY_MS);
  for (const [edge, dir] of [["from", 1], ["to", -1], ["from", -1], ["to", 1]]) {
    const out = limitWindow(chronology, win, edge, dir);
    assert.ok(out.from <= out.to - DAY_MS, `${edge}/${dir} inverted the window`);
  }
});

test("stepping a window that does not exist changes nothing", () => {
  const chronology = STEPPABLE();
  const axis = axisOf(chronology);
  assert.equal(stepWindow(axis, null, "from", 1), null);
  assert.equal(stepWindow({ empty: true }, { from: 0, to: 1 }, "from", 1).from, 0);
  assert.equal(defaultWindow({ scale: null }), null);
});
