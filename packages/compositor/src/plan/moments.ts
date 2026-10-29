import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle } from "../bundle.js";
import { RELEASE_MS } from "../render/cursor-pose.js";
import { PRESS_DURATION_MS, PULSE_DURATION_MS } from "../render/draw-cursor.js";
import { FOLLOW_STEP_MS, sampleTrack } from "./camera-follow.js";
import {
  CURSOR_IDLE_FADE_MS,
  CURSOR_IDLE_HIDE_MS,
  cursorMotionSpans,
  type ResolvedPlan,
} from "./resolve.js";
import { type TimeSpan, toOutputMs } from "./timeline.js";

/** One screen the video stops on (spec 2026-10-27, "Refresh compares
 *  recorded moments"). */
export interface ScreenMoment {
  /** Index into scene.actions of the step this screen comes before;
   *  null for the final screen. */
  step: number | null;
  /** Output milliseconds on the rendered video's own clock. */
  ms: number;
  /** The app's window at `ms`, in the render's output pixels, with its
   *  corners' radius: drawn by the same camera the frame is (`renderScene`
   *  fills it), so refresh compares the window's pixels and nothing round
   *  it. Absent from `screenMoments`' own answer. */
  window?: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  };
}

/** The shortest still stretch a moment may sit in: a frame either side of
 *  its midpoint at 30 fps shows the same picture. */
export const MIN_SCREEN_MS = 100;

/** Camera travel per follow step below which it reads as still: the follow
 *  spring's tail closes on the pointer and never quite arrives. */
const CAMERA_STILL_PX = 0.05;
const CAMERA_STILL_SCALE = 1e-4;

/** How long the drawn pointer goes on changing after its samples stop: the
 *  lean averages 160 ms of past travel and the trail 32 ms
 *  (`cursor-pose.ts`, `draw-cursor.ts`). */
const CURSOR_SETTLE_MS = 200;

/** Spans to disjoint, sorted runs. Touching spans are one run. */
function merge(spans: TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = [];
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Where, on the output axis, anything drawn is changing: the page, the
 *  pointer and its press, pulse and fade, and the camera. */
export function busySpans(resolved: ResolvedPlan): {
  busy: TimeSpan[];
  cursor: TimeSpan[];
  camera: TimeSpan[];
} {
  const { timeline } = resolved;
  const cursor = merge(
    cursorMotionSpans(resolved.cursor).map((s) => ({
      startMs: toOutputMs(timeline, s.startMs),
      endMs: toOutputMs(timeline, s.endMs) + CURSOR_SETTLE_MS,
    })),
  );
  const page = timeline.segments
    .filter((s) => s.kind === "motion")
    .map((s) => ({ startMs: s.outStartMs, endMs: s.outEndMs }));
  const presses = [
    ...resolved.clickOutputMs.map((ms) => ({ startMs: ms, endMs: ms })),
    ...resolved.taps.map((tap) => ({
      startMs: tap.outputMs,
      endMs: tap.outputMs,
    })),
    ...resolved.holdOutputMs,
  ].map((h) => ({
    startMs: h.startMs - PRESS_DURATION_MS,
    endMs: h.endMs + Math.max(PULSE_DURATION_MS, RELEASE_MS),
  }));
  const fades = resolved.cursorLook.hideWhenIdle
    ? resolved.cursorRestOutputMs.flatMap((rest) => [
        {
          startMs: rest.startMs + CURSOR_IDLE_HIDE_MS,
          endMs: rest.startMs + CURSOR_IDLE_HIDE_MS + CURSOR_IDLE_FADE_MS,
        },
        { startMs: rest.endMs, endMs: rest.endMs + CURSOR_IDLE_FADE_MS },
      ])
    : [];
  // Sampled rather than read off the keys: while zoomed the centre is the
  // follow spring's (`sampleTrack`), which moves whenever the pointer did.
  const camera: TimeSpan[] = [];
  let before = sampleTrack(resolved, 0);
  for (let t = 0; t < timeline.outputDurationMs; t += FOLLOW_STEP_MS) {
    const next = Math.min(t + FOLLOW_STEP_MS, timeline.outputDurationMs);
    const at = sampleTrack(resolved, next);
    if (
      Math.hypot(at.center.x - before.center.x, at.center.y - before.center.y) >
        CAMERA_STILL_PX ||
      Math.abs(at.scale - before.scale) > CAMERA_STILL_SCALE
    ) {
      camera.push({ startMs: t, endMs: next });
    }
    before = at;
  }
  return {
    busy: merge([...cursor, ...page, ...presses, ...fades, ...camera]),
    cursor,
    camera: merge(camera),
  };
}

/**
 * The midpoint of the still stretch that runs up to `toMs` (clipped at
 * `fromMs`), when it is at least `MIN_SCREEN_MS` long; else null.
 *
 * Only that one stretch, never an earlier one: falling back to an earlier
 * still stretch when the latest is short would let a jitter across
 * `MIN_SCREEN_MS` swap which picture is the screen (a result that settles
 * 95 ms before the glide in one film and 105 ms in the other), and refresh
 * would read an unchanged app as changed. Taking only this one, a jitter can
 * remove the screen and never move it to another picture.
 */
function stillUpTo(
  busy: TimeSpan[],
  fromMs: number,
  toMs: number,
): number | null {
  let start = fromMs;
  for (const span of busy) {
    if (span.startMs < toMs) start = Math.max(start, span.endMs);
  }
  return toMs - start >= MIN_SCREEN_MS ? (start + toMs) / 2 : null;
}

/** What a render records about the screens it stops on. */
export interface Screens {
  /** How many steps the film has (scene.actions.length). */
  steps: number;
  /** Only the still screens, in increasing ms. */
  moments: ScreenMoment[];
  /** A digest of the branding painted round the window (its background,
   *  padding and logo), for refresh to judge the background by. Set by
   *  run-core's `renderOutput`, which owns the digest (`lookDigest`). */
  look?: string;
}

/**
 * The screens the video stops on: the one just before each step begins, and
 * the final one (spec 2026-10-27, decision 2 and its amendment). Decided
 * here, once, from the composition the render walks, and recorded; refresh
 * reads the record rather than finding rest in the pixels again.
 *
 * A stretch is still when nothing drawn is changing (`busySpans`). Step
 * `i`'s moment is the midpoint of the still stretch that ends at the first
 * instant anything moves toward step `i` (its approach), clipped at step
 * `i-1`'s marker (0 for the first), when it is at least `MIN_SCREEN_MS`
 * long. The approach is the drawn camera setting off for a zoom on it, the
 * last run of pointer and camera travel before it (its glide), or whatever
 * is already moving when its marker lands (a scroll, the press). Without
 * that bound the dwell after the glide, zoomed in on the target, would be
 * "the screen before". The final screen is the still stretch that runs to
 * the video's end. An earlier stretch never stands in for either: see
 * `stillUpTo`, which is why a jitter can cost a screen but never change it.
 *
 * A step with no such stretch, or whose marker the bundle lacks, has no
 * moment, and neither has one the trim cut off: about half the steps of a
 * real-time take never settle (task-1 report, 2026-10-27). `steps` beside
 * the moments is what lets a reader say "k of n screens".
 */
export function screenMoments(
  resolved: ResolvedPlan,
  scene: SceneDocument,
  bundle: Pick<FrameBundle, "markers">,
): Screens {
  const { timeline, range } = resolved;
  const { busy, cursor, camera } = busySpans(resolved);
  // The pointer and the camera moving toward a step, as one run: while
  // zoomed the camera trails the pointer, so its pan sets off with the glide
  // and not at its key's departure.
  const approaches = merge([...cursor, ...camera]);
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  const stepOfIntent = new Map(
    resolved.plan.cameraIntents.map((c) => [c.id, c.actionId]),
  );
  const moments: ScreenMoment[] = [];
  const place = (step: number | null, at: number | null) => {
    if (at !== null && at >= range.startMs && at <= range.endMs) {
      moments.push({ step, ms: at - range.startMs });
    }
  };

  let fromMs = 0;
  for (const [i, action] of scene.actions.entries()) {
    const sourceMs = markerAt.get(action.id);
    if (sourceMs === undefined) continue;
    const atMs = toOutputMs(timeline, sourceMs);
    // A zoom on this step: where the drawn camera set off toward it.
    const zoom = resolved.cameraSegments
      .filter((seg) => stepOfIntent.get(seg.id) === action.id)
      .flatMap((seg) =>
        camera
          .filter((c) => c.startMs < seg.startMs && c.endMs > seg.departMs)
          .map((c) => c.startMs),
      );
    const run = approaches.filter(
      (s) => s.startMs > fromMs && s.startMs <= atMs,
    );
    const moving = busy.find((s) => s.startMs <= atMs && atMs <= s.endMs);
    const approachMs = Math.min(
      atMs,
      ...zoom,
      ...(run.length > 0 ? [(run[run.length - 1] as TimeSpan).startMs] : []),
      ...(moving ? [moving.startMs] : []),
    );
    place(i, stillUpTo(busy, fromMs, approachMs));
    fromMs = atMs;
  }
  place(null, stillUpTo(busy, fromMs, timeline.outputDurationMs));
  return { steps: scene.actions.length, moments };
}
