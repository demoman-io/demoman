import type {
  FrameBundle,
  FrameSource,
  Presentation,
  Rect,
  RenderTarget,
} from "@demoman/compositor";
import type {
  SceneBranding,
  SceneCursor,
  SceneDocument,
  SceneMotion,
} from "@demoman/scene-schema";
import { sameBackground } from "./branding.js";

/**
 * The preview bitmap's height DURING PLAYBACK, and the floor everywhere.
 *
 * Tall enough to judge framing, small enough that a scrub stays instant.
 * Measured in the compositor's browser lane on 2026-09-21: `renderFrame`
 * costs 11.8ms/frame at 1280x720 and 40.3ms at 2336x1314 — 3.40x for 3.33x
 * the pixels, so compose cost tracks destination area almost exactly and a
 * display-resolution bitmap would cap compose at ~25fps. That is the wrong
 * trade while the demo is running and the right one the moment it stops,
 * which is why this is no longer the only answer. See `previewHeightFor`.
 */
export const PREVIEW_HEIGHT = 720;

/**
 * What one playback frame may spend on the composite, in milliseconds.
 *
 * A 60Hz frame is 16.7ms and the composite is not all of it: the blit onto
 * the visible canvas, the transport row, the stage overlay and the browser's
 * own compositing all come out of the same budget. 11ms leaves ~5.7ms for
 * them, which is the margin that keeps the scrubber from dropping the
 * request that arrives mid-draw.
 *
 * A budget rather than a resolution, because the resolution that fits it is
 * a property of the machine and this codebase has now measured a 6.6x spread
 * between two of them. See `previewHeightFor`.
 */
export const PLAYBACK_BUDGET_MS = 11;

/**
 * The granularity of the chosen playback height.
 *
 * The cost estimate moves a little with every draw and the height is
 * re-chosen on every play, so without a step two consecutive plays on an
 * unchanged machine could compose at different sizes — a visible change of
 * sharpness with no cause the author can see. 90px is one eighth of
 * `PREVIEW_HEIGHT`: fine enough that the step never wastes much of the
 * budget, coarse enough to sit still under ordinary jitter.
 */
export const PLAYBACK_HEIGHT_STEP = 90;

/**
 * How many recent draws the cost estimate is taken over.
 *
 * Long enough that one stall is a small minority of the window, short
 * enough to follow a machine that genuinely changed — a laptop dropping to
 * its integrated GPU on battery, another window taking the compositor.
 * Thirty draws is about half a second of playback.
 */
export const COST_WINDOW = 30;

/**
 * Where in that window the estimate is read.
 *
 * The budget is a CEILING, so the estimate has to describe the expensive
 * frames rather than the typical one: an average lets a run of cheap draws
 * talk the preview into a resolution its worst frames cannot hold, and a
 * dropped frame is what the author actually sees. p80 sits above the middle
 * of the spread while leaving the worst fifth — the warmup draw, the GC
 * pause — unable to set it on their own.
 */
export const COST_PERCENTILE = 0.8;

/** Fewest draws before the estimate is worth acting on. Below this the
 *  playback height stays on its floor, which is the safe direction: too
 *  small is a soft picture, too large is dropped frames. */
export const COST_MIN_SAMPLES = 4;

/**
 * How many of a play's own draws re-solve its height, once.
 *
 * Four did, and p80 of four is the slowest of them: one stall at the start
 * of a play — a replay from the end, here — held the whole play at the
 * floor. Measured 2026-10-24 on the author's Mac: replays ran at 1280x720
 * against 1440 parked on a machine drawing at 0.2 ms per megapixel. Fifteen
 * draws, a quarter of a second, leaves the worst three unable to choose.
 */
export const PLAY_RESOLVE_SAMPLES = 15;

/**
 * Milliseconds of composite per megapixel, from recent draws.
 *
 * This was a decaying maximum, `max(sample, previous * 0.98)`, and it was
 * wrong in two compounding ways. It was SEEDED BY THE WORST DRAW OF THE
 * SESSION — the first composite pays decoder warmup and opens several times
 * typical, which 2%/draw takes ~35 draws to work off — and ONE STALL
 * RE-PINNED IT. Simulated against a realistic sequence the chosen height sat
 * on its floor for ~30 draws, touched one step above it, and fell back on
 * the next stall. The author saw it as "a bit sharper at times".
 *
 * A percentile over a window keeps the intent and loses both faults: the
 * cold draw ages out, an isolated stall is one sample in thirty, and a
 * machine that really is slower moves the whole window.
 *
 * Null until `COST_MIN_SAMPLES` draws have landed.
 */
export function composeCostEstimate(samples: readonly number[]): number | null {
  if (samples.length < COST_MIN_SAMPLES) return null;
  const window = samples.slice(-COST_WINDOW).sort((a, b) => a - b);
  const index = Math.min(
    window.length - 1,
    Math.max(0, Math.ceil(COST_PERCENTILE * window.length) - 1),
  );
  return window[index] ?? null;
}

/**
 * How tall the preview bitmap should be right now.
 *
 * A fixed `PREVIEW_HEIGHT` meant the preview was always upscaled to whatever
 * the stage painted it at — 1.82x on a DPR-2 laptop, against a source
 * carrying 3.7x more detail than the bitmap kept. Nothing in the preview
 * path read `devicePixelRatio` at all.
 *
 * Raising landscape's padding to 0.15 (2026-09-21) made that plainly
 * visible without moving the ratio one bit: the inset takes its share of a
 * FIXED bitmap, so the app inside it fell from 1184px to 921px and the
 * picture lost a fifth of its resolution while the deliverable gained
 * sharpness. The bitmap has to follow what it is painted into, not a
 * constant.
 *
 * Parked, that is the painted box in DEVICE pixels — one bitmap pixel per
 * screen pixel, nothing resampled on the way to the glass. Playing, it is
 * `PREVIEW_HEIGHT`, because the measurement above makes the full-resolution
 * composite a ~25fps ceiling. Premiere, Resolve and Final Cut all make this
 * same split (playback resolution against full on pause) and it is the one
 * convention an author already expects here.
 *
 * Two bounds, both of which exist because the unbounded answer is wrong:
 *
 * - **Capped at the deliverable's own height.** Past it the extra pixels are
 *   invented, and they are the most expensive pixels in the loop.
 * - **Floored at `PREVIEW_HEIGHT`.** A narrow window must never make the
 *   parked picture worse than the playing one.
 *
 * A width of 0 or NaN — no layout yet, a display:none stage — answers with
 * the floor rather than with 0. Handing `previewTarget` a zero-height bitmap
 * would blank the canvas, which is a measurement that never arrived drawn
 * exactly like a demo with nothing in it.
 *
 * **Playing, the height is SOLVED FOR rather than fixed.** It was a flat
 * `PREVIEW_HEIGHT`, chosen against a browser-lane measurement that put a
 * full-resolution composite at ~25fps — measured in HEADLESS chromium,
 * which rasterises through SwiftShader. The same work on a real GPU runs
 * 6.6x faster (2336x1314: 149.0ms headless, 15.2ms headed), so that
 * constant was throwing away most of the picture on any machine with
 * hardware acceleration and would still have been optimistic on one
 * without. A constant cannot be right across that spread.
 *
 * What makes solving possible is that compose cost is proportional to
 * destination AREA to within a percent — measured 11.8, 11.7, 11.8 and 11.9
 * ms per unit area at four resolutions — so a single `msPerMegapixel`
 * sample, which the preview takes from its own draws, predicts every other
 * size. The largest height whose predicted cost fits `PLAYBACK_BUDGET_MS`
 * wins, snapped to `PLAYBACK_HEIGHT_STEP` and bounded by the same floor and
 * cap as the parked answer.
 *
 * Uncalibrated — nothing composed yet, or every draw so far failed — takes
 * the floor. Guessing high and dropping frames on the author's first play
 * is the worse error, and parked scrubbing calibrates it before a play
 * usually happens anyway.
 */
export function previewHeightFor(args: {
  /** The DELIVERABLE, not a preview target: this reads its cap and aspect. */
  target: RenderTarget;
  /** `#stage-frame`'s painted width, in CSS pixels. */
  paintedCssWidth: number;
  devicePixelRatio: number;
  playing: boolean;
  /**
   * Measured milliseconds of composite per megapixel of bitmap, or null
   * when nothing has been measured yet. A measured ZERO is a machine fast
   * enough to be under the clock's resolution, not an absent measurement —
   * the two answer differently, so they are distinguished here rather than
   * collapsed into a falsy check.
   */
  msPerMegapixel?: number | null;
  budgetMs?: number;
}): number {
  const { target, paintedCssWidth, devicePixelRatio, playing } = args;
  // The floor, under the cap: a deliverable shorter than `PREVIEW_HEIGHT`
  // (GIF, 450) is its own floor. Every answer below — the two fallbacks
  // included — comes off this, because a fallback of a bare 720 composed a
  // GIF's playback at a bitmap larger than the GIF, flipping the height
  // (and the zoom clamp with it) on every play and pause.
  const floor = Math.min(target.height, PREVIEW_HEIGHT);
  if (!Number.isFinite(paintedCssWidth) || paintedCssWidth <= 0) {
    return floor;
  }
  const deviceWidth = paintedCssWidth * devicePixelRatio;
  const wanted = Math.round((deviceWidth * target.height) / target.width);
  const parked = Math.max(floor, Math.min(target.height, wanted));
  if (!playing) return parked;

  const cost = args.msPerMegapixel;
  if (cost == null || !Number.isFinite(cost) || cost < 0) return floor;

  // cost * (aspect * h^2 / 1e6) <= budget, solved for h. `cost === 0` sends
  // this to Infinity, which the clamp below turns into the parked height —
  // the right answer for a machine that measures free.
  const aspect = target.width / target.height;
  const affordable = Math.sqrt(
    (((args.budgetMs ?? PLAYBACK_BUDGET_MS) / cost) * 1e6) / aspect,
  );
  if (affordable >= parked) return parked;
  const stepped =
    Math.floor(affordable / PLAYBACK_HEIGHT_STEP) * PLAYBACK_HEIGHT_STEP;
  return Math.min(parked, Math.max(floor, stepped));
}

/**
 * The preview's own target: the deliverable's shape at a working
 * resolution.
 *
 * `fit` carries over deliberately, and the padding is the branding's, drawn
 * the same way at every size, so the framing the author scrubs is the
 * framing they get. That matters most on the vertical
 * cut, where `cover` supplies ~2.29x of magnification by cropping and a
 * `contain` preview would show a letterbox the deliverable does not have.
 *
 * `heightPx` is `previewHeightFor`'s answer. It defaults to
 * `PREVIEW_HEIGHT`, which is what every caller passed before the preview
 * learned to match the display.
 */
export function previewTarget(
  target: RenderTarget,
  heightPx: number = PREVIEW_HEIGHT,
): RenderTarget {
  const scale = heightPx / target.height;
  return {
    ...target,
    format: "png",
    fps: 0,
    bitrate: 0,
    width: Math.round(target.width * scale),
    height: heightPx,
    cornerRadius: Math.max(4, Math.round(target.cornerRadius * scale)),
  };
}

/**
 * What one stretch of preview playback cost, for the diagnostic below.
 *
 * `requestedFrames` is how many frames playback ASKED for — one per
 * animation frame — and `drawnFrames` is how many the scrubber actually
 * composed. The two differ because `createScrubber` deliberately drops a
 * request that arrives while a draw is in flight, and that gap is the whole
 * reason this exists: the preview's timing is honest (position comes from
 * elapsed wall time) while its smoothness is not, and until now nothing
 * said so out loud.
 */
export interface PreviewFrameStats {
  requestedFrames: number;
  drawnFrames: number;
  elapsedMs: number;
  /**
   * Time spent getting hold of the bundle's `FrameSource`.
   *
   * The memoised lookup, not the decode — `framesFor` builds one source per
   * bundle and hands back the same one after that, so this is ~0 for every
   * frame but the first. It is reported because a first frame that waits
   * seconds on a demux looks exactly like a slow composite from outside.
   *
   * The decode is inside `renderFrame`, where the source is asked for the
   * frame covering the instant, and it arrives as `decodeMs` below. This
   * field claimed to be that decode until 2026-09-12, which put two
   * different quantities under one word in the same line — the headline
   * `fetch` always 0.0ms beside a per-stage `fetch` of 15.1ms. They are
   * named `source` and `decode` now, and this one is printed only when it
   * is non-zero.
   */
  sourceLookupMs: number;
  /** Time inside `renderFrame` — the composition itself. */
  composeMs: number;
  /** Time blitting the offscreen canvas onto the visible one. */
  blitMs: number;
  /**
   * Time inside `renderFrame` spent getting the frame covering the instant:
   * the real decode, summed over the drawn frames.
   *
   * This is `compose.ts`'s `fetch` stage and it is the ONLY one reported.
   * The per-stage breakdown that used to print every `onStage` name was
   * removed on 2026-09-21: the synchronous draw calls are queued, so
   * whichever stage forces the GPU flush is charged for all of them and the
   * rest read 0.0. Measured — removing the cursor entirely changed the frame
   * time by nothing and moved the whole cost to `background`. `fetch` is an
   * `await`, so it is the one stage measured honestly, and on a real machine
   * it was 0.9ms of a 1.1ms composite.
   */
  decodeMs?: number;
  /**
   * The dimensions of the largest still the take can hand the compositor.
   *
   * Named because it is the first thing to suspect when `compose` dominates:
   * outside a motion span the frame source answers with a keyframe, which is
   * DPR-3, and `render/compose.ts` redraws it at
   * `imageSmoothingQuality: "high"` on every frame — a nine-megapixel
   * resample per frame, taken precisely when the page is NOT moving, which
   * is when the cursor is crossing it.
   */
  sourceFrame?: { width: number; height: number };
  /**
   * The bitmap playback actually composed at, and the one parking returns
   * to, and the cost the choice was made from.
   *
   * The playback height is SOLVED (`previewHeightFor`), and until these
   * existed nothing printed the answer — so a working adaptation and a
   * broken one produced the same line, and telling them apart meant
   * simulating the estimator offline. `msPerMegapixel` is null when nothing
   * has been measured yet, which is a different state from "measured, and
   * this machine is slow" and reads identically without being said.
   */
  bitmap?: { width: number; height: number };
  parkedHeight?: number;
  msPerMegapixel?: number | null;
}

/**
 * The resolution clause of the playback line: what it drew at, what it
 * parks at, and the measurement that chose between them.
 *
 * Empty when the caller supplied no bitmap, so the pure summariser stays
 * usable by the tests that only care about frame rates.
 */
function describePreviewPicture(stats: PreviewFrameStats): string {
  const { bitmap, parkedHeight } = stats;
  if (!bitmap) return "";
  const cost =
    stats.msPerMegapixel == null
      ? "cost not measured yet"
      : `${stats.msPerMegapixel.toFixed(1)}ms/megapixel`;
  // `parkedHeight` absent means the caller does not know; say nothing
  // rather than claim the picture is full resolution on no evidence.
  const full = parkedHeight != null && bitmap.height >= parkedHeight;
  const against =
    parkedHeight == null
      ? ""
      : full
        ? " (full resolution)"
        : `, parked ${parkedHeight}`;
  return ` | played ${bitmap.width}x${bitmap.height}${against}, ${cost}`;
}

/**
 * One line naming what playback achieved and where the time went.
 *
 * Pure, so the arithmetic is testable without a browser; the wiring that
 * feeds it lives in `entrypoints/editor/main.ts` and prints it at
 * `console.info` — an expected outcome the code owes a reason for, not a
 * fault, so it stays off the chrome://extensions Errors list.
 *
 * Answers with words rather than with `NaN` when there is nothing to divide
 * by. A diagnostic that prints `NaN fps` has reported nothing while looking
 * like it reported something.
 */
export function summarisePreviewFrames(stats: PreviewFrameStats): string {
  const {
    requestedFrames,
    drawnFrames,
    elapsedMs,
    sourceLookupMs,
    composeMs,
    blitMs,
  } = stats;
  if (drawnFrames <= 0) {
    return `[demoman] preview: no frames drawn in ${Math.round(elapsedMs)}ms, ${requestedFrames} asked for`;
  }
  const seconds = elapsedMs / 1000;
  const rate = (n: number): string =>
    seconds > 0 ? `${(n / seconds).toFixed(1)}` : "n/a";
  const per = (total: number): string => (total / drawnFrames).toFixed(1);
  const kept = ((100 * drawnFrames) / Math.max(1, requestedFrames)).toFixed(0);
  const source = stats.sourceFrame
    ? `, stills ${stats.sourceFrame.width}x${stats.sourceFrame.height}`
    : "";
  const picture = describePreviewPicture(stats);
  const decode =
    stats.decodeMs === undefined ? "" : ` (decode ${per(stats.decodeMs)}ms)`;
  // The memoised source lookup is ~0 after the first frame by design, so it
  // is shown only when it is not — a first frame waiting seconds on a demux
  // looks exactly like a slow composite from outside, and that is the one
  // case this field is for. A field that reads 0.0ms every time is a field
  // nobody reads the one time it does not.
  const lookup =
    sourceLookupMs / drawnFrames >= 0.05
      ? `, source ${per(sourceLookupMs)}ms`
      : "";
  return (
    `[demoman] preview: ${rate(drawnFrames)} fps drawn, ` +
    `${rate(requestedFrames)} asked (${kept}% kept) — per drawn frame: ` +
    `compose ${per(composeMs)}ms${decode}, blit ${per(blitMs)}ms` +
    `${lookup}${source}${picture}`
  );
}

export interface Scrubber {
  seek(outputMs: number): void;
  /** Resolves when nothing is in flight. Test seam; the page ignores it. */
  idle(): Promise<void>;
  dispose(): void;
}

/**
 * One draw in flight, latest wins.
 *
 * The same discipline the compositor's render loop uses, for the same
 * reason: a pointer-move storm must never queue fifty composites. Requests
 * that arrive mid-draw collapse to the most recent one, because the author
 * is asking to see where the pointer *is*, not everywhere it has been.
 */
export function createScrubber(args: {
  draw: (outputMs: number) => Promise<void>;
  schedule: (fn: () => void) => void;
  /** Where a swallowed draw goes to speak. The control flow is forgiven --
   *  see the catch below -- but the reason must not be, or a canvas frozen
   *  under a running clock reads exactly like a demo that holds still. */
  onDrawFailed?: (error: unknown) => void;
  /** A draw that completed. The other half of `onDrawFailed`: without it a
   *  page can only ever learn that the preview broke, never that it came
   *  back, and the failure it drew outlives what it describes. */
  onDrawRecovered?: () => void;
}): Scrubber {
  const { draw, schedule, onDrawFailed, onDrawRecovered } = args;
  let pending: number | null = null;
  let running = false;
  let disposed = false;
  let settled: Promise<void> = Promise.resolve();

  const pump = (): void => {
    if (disposed || running || pending === null) return;
    const next = pending;
    pending = null;
    running = true;
    settled = draw(next)
      .then(() => {
        onDrawRecovered?.();
      })
      // A missing frame is a normal state mid-regeneration, not a reason to
      // wedge every later scrub -- but it is always a reason to say so.
      .catch((error: unknown) => {
        onDrawFailed?.(error);
      })
      .then(() => {
        running = false;
        if (pending !== null) schedule(pump);
      });
  };

  return {
    seek(outputMs: number): void {
      if (disposed) return;
      pending = outputMs;
      schedule(pump);
    },
    async idle(): Promise<void> {
      while (running || pending !== null) await settled;
    },
    dispose(): void {
      disposed = true;
      pending = null;
    },
  };
}

export interface Player {
  play(): void;
  pause(): void;
  toggle(): void;
  /** J and L. Starts playback in `direction`, or doubles the rate when it is
   *  already going that way, up to `SHUTTLE_MAX_RATE`. */
  shuttle(direction: -1 | 1): void;
  /** K. Halts playback and drops any shuttle rate. Unlike `pause`, safe to
   *  call when already stopped — that is what makes it a separate key. */
  stop(): void;
  /** Move the playhead, from the scrub bar or a beat click. Draws it, and
   *  keeps playing from there if it was playing. */
  seek(outputMs: number): void;
  readonly playing: boolean;
  /** Signed playback speed: 1 while playing normally, negative in reverse.
   *  The transport reads it to say what the take is doing. */
  readonly rate: number;
  readonly positionMs: number;
  dispose(): void;
}

/**
 * The transport clock over a `Scrubber`.
 *
 * Position is derived from elapsed wall time — `anchor + (now - anchorWall)`
 * — never accumulated per tick. That is the whole reason this preview can be
 * trusted: composites here cost tens of milliseconds and the scrubber
 * deliberately drops requests that arrive mid-draw, so a frame-counting
 * clock would play a 12s demo over 30s and every beat would land somewhere
 * the deliverable does not put it. Dropping frames is the correct loss; the
 * timing you watch has to be the timing you ship.
 *
 * Duration is read per tick rather than captured, so a regeneration that
 * lands a longer take does not leave playback stopping at the old end.
 */
/**
 * The fastest shuttle. Four is where every NLE's second tap tops out, and it
 * is as far as this preview can usefully go: past it a 12s take crosses the
 * screen in under three seconds and the composites the scrubber drops stop
 * adding up to anything an author can read.
 */
export const SHUTTLE_MAX_RATE = 4;

export function createPlayer(args: {
  /** Put the playhead here — `Scrubber.seek` in the page. */
  seek: (outputMs: number) => void;
  durationMs: () => number;
  /** Where playback begins and the earliest seek: the trim's head. Default 0. */
  startMs?: () => number;
  /**
   * Whether reaching an end wraps to the other one instead of stopping.
   *
   * A getter read per tick, the same shape `durationMs` and `startMs` take,
   * rather than a flag this player holds: the repeat button's state belongs
   * to the page that draws the button, and a second copy here could come to
   * disagree with the one the author can see. Default off.
   */
  looping?: () => boolean;
  now: () => number;
  schedule: (fn: () => void) => void;
  /** Playing or position changed; the page redraws the transport row. */
  onChange?: () => void;
}): Player {
  const { seek, durationMs, now, schedule, onChange } = args;
  const start = args.startMs ?? (() => 0);
  const looping = args.looping ?? (() => false);
  let position = 0;
  let playing = false;
  let disposed = false;
  /** Where the playhead was when the current run started, and when that was.
   *  Reset by play and by a mid-playback scrub, never by a tick. */
  let anchorMs = 0;
  let anchorWall = 0;
  /** Playback speed, signed: 1 is ordinary forward play, -4 is the fastest
   *  reverse shuttle. Reset to 1 by anything that stops playback, so the
   *  transport never resumes at a speed the author set several actions ago. */
  let rate = 1;

  const changed = (): void => onChange?.();

  const show = (outputMs: number): void => {
    position = outputMs;
    seek(outputMs);
  };

  /**
   * Carry on from the far end of the take, keeping the rate.
   *
   * The overshoot past the end is dropped rather than carried into the next
   * pass: at 60fps it is under a frame, and the alternative — a remainder
   * folded into the new anchor — buys sub-frame accuracy at the cost of the
   * one property this clock is built on, that position is derived from the
   * wall clock and never accumulated.
   */
  const wrapTo = (outputMs: number): void => {
    position = outputMs;
    anchor();
    show(outputMs);
    changed();
    schedule(tick);
  };

  /** Whether a wrap would actually get anywhere. A take trimmed to nothing
   *  has its head and its tail at the same instant, and wrapping to a range
   *  with no length would re-enter this on every frame forever without the
   *  playhead ever moving — so a degenerate range stops, the same as it does
   *  with repeat off, rather than spinning in silence. */
  const canWrap = (duration: number): boolean =>
    looping() && duration > start();

  const tick = (): void => {
    if (disposed || !playing) return;
    const duration = durationMs();
    const next = anchorMs + (now() - anchorWall) * rate;
    if (next >= duration) {
      if (canWrap(duration)) {
        wrapTo(start());
        return;
      }
      playing = false;
      rate = 1;
      show(duration);
      changed();
      return;
    }
    // The reverse end. A shuttle running backwards stops at the trim's head
    // the same way a forward one stops at the tail — and drops its rate, so
    // the Play button that comes back is the ordinary one rather than a 4x
    // reverse waiting to be resumed.
    //
    // Gated on the direction, not only on the position. `play()` puts the
    // playhead ON `start()` whenever it was before the head or past the
    // tail, so a forward tick with no elapsed time lands exactly there —
    // and an ungated `<=` ended the take before it began, reporting it
    // through the same path a finished one uses.
    if (rate < 0 && next <= start()) {
      // Symmetric with the forward end: a reverse shuttle under repeat wraps
      // to the tail and keeps running backwards. Stopping one direction and
      // wrapping the other would make the button mean two different things
      // depending on which way the take happened to be going.
      if (canWrap(duration)) {
        wrapTo(duration);
        return;
      }
      playing = false;
      rate = 1;
      show(start());
      changed();
      return;
    }
    show(next);
    changed();
    schedule(tick);
  };

  /** Re-anchor the wall-clock derivation on the current position. Every
   *  entry point that starts, reverses or re-rates playback goes through
   *  here, or the next tick would compute from the previous run's anchor. */
  const anchor = (): void => {
    anchorMs = position;
    anchorWall = now();
  };

  return {
    play(): void {
      if (disposed || playing) return;
      const duration = durationMs();
      // No frames, nothing to play. Starting anyway would run the clock over
      // an empty canvas and show a Pause button for a demo that is not
      // playing — a transport that reports the state it is not in.
      if (duration <= 0) return;
      // Play at the end is play again, the one thing the button can mean
      // there — "the end" now measured against the trim's own range, so a
      // trimmed-out position (before the head, or wherever the last stop
      // landed at the tail) restarts from the head rather than from 0.
      if (position >= duration || position < start()) position = start();
      rate = 1;
      anchor();
      playing = true;
      show(position);
      changed();
      schedule(tick);
    },
    pause(): void {
      if (disposed || !playing) return;
      playing = false;
      rate = 1;
      changed();
    },
    /**
     * J and L: start shuttling in `direction`, or go faster if already
     * shuttling that way.
     *
     * Tapping the opposite key means "now go the other way" at ordinary
     * speed, not "go the other way four times as fast" — a pair of keys
     * whose rate carried across a reversal would be impossible to aim.
     */
    shuttle(direction: -1 | 1): void {
      if (disposed) return;
      const duration = durationMs();
      // Same refusal as `play`: a rate over an empty canvas would show a
      // shuttling transport for a take that has no frames to shuttle.
      if (duration <= 0) return;
      const sameWay = playing && Math.sign(rate) === direction;
      rate = sameWay
        ? direction * Math.min(SHUTTLE_MAX_RATE, Math.abs(rate) * 2)
        : direction;
      // Starting from an end that the new direction would immediately run
      // off: wrap to the far end, the way `play` restarts from the head.
      if (direction > 0 && position >= duration) position = start();
      if (direction < 0 && position <= start()) position = duration;
      anchor();
      playing = true;
      show(position);
      changed();
      schedule(tick);
    },
    /** K. Distinct from `toggle` because K after K must stay stopped. */
    stop(): void {
      if (disposed) return;
      rate = 1;
      if (!playing) return;
      playing = false;
      changed();
    },
    toggle(): void {
      if (playing) this.pause();
      else this.play();
    },
    seek(outputMs: number): void {
      if (disposed) return;
      const clamped = Math.min(Math.max(outputMs, start()), durationMs());
      // Re-anchor, or the next tick would compute the position from the time
      // the run started and yank the playhead back to where it was dragged
      // from. A shuttle keeps its rate across a scrub: the author moved the
      // playhead, not the speed.
      position = clamped;
      anchor();
      show(clamped);
      changed();
    },
    get playing(): boolean {
      return playing;
    },
    get rate(): number {
      return rate;
    },
    get positionMs(): number {
      return position;
    },
    dispose(): void {
      disposed = true;
      playing = false;
    },
  };
}

/**
 * `m:ss` for the transport readout. Floored, because a readout that rounds up
 * shows the duration a frame before the demo has actually ended.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Memoises the decoded frame source for the bundle currently on screen.
 *
 * `createVideoFrameSource` loads every motion span out of the store and
 * stands up an H.264 decoder for each. Paying that per draw was survivable
 * while the only caller was a drag; under playback it is a per-frame cost no
 * composite budget absorbs, and the preview falls behind the wall clock and
 * drops nearly every frame it was asked for.
 *
 * A failed build is deliberately NOT cached. Caching the rejection would let
 * one transient read failure fail every later draw against frames that are
 * on disk and fine — and it would keep doing so until the scene got new
 * frames. The error still propagates on the call that hit it, so the
 * caller reports the reason rather than a source that quietly serves
 * nothing.
 */
export function createFrameSourceCache(
  build: (bundle: FrameBundle) => Promise<FrameSource>,
): (bundle: FrameBundle) => Promise<FrameSource> {
  let cached: Promise<FrameSource> | null = null;
  let cachedFor: FrameBundle | null = null;

  return (bundle: FrameBundle): Promise<FrameSource> => {
    if (cached === null || bundle !== cachedFor) {
      cachedFor = bundle;
      cached = build(bundle).catch((error: unknown) => {
        cached = null;
        cachedFor = null;
        throw error;
      });
    }
    return cached;
  };
}

/**
 * The document the preview composes: the stored one with the author's
 * in-flight drags layered over it — the cursor's, the backdrop's and the
 * camera's. Never the session's: a drag is not an edit and must not reach
 * the undo stack.
 *
 * The stored object itself when nothing is layered, so anything keyed on
 * scene identity still sees the same object. `motion` is `undefined` when
 * no camera drag is under way and the document has no block, and then no
 * key is written: an absent block and one holding the defaults read the
 * same downstream, but a present-and-undefined key is neither.
 *
 * This is the one place the camera preview reaches `resolvePlan`, so a
 * smoothness or follow drag re-solves the camera keys on every coalesced
 * frame rather than only blurring the frames it already had.
 */
export function previewScene(
  stored: SceneDocument,
  live: {
    cursor: SceneCursor;
    branding: SceneBranding;
    motion: SceneMotion | undefined;
  },
): SceneDocument {
  const { cursor, branding, motion } = live;
  if (
    cursor === stored.cursor &&
    branding === stored.branding &&
    motion === stored.motion
  )
    return stored;
  return {
    ...stored,
    cursor,
    branding,
    ...(motion === undefined ? {} : { motion }),
  };
}

/**
 * Whether the canvas has to be recomposed because the cursor's look moved.
 *
 * `main.ts`'s render tail re-seeks the player only when the BUNDLE changes,
 * which was the whole story while every edit either changed the frames or
 * changed something the timeline redrew on its own. The Cursor panel's five
 * controls change neither: the same bundle composes differently. Without
 * this the canvas held its last frame while every control reported success
 * — a failure path drawn exactly like a working one.
 *
 * Compared field by field rather than by identity, because `render()` runs
 * on every edit, every session emit and every render-progress message, and
 * a fresh object each time would re-seek on all of them.
 */
export function cursorRedrawNeeded(
  drawn: SceneCursor | null,
  live: SceneCursor,
): boolean {
  if (drawn === null) return true;
  // Both sides' keys, not `live`'s alone: `tilt` and `clickBounce` are
  // optional, so an undo past their first edit hands back a block WITHOUT
  // the key the canvas was drawn with. Walking `live`'s keys never visited
  // it, and the canvas kept the undone lean while the panel showed the
  // default.
  const keys = new Set([...Object.keys(live), ...Object.keys(drawn)]);
  return ([...keys] as (keyof SceneCursor)[]).some(
    (key) => live[key] !== drawn[key],
  );
}

/**
 * Whether the canvas has to be recomposed because the camera's motion moved.
 *
 * The same hole `cursorRedrawNeeded` closed, for the Camera rows: a new
 * smoothness or follow re-solves the camera keys (`refreshDerived` composes
 * from the live document every time, so `resolved` is already new), but
 * neither the bundle nor the cursor nor the backdrop changed, so the render
 * tail would not re-seek and the parked frame kept the old camera — an undo
 * that moved the slider back and left the picture where it was.
 *
 * Takes the block already resolved against `MOTION_DEFAULTS`, so a document
 * whose `motion` was absent and one holding the defaults compare equal.
 */
export function motionRedrawNeeded(
  drawn: SceneMotion | null,
  live: SceneMotion,
): boolean {
  if (drawn === null) return true;
  return (
    drawn.smoothness !== live.smoothness ||
    drawn.blur !== live.blur ||
    drawn.follow !== live.follow
  );
}

/**
 * Whether the canvas has to be recomposed because the backdrop moved.
 *
 * The same hole `cursorRedrawNeeded` closed, from the Background panel: a
 * new primary colour or logo changes neither the bundle nor the cursor, so
 * the render tail recomposed `presentation` and never drew it. The parked
 * frame kept its old backdrop until the playhead moved, while the swatch
 * showed the new colour — a picker that looked like it did nothing.
 *
 * Compared on what `renderFrame` actually paints rather than on the scene's
 * branding, so a change that derives the same picture (say, two hexes that
 * round to one gradient) costs no redraw, and anything else that reaches the
 * backdrop — a corner radius, the frame rect — re-arms it too. The logo is
 * compared by image identity (`refreshLogo` decodes a new image per ref and
 * raster height) plus its opacity and placed rect: `derivePresentation`
 * builds a fresh placed-logo object on every call, so the object itself
 * cannot be compared.
 */
export function presentationRedrawNeeded(
  drawn: Presentation | null,
  live: Presentation,
): boolean {
  if (drawn === null) return true;
  const sameRect = (a: Rect | undefined, b: Rect | undefined): boolean =>
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height);
  const bgA = drawn.background;
  const bgB = live.background;
  return (
    !sameBackground(bgA, bgB) ||
    drawn.cornerRadius !== live.cornerRadius ||
    !sameRect(drawn.frameRect, live.frameRect) ||
    drawn.logo?.image !== live.logo?.image ||
    drawn.logo?.opacity !== live.logo?.opacity ||
    !sameRect(drawn.logo?.rect, live.logo?.rect)
  );
}
