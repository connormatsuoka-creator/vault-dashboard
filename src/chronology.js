// chronology.js
//
// When things happened, derived from the vault rather than authored separately.
// Emits plain data and builds no DOM — the same seam as graph.js's scene and
// markdown.js's block tree, and the reason this is testable in Node instead of
// judged by eye in a browser.
//
// WHAT THE VAULT ACTUALLY HOLDS — measured, not assumed
//
// 46 datable events across 20 of 35 files, in three tiers:
//
//   occurred:   9 files.  Authored deliberately, governed by the frontmatter
//                         contract, already validated by the health panel.
//   body dates  11 more.  YYYY-MM-DD mined out of prose.
//   neither     15 files. No event date at all.
//
// THE THREE RULES THAT MAKE IT HONEST
//
// 1. `updated:` is never promoted to an event. It is metadata about the file,
//    not about the world. Deriving an event date from it is the same mistake as
//    reconstructing `updated:` from git blame — inventing precision the author
//    never wrote. Undated files are counted and listed, never placed on the
//    axis at a guessed position.
//
// 2. Precision is width. `2017` is a year-wide band, `2024-06` a month, and
//    `2026-08-14` a day. Plotting "2017" at January 1st invents ten months.
//
// 3. Only unambiguous YYYY-MM-DD is mined from prose. The vault also writes
//    `Fri 8/14` (8 rows), `2026-08-14 -> 08-18`, and `2018/19-2023` — all real
//    events, none carrying a year. The year is guessable from the file's own
//    occurred: span, and guessing is precisely what rule 1 refuses to do, so
//    these are counted and reported rather than silently dropped.

import { classifyLines } from "./model.js";
import { tokenize } from "./markdown.js";

const DAY = 86_400_000;

/** Collapsed gaps take at most this share of the axis, however many there are. */
const BREAK_TOTAL = 0.3;
/** A gap must clear both bars to collapse: relative to its neighbours, and absolute. */
const BREAK_FACTOR = 4;
const MIN_BREAK_DAYS = 60;

// ---------------------------------------------------------------------------
// The date grammar
//
// Owned here and imported by health.js. It used to live there as a validator
// only; the timeline needs to fully parse, and a second opinion about what a
// valid date is would let the health panel and this module disagree about the
// same string — the failure the shared LINK_SOURCE regex exists to prevent.
// ---------------------------------------------------------------------------

const PART_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one half of an occurred: value into a real interval.
 *
 * Returns null for anything malformed, INCLUDING dates that match the shape but
 * do not exist — "2026-02-30" is caught here, where the old regex-only check
 * passed it.
 *
 * @returns {{iso:string, precision:'year'|'month'|'day', from:number, to:number}|null}
 */
export function parsePart(part) {
  if (typeof part !== "string") return null;
  const m = PART_RE.exec(part);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? null : Number(m[2]);
  const day = m[3] === undefined ? null : Number(m[3]);

  if (day !== null) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const from = Date.UTC(year, month - 1, day);
    const check = new Date(from);
    // Date.UTC rolls February 30th into March. Rejecting the roll is what makes
    // this a real calendar check rather than a shape check.
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { iso: part, precision: "day", from, to: from + DAY };
  }
  if (month !== null) {
    if (month < 1 || month > 12) return null;
    return { iso: part, precision: "month", from: Date.UTC(year, month - 1, 1), to: Date.UTC(year, month, 1) };
  }
  return { iso: part, precision: "year", from: Date.UTC(year, 0, 1), to: Date.UTC(year + 1, 0, 1) };
}

/**
 * Parse an occurred: value.
 *
 *   "2017/"                 started 2017, still going
 *   "2024-06/2024-12"       closed span
 *   "2026-08-14"            a single period, neither open nor closed
 *
 * @returns {{raw:string, start:object, end:object|null, ongoing:boolean}|null}
 */
export function parseOccurred(value) {
  if (typeof value !== "string" || value === "") return null;
  const parts = value.split("/");
  if (parts.length > 2) return null;

  const start = parsePart(parts[0]);
  if (!start) return null;

  const ongoing = parts.length === 2 && parts[1] === "";
  let end = null;
  if (parts.length === 2 && parts[1] !== "") {
    end = parsePart(parts[1]);
    if (!end) return null;
  }
  return { raw: value, start, end, ongoing };
}

/** Kept as a predicate so health.js reads the same way it always did. */
export function isOccurred(value) {
  return parseOccurred(value) !== null;
}

export function isIsoDate(value) {
  return typeof value === "string" && ISO_DAY_RE.test(value) && parsePart(value) !== null;
}

// ---------------------------------------------------------------------------
// Mining dates out of prose
// ---------------------------------------------------------------------------

/**
 * Flatten inline tokens to the text a reader would call prose.
 *
 * Code spans and link targets become a space rather than vanishing, so removing
 * one can never splice its neighbours into a date that was never written.
 */
function proseOf(tokens) {
  let out = "";
  for (const token of tokens) {
    if (token.type === "code" || token.type === "link") out += " ";
    else if (token.children) out += proseOf(token.children);
    else if (token.type === "text") out += token.value;
  }
  return out;
}

/**
 * Every unambiguous date written in a body, excluding code.
 *
 * Block code is excluded by classifyLines and inline code by the markdown
 * tokenizer — this module asks them rather than deciding again. Exactly one
 * date in the vault depends on it: system/decisions.md writes `2026-08-15/`
 * inside backticks as an example OF THE FORMAT, and a naive scan puts a
 * fictional event on the timeline.
 */
export function extractDates(body) {
  const found = [];
  classifyLines(body ?? "").forEach(({ line, isCode }, index) => {
    if (isCode) return;
    const prose = proseOf(tokenize(line));
    for (const match of prose.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
      const part = parsePart(match[0]);
      if (!part) continue;
      found.push({
        iso: match[0],
        from: part.from,
        to: part.to,
        precision: "day",
        line: index + 1, // body-relative: frontmatter is already stripped
        text: line.trim(),
      });
    }
  });
  return found;
}

/**
 * Count year-less dates that rule 3 declines to mine.
 *
 * A heuristic for reporting only — it requires a plausible month and day so
 * that "60/60" (a cap written as a fraction) is not counted as August 60th.
 */
export function countYearless(body) {
  let count = 0;
  for (const { line, isCode } of classifyLines(body ?? "")) {
    if (isCode) continue;
    const prose = proseOf(tokenize(line));
    for (const match of prose.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
      if (Number(match[1]) >= 1 && Number(match[1]) <= 12 && Number(match[2]) >= 1 && Number(match[2]) <= 31) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// The axis
//
// A true proportional axis is unusable against this vault: the span runs 2017
// to 2026, and 43 of 46 events land inside the last 2% of it. Nine years of
// width would show nothing.
//
// A purely ordinal axis — one slot per event — is legible but deletes gap
// length, and gap length is the single most analytical thing the vault does
// with its own dates: ventures/the-pattern.md computes the space between
// ventures by hand and concludes the gaps are collapsing.
//
// So the axis is piecewise. Dense stretches keep real proportional width, and
// an empty stretch collapses into a break that STATES THE DURATION IT
// SWALLOWED. The label carrying what the compression removed is what makes it
// an honest summary rather than a distortion.
// ---------------------------------------------------------------------------

/** Round a duration the way a person would say it. */
export function humanDuration(ms) {
  const days = Math.round(ms / DAY);
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  const months = days / 30.44;
  if (months < 11.5) return `~${Math.round(months)} months`;
  return `~${(days / 365.25).toFixed(1)} years`;
}

/**
 * Express a min/max duration in one unit, chosen from the larger end.
 *
 * Formatting each end independently produces "31 days–~3 months", which makes
 * the reader convert before they can compare the two numbers.
 */
export function humanRange(min, max) {
  const days = Math.round(max / DAY);
  if (days < 45) {
    const lo = Math.round(min / DAY);
    return lo === days ? `${days} day${days === 1 ? "" : "s"}` : `${lo}–${days} days`;
  }
  if (days / 30.44 < 11.5) {
    const lo = Math.max(1, Math.round(min / DAY / 30.44));
    const hi = Math.round(days / 30.44);
    return lo === hi ? `~${hi} months` : `~${lo}–${hi} months`;
  }
  const lo = (min / DAY / 365.25).toFixed(1);
  const hi = (days / 365.25).toFixed(1);
  return lo === hi ? `~${hi} years` : `~${lo}–${hi} years`;
}

/**
 * Build the piecewise mapping from a timestamp to a 0..1 position.
 *
 * Gaps are measured between ANCHORS — the moments something is recorded — not
 * across the coverage of spans. self/learning.md is `occurred: 2017/`, still
 * ongoing, so its bar covers the entire timeline; measuring coverage would mean
 * nothing was ever empty and nothing could ever collapse. A long bar drawn
 * across a break is honest: it continued, and nothing was recorded in between.
 */
export function buildScale(anchors) {
  const points = [...new Set(anchors)].filter(Number.isFinite).sort((a, b) => a - b);

  if (points.length === 0) return null;
  if (points.length === 1) {
    const only = points[0];
    return {
      from: only,
      to: only,
      degenerate: true,
      segments: [],
      breaks: [],
      project: () => 0.5,
      unproject: () => only,
      // One moment exists, so every position on the axis resolves to it. Saying
      // snapped: true is not a technicality — a brush here cannot be dragged to
      // mean anything else, and the readout should say so rather than invent a
      // range from a single point.
      resolve: () => ({ unit: 0.5, ms: only, snapped: true }),
    };
  }

  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i] - points[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = Math.max(BREAK_FACTOR * median, MIN_BREAK_DAYS * DAY);

  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    segments.push({ from, to, length: to - from, isBreak: to - from > threshold });
  }

  const breakCount = segments.filter((s) => s.isBreak).length;
  const normal = segments.filter((s) => !s.isBreak);
  const normalTotal = normal.reduce((sum, s) => sum + s.length, 0);

  // Breaks are capped as a group, so six of them cannot crowd out the events.
  const breakShare = breakCount ? BREAK_TOTAL : 0;
  const perBreak = breakCount ? breakShare / breakCount : 0;

  let cursor = 0;
  for (const segment of segments) {
    let width;
    if (segment.isBreak) width = perBreak;
    else if (normalTotal > 0) width = (1 - breakShare) * (segment.length / normalTotal);
    else width = (1 - breakShare) / Math.max(1, normal.length); // every gap collapsed
    segment.x0 = cursor;
    segment.x1 = cursor + width;
    cursor = segment.x1;
  }
  // Absorb floating-point drift rather than ending the axis at 0.99999.
  segments[segments.length - 1].x1 = 1;

  const project = (t) => {
    if (!Number.isFinite(t)) return null;
    if (t <= points[0]) return 0;
    if (t >= points[points.length - 1]) return 1;
    for (const segment of segments) {
      if (t >= segment.from && t <= segment.to) {
        const within = segment.length === 0 ? 0 : (t - segment.from) / segment.length;
        return segment.x0 + within * (segment.x1 - segment.x0);
      }
    }
    return 1;
  };

  /**
   * A position on the axis back to a moment — the exact inverse of project.
   *
   * A brush is dragged in pixels, so the window it produces only exists once
   * the axis can be read backwards. Same segment walk, same clamping: every
   * anchor survives a round trip to within a second, which is the property the
   * test asserts.
   */
  const unproject = (unit) => {
    if (!Number.isFinite(unit)) return null;
    if (unit <= 0) return points[0];
    if (unit >= 1) return points[points.length - 1];
    for (const segment of segments) {
      if (unit >= segment.x0 && unit <= segment.x1) {
        const width = segment.x1 - segment.x0;
        const within = width === 0 ? 0 : (unit - segment.x0) / width;
        return segment.from + within * segment.length;
      }
    }
    return points[points.length - 1];
  };

  /**
   * Where a dragged handle actually lands.
   *
   * Inside a break, the axis is violently non-linear — fifty pixels can carry
   * eleven months — so a handle dropped there names a date the pixel cannot
   * really resolve. It snaps to the nearer edge of the break.
   *
   * That is a normalisation, not an approximation, and the difference matters:
   * a break exists BECAUSE no event falls inside it, so every position within
   * one selects the identical set of files. Snapping cannot change the answer.
   * All it changes is the date the readout claims, from an arbitrary one to a
   * date a reader can act on. Nearer edge by screen distance rather than by
   * elapsed time, so the handle keeps following the pointer.
   *
   * The one-day inset is not a fudge. A break's EDGES are the two events that
   * bracket it — band.from is where the last one ended and band.to is where the
   * next one begins — so an edge is the single position in the whole band that
   * DOES change the selection, since a window boundary is closed at both ends.
   * Landing a day inside the void keeps the promise the snapping is justified
   * by. A break clears MIN_BREAK_DAYS by construction, so a day is always
   * strictly inside one.
   *
   * @returns {{unit:number, ms:number, snapped:boolean}}
   */
  const resolve = (unit) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(unit) ? unit : 0));
    const band = segments.find((s) => s.isBreak && clamped > s.x0 && clamped < s.x1);
    if (!band) return { unit: clamped, ms: unproject(clamped), snapped: false };
    const ms = clamped - band.x0 <= band.x1 - clamped ? band.from + DAY : band.to - DAY;
    // Reprojected rather than returned as the edge, so the handle sits where
    // the date says it does and the readout cannot contradict the drawing.
    return { unit: project(ms), ms, snapped: true };
  };

  const breaks = segments
    .filter((s) => s.isBreak)
    .map((s) => ({
      from: s.from,
      to: s.to,
      x0: s.x0,
      x1: s.x1,
      days: Math.round(s.length / DAY),
      label: humanDuration(s.length),
    }));

  return {
    from: points[0],
    to: points[points.length - 1],
    degenerate: false,
    segments,
    breaks,
    project,
    unproject,
    resolve,
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------


/**
 * Resolve an occurred: span into contiguous parts, each marked certain or not.
 *
 * "2026-06/2026-08" says the venture started somewhere in June and ended
 * somewhere in August. Taking the outer edge of both — June 1st to September
 * 1st — is the smallest window guaranteed to contain it, but drawing that as a
 * solid bar asserts it ran through August 31st, which is a stronger claim than
 * the author made. So the bar is split:
 *
 *   head   the start period      uncertain — it began somewhere in here
 *   core   between the periods   certain — it was definitely running
 *   tail   the end period        uncertain — it ended somewhere in here
 *
 * A DAY-precision endpoint carries no uncertainty: "2026-08-14" is that day,
 * and the band is the event rather than a guess about it. Only coarser
 * precision produces an uncertain region.
 *
 * The tail is also cut at today, because a span with a stated end cannot still
 * be running. Without that, Silvia AI — "2026-06/2026-08", finished — drew
 * eight days past today and read as ongoing.
 */
function buildSpan(parsed, raw, todayMs) {
  const start = parsed.start;
  const end = parsed.end;
  const horizon = todayMs + DAY;

  const from = start.from;
  const headUncertain = start.precision !== "day";
  const tailUncertain = Boolean(end) && end.precision !== "day";

  let to;
  let clamped = false;
  if (parsed.ongoing) to = horizon;
  else if (end) {
    to = end.to;
    // Only the uncertain part of a finished span is cut — a stated future end
    // is a commitment, and shortening it would be inventing a different claim.
    if (tailUncertain && to > horizon && end.from < horizon) {
      to = horizon;
      clamped = true;
    }
  } else to = start.to;

  const headTo = Math.min(headUncertain ? start.to : from, to);
  const tailFrom = tailUncertain ? Math.max(end.from, headTo) : to;

  const parts = [];
  const push = (a, b, certain) => {
    if (b > a) parts.push({ from: a, to: b, certain });
  };

  if (headUncertain && tailUncertain && tailFrom <= headTo) {
    // The periods touch or overlap, so nothing is certain — one band, not three.
    push(from, to, false);
  } else {
    push(from, headTo, false);
    push(headUncertain ? headTo : from, tailFrom, true);
    push(tailFrom, to, false);
  }
  if (parts.length === 0) push(from, Math.max(to, from + DAY), !headUncertain);

  const certain = parts.filter((p) => p.certain).reduce((sum, p) => sum + (p.to - p.from), 0);
  const envelope = to - from;
  const duration = certain > 0 ? humanRange(certain, envelope) : humanDuration(envelope);

  return {
    from,
    to,
    parts,
    ongoing: parsed.ongoing,
    precision: start.precision,
    raw,
    invalid: false,
    clamped,
    uncertain: headUncertain || tailUncertain,
    label: parsed.ongoing
      ? `${start.iso} — ongoing`
      : end
        ? `${start.iso} — ${end.iso}`
        : start.iso,
    duration,
  };
}

/**
 * Turn the vault model into tracks on a timeline.
 *
 * A file is a TRACK, not a point. Four files carry both an occurred: span and
 * dates in their prose — projects/focus-timer/status.md has a span plus seven
 * body dates — so the span becomes a bar and the body dates become marks along
 * it. Picking one date per file would resolve that disagreement silently;
 * showing both renders it.
 *
 * @param {object} model  from buildModel()
 * @param {Date} today    injected, matching runHealthChecks — a timeline whose
 *                        tests drift with the wall clock is not testable
 */
export function buildChronology(model, today = new Date()) {
  const todayMs = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const tracks = [];
  const undated = [];
  const warnings = [];
  let yearless = 0;

  for (const file of model.files) {
    const raw = file.data?.occurred;
    let span = null;

    if (raw !== undefined) {
      const parsed = parseOccurred(raw);
      if (!parsed) {
        // The health panel already reports the malformation. Here it must not
        // take the file's body dates down with it, so the tiers stay independent.
        warnings.push({ path: file.path, text: `occurred: "${raw}" is not a valid date span` });
      } else if (parsed.end && parsed.end.to < parsed.start.from) {
        warnings.push({ path: file.path, text: `occurred: "${raw}" ends before it starts` });
        const from = parsed.start.from;
        span = {
          from,
          to: from + DAY,
          parts: [{ from, to: from + DAY, certain: false }],
          ongoing: false,
          precision: parsed.start.precision,
          raw,
          invalid: true,
          clamped: false,
          uncertain: true,
          label: `${parsed.start.iso} — ${parsed.end.iso}`,
          duration: humanDuration(DAY),
        };
      } else {
        span = buildSpan(parsed, raw, todayMs);
      }
    }

    const marks = extractDates(file.body).map((mark) => ({ ...mark, future: mark.from > todayMs }));
    yearless += countYearless(file.body);

    const entry = { path: file.path, name: file.name, domain: file.domain };

    if (!span && marks.length === 0) {
      // Rule 1: updated: is carried for reference and never used as a position.
      undated.push({ ...entry, updated: file.data?.updated ?? null });
      continue;
    }

    tracks.push({
      ...entry,
      span,
      marks,
      from: Math.min(...(span ? [span.from] : []), ...marks.map((m) => m.from)),
      to: Math.max(...(span ? [span.to] : []), ...marks.map((m) => m.to)),
    });
  }

  tracks.sort((a, b) => a.from - b.from || a.path.localeCompare(b.path));

  const anchors = [todayMs, todayMs + DAY];
  for (const track of tracks) {
    if (track.span) {
      // Point anchors only: where something STARTS or ENDS, not where it was
      // merely running. Adding the certainty boundaries here was tried and
      // reverted — it lifted the median gap from ~2 days to ~30, which lifted the
      // collapse threshold to 120 days, which stopped the month-long stretches
      // collapsing and cut August 2026 from 58% of the axis to 4%.
      anchors.push(track.span.from);
      if (!track.span.ongoing) anchors.push(track.span.to);
    }
    for (const mark of track.marks) anchors.push(mark.from, mark.to);
  }

  const scale = buildScale(anchors);
  const events = tracks.reduce((sum, t) => sum + (t.span ? 1 : 0) + t.marks.length, 0);

  return {
    tracks,
    undated,
    warnings,
    scale,
    today: todayMs,
    events,
    yearless,
    breaks: scale ? scale.breaks : [],
  };
}

/**
 * Where a window opens when it is asked for without a pointer.
 *
 * "The current run of activity": everything since the last collapsed void. The
 * alternative defaults are all worse — the whole axis filters nothing, and a
 * fixed "last 30 days" is a guess about a vault it has not looked at. This one
 * is read off the data: a break exists precisely because nothing happened in
 * it, so the stretch after the last one is where the vault currently lives. On
 * this one that is 2026-08-12 onward, seventeen days holding 39 of 53 events.
 */
export function defaultWindow(chronology) {
  const scale = chronology?.scale;
  if (!scale || scale.degenerate) return null;
  const last = scale.breaks[scale.breaks.length - 1];
  return { from: last ? last.to : scale.from, to: scale.to };
}

/**
 * Move one edge of a window to the next place worth stopping.
 *
 * THE AXIS IS DISCRETE, and that is the whole design. This vault records 23
 * moments; a keyboard that moved by a fixed duration would need hundreds of
 * presses to cross nine years and would keep landing on dates where nothing
 * happened. Stepping between the moments that EXIST crosses the entire axis in
 * 22 presses and can never select a boundary that means nothing. It is also why
 * the keyboard path needs no typing: there is no date to spell.
 *
 * Coarse steps use the axis's own labelled ticks — the months and years already
 * drawn under the strip — so the two granularities are both things the reader
 * can already see.
 *
 * The end handle names the LAST INCLUDED DAY while the window itself is
 * half-open, so a readout can never disagree with the handle a reader just
 * moved.
 *
 * @param {'from'|'to'} edge
 * @param {number} direction -1 earlier, +1 later
 */
export function stepWindow(axis, window, edge, direction, coarse = false) {
  if (!axis || axis.empty || !window) return window;
  const stops = [...new Set((coarse ? axis.ticks : axis.events).map((p) => p.ms))].sort((a, b) => a - b);
  if (stops.length === 0) return window;

  const current = edge === "from" ? window.from : window.to - DAY;
  const next =
    direction < 0
      ? [...stops].reverse().find((ms) => ms < current)
      : stops.find((ms) => ms > current);
  if (next === undefined) return window;

  // The handles cannot cross. An edge pushed past the other stops against it
  // rather than inverting the window under the reader.
  if (edge === "from") return { from: Math.min(next, window.to - DAY), to: window.to };
  return { from: window.from, to: Math.max(next, window.from) + DAY };
}

/**
 * Send one edge as far as it can go — Home and End.
 *
 * "As far as it can go" rather than "to the end of the axis", because an edge
 * is bounded by the other one as well as by the axis. End on the START handle
 * means up against the end handle, not past it.
 *
 * @param {'from'|'to'} edge
 * @param {number} direction -1 as early as possible, +1 as late as possible
 */
export function limitWindow(chronology, window, edge, direction) {
  const scale = chronology?.scale;
  if (!scale || !window) return window;
  if (edge === "from") {
    return direction < 0 ? { from: scale.from, to: window.to } : { from: window.to - DAY, to: window.to };
  }
  return direction < 0 ? { from: window.from, to: window.from + DAY } : { from: window.from, to: scale.to };
}

/**
 * The outer bounds of every dated file, keyed by path.
 *
 * This is the join between "when" and "where". The graph needs to know which
 * files were live during a window, and handing it plain intervals rather than a
 * chronology keeps graph.js ignorant of frontmatter, precision and the date
 * grammar — it never learns that a date has a shape. A path absent from this
 * map is undated, which is a fact the brush treats as its own case rather than
 * as a missing value.
 */
export function trackSpans(chronology) {
  return new Map(chronology.tracks.map((t) => [t.path, { from: t.from, to: t.to }]));
}

// ---------------------------------------------------------------------------
// The scene — positions and states, no shapes
// ---------------------------------------------------------------------------

/** Adaptive tick label: the finer the axis, the more of the date it shows. */
function tickLabel(ms, totalSpan) {
  const iso = new Date(ms).toISOString().slice(0, 10);
  return totalSpan > 400 * DAY ? iso.slice(0, 7) : iso.slice(5);
}

/**
 * The axis alone: ticks, breaks and today, with no rows.
 *
 * Extracted because the brush strip needs exactly this and nothing else. It is
 * the third consumer of one scale, which is the point — a break in the strip
 * means the same eleven months it means on the timeline, because it IS the same
 * break. Two axes computed separately would drift apart the first time either
 * threshold moved.
 */
export function axisOf(chronology) {
  return axisFor(chronology?.scale, chronology?.today);
}

/**
 * The axis of ANY scale, not only the vault's whole one.
 *
 * Split out because the timeline brush rebuilds a scale over just the brushed
 * window — the strip stays the overview and the plot becomes the detail — and
 * that detail scale needs ticks and breaks of its own. `today` is passed rather
 * than assumed so it can be dropped when it falls outside the window: projecting
 * it would clamp it to an edge and draw "today" at a date that is not today.
 */
export function axisFor(scale, today) {
  if (!scale) return { ticks: [], breaks: [], events: [], today: null, empty: true };

  const totalSpan = scale.to - scale.from;
  const ticks = [];
  let previous = null;
  for (const segment of scale.segments) {
    const label = tickLabel(segment.from, totalSpan);
    if (label !== previous) {
      ticks.push({ x: segment.x0, label, ms: segment.from });
      previous = label;
    }
  }

  // Where things actually happened, as positions on the axis.
  //
  // A strip that draws only breaks is lying by omission. Six of this vault's
  // breaks are CONTIGUOUS - each pair is separated by a single instant, an
  // event whose whole span is one anchor - so the compressed stretch reads as
  // one dead block when it in fact holds five distinct moments. The timeline
  // gets away without this because its rows draw a mark at that position; a
  // strip has no rows, so the moment vanishes with nothing to stand for it.
  const events = [];
  for (const segment of scale.segments) {
    if (events[events.length - 1]?.x !== segment.x0) events.push({ x: segment.x0, ms: segment.from });
    events.push({ x: segment.x1, ms: segment.to });
  }

  // Outside the scale, today is nothing to draw. project() would clamp it to an
  // edge, putting the marker on a date that is not today.
  const at = Number.isFinite(today) && today >= scale.from && today <= scale.to ? scale.project(today) : null;
  return { ticks, breaks: scale.breaks, events, today: at, empty: false };
}

/**
 * Project every track onto the axis.
 *
 * @param {object} chronology from buildChronology
 * @param {{domain?: string}} view
 */
/**
 * Rebuild the axis over a brushed window.
 *
 * This is what makes the timeline's brush a ZOOM rather than a filter, and the
 * difference matters: dimming rows would leave the timeline's actual weakness
 * untouched, which is that August 2026 holds 39 events crammed into 58% of the
 * axis. Rescaling is what "focus in on a timeframe" has to mean here.
 *
 * The window's own edges are anchored, so a window wider than the events inside
 * it keeps its empty margins instead of silently shrinking to fit them — the
 * reader asked for that range and should see all of it. Breaks then recompute
 * against the window's own median gap, so zooming into a fortnight collapses
 * nothing and zooming into a decade still collapses the voids.
 */
function windowScale(chronology, window) {
  const inside = (ms) => ms >= window.from && ms <= window.to;
  const anchors = [window.from, window.to];

  for (const track of chronology.tracks) {
    if (track.span) {
      if (inside(track.span.from)) anchors.push(track.span.from);
      if (!track.span.ongoing && inside(track.span.to)) anchors.push(track.span.to);
    }
    for (const mark of track.marks) {
      if (inside(mark.from)) anchors.push(mark.from);
      if (inside(mark.to)) anchors.push(mark.to);
    }
  }
  return buildScale(anchors);
}

export function timelineScene(chronology, view = {}) {
  const { tracks, undated, today } = chronology;
  const byDomain = view.domain ? tracks.filter((t) => t.domain === view.domain) : tracks;

  // A window both rescales the axis and drops the rows it does not reach.
  // Overlap, not containment — the same rule the graph's brush uses, so a
  // long-running venture is not hidden by asking about a month inside it.
  const win = view.window ?? null;
  const shown = win ? byDomain.filter((t) => t.from <= win.to && t.to >= win.from) : byDomain;
  const scale = win ? windowScale(chronology, win) : chronology.scale;

  if (!scale) {
    return {
      rows: [],
      axis: { ticks: [], breaks: [], events: [] },
      today: null,
      undated,
      empty: true,
      caption: `no dated files — ${undated.length} file${undated.length === 1 ? "" : "s"} carry no event date`,
    };
  }

  const at = (t) => scale.project(t);
  const axis = axisFor(scale, today);

  const rows = shown.map((track) => ({
    path: track.path,
    name: track.name,
    domain: track.domain,
    bar: track.span
      ? {
          x0: at(track.span.from),
          x1: at(track.span.to),
          parts: track.span.parts.map((part) => ({ x0: at(part.from), x1: at(part.to), certain: part.certain })),
          ongoing: track.span.ongoing,
          precision: track.span.precision,
          uncertain: track.span.uncertain,
          clamped: track.span.clamped,
          label: track.span.label,
          duration: track.span.duration,
        }
      : null,
    marks: track.marks.map((mark) => ({
      x: at(mark.from),
      iso: mark.iso,
      text: mark.text,
      future: mark.future,
      line: mark.line,
    })),
  }));

  const ahead = shown.reduce((sum, t) => sum + t.marks.filter((m) => m.future).length, 0);
  const caption =
    (win ? `${shown.length} of ${byDomain.length} dated files in the window · ` : `${shown.length} dated file${shown.length === 1 ? "" : "s"} · `) +
    `${scale.breaks.length} gap${scale.breaks.length === 1 ? "" : "s"} collapsed · ` +
    `${undated.length} undated` +
    (ahead ? ` · ${ahead} ahead of today` : "");

  return { rows, axis, today: axis.today, undated, empty: false, caption };
}
