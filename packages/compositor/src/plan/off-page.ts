import type { CursorGap, CursorSample } from "../bundle.js";
import { lerpVec, type Vec } from "../geometry.js";
import { CURSOR_REST_MS } from "./smooth.js";

/**
 * Where a pointer that stopped being observed went, when it went off the
 * page — and how to draw it going there.
 *
 * The sensor opens a `CursorGap` for three different reasons: the pointer
 * left the document (over the browser's own chrome, another window, the
 * toolbar's Stop), it went into an iframe, or it went onto something like a
 * native `<select>` popup. Only the first is off the page, and the gap does
 * not say which it was. The geometry does: a pointer that leaves the page
 * leaves through an edge, so its last sighting is beside one or heading
 * for one, while the other two stop being observed somewhere inside.
 *
 * Getting that wrong one way draws a journey to the edge that nothing made;
 * the other way leaves the cursor parked just inside the edge for as long as
 * the hand is over the toolbar, which is what every take ending on Stop did
 * before this existed. The first is the worse lie, so the test is tight.
 *
 * **This runs on the samples as recorded, before anything else touches
 * them.** It was first written as a replacement for `holdAcrossGaps`' hold,
 * at the end of the pipeline, and drew a hitch at the edge in every exit:
 * the smoothing, re-timing and spring stages all read a gap's start as the
 * end of a gesture and ease into it, so the drawn cursor slowed from 1.5 to
 * 0.74px/ms just inside the edge, and the glide bolted on after them set off
 * again at 1.5. Measured on a steady sweep; on a real hand the easing
 * varies take to take, so the hitch did too. Added up front, the off-page
 * run is part of the gesture those stages shape, the easing lands out of
 * frame, and what is left of the gap is only the wait off the page.
 */

/** A sighting this close to an edge is beside it whatever it was doing. */
export const OFF_PAGE_EDGE_PX = 24;
/** Heading for an edge counts only if it would get there this soon. At 3px/ms
 *  — a brisk flick — that is 150px, which a 60Hz sampler's last sighting
 *  before an exit is always well inside, and an iframe 300px from the edge
 *  is well outside. */
export const OFF_PAGE_REACH_MS = 50;
/** How far back the observed velocity is read from a gap's edge. Three
 *  pointermove frames at 60Hz. */
const VELOCITY_WINDOW_MS = 48;
/** Slower than this is "barely moving": no heading worth trusting. */
const MIN_HEADING_SPEED = 0.05;
/** The glide never goes slower than this, in CSS px per ms. A pointer that
 *  drifted out at a crawl would otherwise take seconds to clear the frame,
 *  with part of the arrow showing at the edge the whole time. */
export const OFF_PAGE_MIN_SPEED = 0.5;
/**
 * How far past the edge the glide carries the hotspot, as a fraction of the
 * viewport's longer side.
 *
 * It has to clear the whole drawn arrow, and the arrow's size in CSS px is
 * not known here: it is fixed in output pixels (`CURSOR_ART`, times the
 * look's scale up to 2), and how many CSS px that spans depends on the
 * output, the padding and the window's aspect. The worst case measured is a
 * 1280-wide page in a portrait 1080x1920 output at scale 2, where the arrow
 * is about 240 CSS px tall; a quarter of the longer side is 320 there. The
 * extra distance costs nothing that shows — it is all outside the frame.
 */
const OFF_PAGE_MARGIN = 0.25;

/**
 * The way out of the page through which a pointer at `at`, moving at
 * `velocity` (CSS px per ms), left it — or `null` when it stopped being
 * observed somewhere inside the page instead.
 */
export function offPageDirection(
  at: Vec,
  velocity: Vec,
  viewport: { width: number; height: number },
): Vec | null {
  const speed = Math.hypot(velocity.x, velocity.y);
  // Only from inside the page. Past an edge already — a drag with pointer
  // capture samples there — the heading may point back in, and the run
  // along it would cross the page; the nearest edge below is the way out.
  const inside =
    at.x >= 0 && at.x <= viewport.width && at.y >= 0 && at.y <= viewport.height;
  if (inside && speed >= MIN_HEADING_SPEED) {
    const heading = { x: velocity.x / speed, y: velocity.y / speed };
    const reach = OFF_PAGE_EDGE_PX + speed * OFF_PAGE_REACH_MS;
    if (distanceToEdge(at, heading, viewport) <= reach) return heading;
  }
  const edges: Array<[number, Vec]> = [
    [at.x, { x: -1, y: 0 }],
    [viewport.width - at.x, { x: 1, y: 0 }],
    [at.y, { x: 0, y: -1 }],
    [viewport.height - at.y, { x: 0, y: 1 }],
  ];
  let nearest = edges[0] as [number, Vec];
  for (const edge of edges) if (edge[0] < nearest[0]) nearest = edge;
  return nearest[0] <= OFF_PAGE_EDGE_PX ? nearest[1] : null;
}

/** How far along unit `heading` from `at` the viewport's boundary is; 0
 *  for a point already on or past it. */
function distanceToEdge(
  at: Vec,
  heading: Vec,
  viewport: { width: number; height: number },
): number {
  const toBound = (p: number, d: number, size: number): number =>
    d > 0 ? (size - p) / d : d < 0 ? -p / d : Number.POSITIVE_INFINITY;
  const d = Math.min(
    toBound(at.x, heading.x, viewport.width),
    toBound(at.y, heading.y, viewport.height),
  );
  const inside =
    at.x >= 0 && at.x <= viewport.width && at.y >= 0 && at.y <= viewport.height;
  return inside ? Math.max(0, d) : 0;
}

/**
 * The last sighting at or before `ms`, and the velocity it arrived with.
 * `side: "after"` reads the first sighting at or after `ms` and the velocity
 * it set off with instead. `null` when there is no sighting on that side.
 */
export function sightingBeside(
  observed: readonly CursorSample[],
  ms: number,
  side: "before" | "after",
): { at: CursorSample; velocity: Vec } | null {
  if (side === "before") {
    let i = observed.length - 1;
    while (i >= 0 && (observed[i] as CursorSample).sourceTimeMs > ms) i--;
    const last = observed[i];
    if (!last) return null;
    let j = i;
    while (
      j > 0 &&
      last.sourceTimeMs - (observed[j - 1] as CursorSample).sourceTimeMs <=
        VELOCITY_WINDOW_MS
    ) {
      j--;
    }
    return { at: last, velocity: velocityBetween(observed[j], last) };
  }
  let i = 0;
  while (
    i < observed.length &&
    (observed[i] as CursorSample).sourceTimeMs < ms
  ) {
    i++;
  }
  const first = observed[i];
  if (!first) return null;
  let j = i;
  while (
    j < observed.length - 1 &&
    (observed[j + 1] as CursorSample).sourceTimeMs - first.sourceTimeMs <=
      VELOCITY_WINDOW_MS
  ) {
    j++;
  }
  return { at: first, velocity: velocityBetween(first, observed[j]) };
}

function velocityBetween(
  from: CursorSample | undefined,
  to: CursorSample | undefined,
): Vec {
  if (!from || !to) return { x: 0, y: 0 };
  const dt = to.sourceTimeMs - from.sourceTimeMs;
  return dt > 0
    ? { x: (to.x - from.x) / dt, y: (to.y - from.y) / dt }
    : { x: 0, y: 0 };
}

/**
 * The straight run from `from` out of the page along `heading`: where it
 * ends, far enough past the edge that no part of the arrow is in frame, and
 * how long it takes at `speed` (floored at `OFF_PAGE_MIN_SPEED`).
 */
function glideOut(
  from: Vec,
  heading: Vec,
  speed: number,
  viewport: { width: number; height: number },
): { speed: number; ms: number } {
  const pace = Math.max(speed, OFF_PAGE_MIN_SPEED);
  const distance =
    distanceToEdge(from, heading, viewport) +
    OFF_PAGE_MARGIN * Math.max(viewport.width, viewport.height);
  return { speed: pace, ms: distance / pace };
}

/** `from` moved `ms` along `heading` at `speed`. */
function along(from: Vec, heading: Vec, speed: number, ms: number): Vec {
  return {
    x: from.x + heading.x * speed * ms,
    y: from.y + heading.y * speed * ms,
  };
}

/** Spacing of the synthetic samples. Under `CURSOR_REST_MS`, so no stage
 *  reads a stretch of them as the hand at rest, and close to the sensor's
 *  own density, so the smoothing kernel weighs them like real ones. */
const STEP_MS = 8;

/** Samples on the straight line from `from` to `to`, `STEP_MS` apart.
 *  Neither end is included; the caller decides which ends are its own. */
function line(
  from: Vec,
  fromMs: number,
  to: Vec,
  toMs: number,
): CursorSample[] {
  const out: CursorSample[] = [];
  const span = toMs - fromMs;
  for (let t = fromMs + STEP_MS; t < toMs; t += STEP_MS) {
    out.push({ sourceTimeMs: t, ...lerpVec(from, to, (t - fromMs) / span) });
  }
  return out;
}

/**
 * The recorded samples with the pointer's trips off the page written in,
 * and the gaps cut down to the time it spent waiting out there.
 *
 * For a gap whose last sighting is at an edge: samples carrying the pointer
 * on out along the heading it left with, at the speed it left at, until it
 * is clear of the frame. If its first sighting after the gap is at an edge
 * too, samples bringing it back in along that line, arriving at the
 * sighting. Between the two, the gap — now opening off the page and closing
 * off it, so `holdAcrossGaps` holds it out of frame and its step from the
 * exit's far point to the entry's is never drawn. (A line between them would
 * cross the page, out through one edge and in through another.) A gap that
 * opens inside the page — an iframe, a popup — is left exactly as it was.
 *
 * A gap too short for both runs cuts them short in proportion rather than
 * speeding them up: a pointer that brushed past the edge for 40ms got 20px
 * out, not as far as the far point and back between two frames. Back
 * through the edge it left by, it turns straight back from where the exit
 * got to, and no gap is left — the pointer was moving the whole time.
 * Back through another edge, the two shortened runs keep a wait between
 * them, so the step from one to the other is never drawn across the corner.
 *
 * A last sighting well before the gap is a hand that rested and then left
 * in one event. Its run starts only as early as it needs to reach the edge
 * by the time the gap opened, and goes out through the nearest edge.
 *
 * A take's first sighting at an edge is the hand arriving from Record, which
 * is off the page, so the take also gets a run in from the edge before it,
 * and loses the gap the sensor reported for that stretch. The run is
 * compressed rather than cut short when the take does not leave room:
 * there is nothing before it to come back from.
 */
export function leaveThroughEdges(
  samples: CursorSample[],
  gaps: CursorGap[],
  viewport: { width: number; height: number },
): { samples: CursorSample[]; gaps: CursorGap[] } {
  if (samples.length === 0) return { samples, gaps };
  const added: CursorSample[] = [];
  const kept: CursorGap[] = [];

  for (const gap of gaps) {
    const out = sightingBeside(samples, gap.startMs, "before");
    // A last sighting well before the gap is a hand that came to rest and
    // then left — and left in one event, or there would be a sighting of
    // it going. The velocity it arrived at the rest with says nothing
    // about which way it went, and the run must not start at the rest.
    const resting =
      out !== null && gap.startMs - out.at.sourceTimeMs > CURSOR_REST_MS;
    const velocity = out === null || resting ? { x: 0, y: 0 } : out.velocity;
    const heading = out ? offPageDirection(out.at, velocity, viewport) : null;
    if (!out || !heading) {
      kept.push(gap);
      continue;
    }
    const from = out.at;
    const exit = glideOut(from, heading, speedOf(velocity), viewport);
    // From the last sighting, not the gap's start, for a moving hand:
    // `pointerout` fires after the last `pointermove`, and the hand was
    // moving in between. From a rest, only as early as the run needs to
    // reach the edge by the instant the gap opened — before that, the hand
    // was still resting, and a sample says so.
    let fromMs = out.at.sourceTimeMs;
    if (resting) {
      fromMs = Math.max(
        fromMs,
        gap.startMs - distanceToEdge(from, heading, viewport) / exit.speed,
      );
      added.push({ sourceTimeMs: fromMs, x: from.x, y: from.y });
    }
    const back = sightingBeside(samples, gap.endMs, "after");
    const inward = back
      ? offPageDirection(back.at, negate(back.velocity), viewport)
      : null;
    const entry =
      back && inward
        ? glideOut(back.at, inward, speedOf(back.velocity), viewport)
        : null;

    if (back && entry && inward) {
      const toMs = back.at.sourceTimeMs;
      // A millisecond is held back so that, cut short, the wait between
      // the runs is still a gap: the stages downstream only refuse to join
      // two samples across one that has some length.
      const share = Math.min(1, (toMs - fromMs - 1) / (exit.ms + entry.ms));
      const exitMs = exit.ms * share;
      const outAt = along(from, heading, exit.speed, exitMs);
      added.push(...line(from, fromMs, outAt, fromMs + exitMs));
      added.push({ sourceTimeMs: fromMs + exitMs, x: outAt.x, y: outAt.y });
      // Turning straight back is only the truth through the edge it left
      // by. Back through another — out the top near a corner, in at the
      // side — the line between the two would cut across the page's
      // corner, and the pointer went round outside it.
      const sameEdge = heading.x * inward.x + heading.y * inward.y > 0.7;
      if (share < 1 && sameEdge) {
        added.push(...line(outAt, fromMs + exitMs, back.at, toMs));
        continue;
      }
      const entryMs = entry.ms * share;
      const inFrom = toMs - entryMs;
      const inAt = along(back.at, inward, entry.speed, entryMs);
      added.push({ sourceTimeMs: inFrom, x: inAt.x, y: inAt.y });
      added.push(...line(inAt, inFrom, back.at, toMs));
      kept.push({ startMs: fromMs + exitMs, endMs: inFrom });
      continue;
    }

    // Out, and either the take ended out there or the pointer reappeared
    // somewhere no edge explains: wait off the page until it is seen. The
    // exit always leaves at least a millisecond of gap, so the wait is a
    // hold and the reappearance a step — never a line drawn from off the
    // page to wherever it reappeared.
    const exitMs = Math.min(exit.ms, Math.max(0, gap.endMs - 1 - fromMs));
    const outAt = along(from, heading, exit.speed, exitMs);
    added.push(...line(from, fromMs, outAt, fromMs + exitMs));
    added.push({ sourceTimeMs: fromMs + exitMs, x: outAt.x, y: outAt.y });
    kept.push({ startMs: fromMs + exitMs, endMs: gap.endMs });
  }

  const first = samples[0] as CursorSample;
  const arrival =
    first.sourceTimeMs > 0
      ? sightingBeside(samples, first.sourceTimeMs, "after")
      : null;
  const inward = arrival
    ? offPageDirection(arrival.at, negate(arrival.velocity), viewport)
    : null;
  if (arrival && inward) {
    const entry = glideOut(first, inward, speedOf(arrival.velocity), viewport);
    const start = along(first, inward, entry.speed, entry.ms);
    const startMs = Math.max(0, first.sourceTimeMs - entry.ms);
    added.push({ sourceTimeMs: startMs, x: start.x, y: start.y });
    added.push(...line(start, startMs, first, first.sourceTimeMs));
  }
  // A take started from the toolbar or the popup carries a gap from before
  // it began to the first sighting: the pointer left the page to press
  // Record. The arrival run is the account of that stretch, so the gap goes.
  // Left in, the run sat inside it — every stage that will not join across
  // a gap left the run unshaped, and once it started at 0 `holdAcrossGaps`
  // deleted it, so the cursor waited off the page and popped in.
  const arrived =
    arrival && inward
      ? kept.filter((gap) => gap.endMs > first.sourceTimeMs)
      : kept;

  if (added.length === 0) return { samples, gaps };
  return {
    samples: [...samples, ...added].sort(
      (a, b) => a.sourceTimeMs - b.sourceTimeMs,
    ),
    gaps: arrived,
  };
}

const speedOf = (v: Vec): number => Math.hypot(v.x, v.y);
const negate = (v: Vec): Vec => ({ x: -v.x, y: -v.y });
