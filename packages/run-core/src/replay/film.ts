import {
  type CameraTrack,
  contentScale,
  derivePresentation,
  type FrameBundle,
  frameTrack,
  inScreenSpace,
  LANDSCAPE_1080P,
  landscapeFrame,
  outputRectToCss,
  planScene,
  type Rect,
  type RenderTarget,
  resolvePlan,
  toOutputMs,
  VERBS,
  type Vec,
} from "@demoman/compositor";
import {
  dragPoints,
  type SceneAction,
  type SceneBranding,
  type SceneDocument,
  type ScriptStep,
} from "@demoman/scene-schema";
import { pointRect } from "../drag-points.js";

export type Framing = "inside" | "atEdge" | "cutOff" | "outOfFrame";
export type FilmLabel = Framing | "strayArrival" | "detour" | "longStill";
export type StepUnknown = "notInVideo" | "cut" | "noRect";
export type FilmUnavailable =
  | "refused"
  | "noTake"
  | "noFrames"
  /** The check itself threw. The run is unaffected; `error` says what. */
  | "checkFailed";
export interface FilmStep {
  actionId: string;
  kind: SceneAction["kind"];
  outputMs: number | null;
  unknown: StepUnknown | null;
  framing: {
    label: Framing;
    rect: Rect;
    visible: Rect;
    /** A drag's end, framed on its own; `label` is the worse of the two. */
    end?: { label: Framing; rect: Rect };
  } | null;
  gapMs: number | null;
  stillMs: number | null;
  /** The `pause` the script put right before this step, in ms — null when
   *  it put none, and always on a re-shoot, which has no script. `stillMs`
   *  stays what the film measured; this is what was asked for inside it. */
  pausedMs: number | null;
  /** Time the replay waited before this step so the camera could move
   *  unhurried (the marker's `roomMs`, spec 2026-10-19): Demoman's pacing,
   *  not a stall. Null when it waited nothing. */
  roomMs: number | null;
  /** `stillMs` past `LONG_STILL_MS` once the script's own pause is taken off
   *  it: a pause long enough to read by is what the script asked for, not a
   *  fault in the film. */
  longStill: boolean;
}
export interface Journey {
  fromOutputMs: number;
  toOutputMs: number;
  from: Vec;
  to: Vec;
  travelledPx: number;
  detourPx: number;
  detour: boolean;
  arrival:
    | { onTarget: true; actionId: string }
    | { onTarget: false; beforeActionId: string | null };
}
export type FilmReport =
  | { unavailable: FilmUnavailable; error?: string }
  | {
      summary: Record<FilmLabel, number>;
      steps: FilmStep[];
      journeys: Journey[];
      noCursor: boolean;
    };

/** A target nearer an edge than this is `atEdge`: the cursor arrow and a
 *  hover ring need room, and 24 CSS px is about one arrow. Tuned by plan 2's
 *  lane; a change here needs a lane test that justifies it. */
export const EDGE_MARGIN_PX = 24;

/**
 * Every label at zero — the summary's starting point. A `Record`, not a
 * hand-kept list: a label added to `FilmLabel` and left out here fails to
 * compile, where a list left it out of the summary and the first `++` on it
 * produced `NaN` (the `RECOVERABLE` lesson the spec cites).
 */
const ZERO_SUMMARY: Record<FilmLabel, 0> = {
  inside: 0,
  atEdge: 0,
  cutOff: 0,
  outOfFrame: 0,
  strayArrival: 0,
  detour: 0,
  longStill: 0,
};

/**
 * The camera's window onto the page at an output time, in the page's CSS
 * pixels — the space `anchorRects` are in. The camera zooms the whole
 * composition, so what is in shot is the output canvas mapped back onto the
 * page through the camera `renderFrame` uses, cut to the viewport: past it
 * is margin, not page. That needs a target, and this measures the demo's own
 * landscape frame — Auto's, or 16:9's: every landscape preset shares its
 * aspect, and the padding is the take's own, so the window in CSS is the
 * same at any of their resolutions.
 * A `cover` export target crops differently, which this does not model
 * (spec §2 measures the film, not a particular export).
 *
 * `shot` is the same window before that cut, which can reach past the page
 * into the window frame and padding around it.
 */
function visibleRegion(
  track: CameraTrack,
  outputMs: number,
  viewport: { width: number; height: number },
  branding: SceneBranding,
  target: RenderTarget,
): { visible: Rect; shot: Rect } {
  const { frameRect } = derivePresentation(branding, target, viewport);
  const camera = frameTrack(
    track,
    outputMs,
    contentScale(frameRect, viewport),
    frameRect,
    viewport,
    target,
  );
  const shot = outputRectToCss(
    { x: 0, y: 0, width: target.width, height: target.height },
    camera,
    frameRect,
    viewport,
  );
  const x = Math.max(shot.x, 0);
  const y = Math.max(shot.y, 0);
  return {
    visible: {
      x,
      y,
      width: Math.min(shot.x + shot.width, viewport.width) - x,
      height: Math.min(shot.y + shot.height, viewport.height) - y,
    },
    shot,
  };
}

/**
 * Cut off and out of frame against the page in shot; the room `atEdge` asks
 * for against the shot itself. A target near the page's edge, with the window
 * frame and padding in shot beyond it, has its room: Excalidraw's toolbar,
 * 20px from the page's top, read `atEdge` on every click (2026-10-21), and
 * the `scrollTo` the label prescribes cannot move it.
 */
const BADNESS: Record<Framing, number> = {
  inside: 0,
  atEdge: 1,
  cutOff: 2,
  outOfFrame: 3,
};
const worse = (a: Framing, b: Framing): Framing =>
  BADNESS[b] > BADNESS[a] ? b : a;

function framingOf(target: Rect, visible: Rect, shot: Rect): Framing {
  const left = target.x - visible.x;
  const top = target.y - visible.y;
  const right = visible.x + visible.width - (target.x + target.width);
  const bottom = visible.y + visible.height - (target.y + target.height);
  const overlaps =
    target.x < visible.x + visible.width &&
    target.x + target.width > visible.x &&
    target.y < visible.y + visible.height &&
    target.y + target.height > visible.y;
  if (!overlaps) return "outOfFrame";
  if (left < 0 || top < 0 || right < 0 || bottom < 0) return "cutOff";
  return Math.min(
    target.x - shot.x,
    target.y - shot.y,
    shot.x + shot.width - (target.x + target.width),
    shot.y + shot.height - (target.y + target.height),
  ) < EDGE_MARGIN_PX
    ? "atEdge"
    : "inside";
}

/** A journey ends when the cursor stays within 1px for this long (video time). */
export const STILL_MS = 100;
/** A "journey" travelling less than this in total is jitter, not a move.
 *  Distance TRAVELLED (spec §2.2, amended): a loop ends where it began. */
export const MIN_JOURNEY_PX = 4;
/** An arrival this close to a target's rect counts as on it. */
export const ARRIVAL_SLACK_PX = 4;
/** A detour is a sample farther than max(these) from the journey's chord.
 *  The planner bows 8% (`CURSOR_DEFAULTS.bowFraction`), so 15% passes it. */
export const DETOUR_MIN_PX = 24;
export const DETOUR_FRACTION = 0.15;

interface TimedPoint {
  t: number;
  x: number;
  y: number;
}

/** A stretch of video longer than this with nothing moving is `longStill`. */
export const LONG_STILL_MS = 1500;

/** The longest part of [from, to] that no interval in `busy` covers. */
function longestGap(
  from: number,
  to: number,
  busy: [number, number][],
): number {
  const clipped = busy
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let longest = 0;
  let cursor = from;
  for (const [a, b] of clipped) {
    if (a > cursor) longest = Math.max(longest, a - cursor);
    cursor = Math.max(cursor, b);
  }
  return Math.max(longest, to - cursor);
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from `p` to the segment a→b (to `a` itself when a === b). */
function offChord(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
  );
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Maximal runs of movement, split wherever the cursor holds still for STILL_MS. */
function splitJourneys(points: TimedPoint[]): TimedPoint[][] {
  const runs: TimedPoint[][] = [];
  let current: TimedPoint[] = [];
  let lastMoveT = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1] as TimedPoint;
    const here = points[i] as TimedPoint;
    if (dist(prev, here) >= 1) {
      if (current.length === 0) current.push(prev);
      current.push(here);
      lastMoveT = here.t;
    } else if (current.length > 0 && here.t - lastMoveT >= STILL_MS) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
});
const contains = (r: Rect, p: Vec) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

export function filmQuality(
  givenScene: SceneDocument,
  givenBundle: FrameBundle,
  paused: ReadonlyMap<string, number> = new Map(),
): FilmReport {
  // The film is the screen, so its rects are read as the screen showed them
  // (`inScreenSpace`); `resolvePlan` below then has nothing left to convert.
  const { bundle, scene } = inScreenSpace(givenBundle, givenScene);
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const out = (sourceMs: number) => toOutputMs(resolved.timeline, sourceMs);
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  const rectAt = new Map(bundle.anchorRects.map((a) => [a.actionId, a.rect]));
  const endAt = new Map(
    bundle.anchorRects.flatMap((a) =>
      a.end === undefined ? [] : [[a.actionId, a.end] as const],
    ),
  );
  const heldAt = new Map(
    bundle.markers.flatMap((m) =>
      m.roomHeldMs === undefined ? [] : [[m.actionId, m.roomHeldMs] as const],
    ),
  );
  const roomAt = new Map(
    bundle.markers.flatMap((m) =>
      m.roomMs === undefined ? [] : [[m.actionId, m.roomMs] as const],
    ),
  );
  // The resolved plan's: a removed piece that removed none of these frames
  // takes no step out of the film (review 2026-10-22).
  const cut = new Set(resolved.plan.removedSteps);
  // The demo's own landscape frame: Auto's computed one, else 16:9's. A
  // 9:16 demo is measured landscape too, as the docblock above says.
  const frame = landscapeFrame(
    scene.canvas.aspect,
    LANDSCAPE_1080P,
    bundle.viewport,
    scene.branding.padding,
  );

  const steps: FilmStep[] = scene.actions.map((action): FilmStep => {
    const blank = {
      actionId: action.id,
      kind: action.kind,
      gapMs: null,
      stillMs: null,
      pausedMs: paused.get(action.id) ?? null,
      roomMs: roomAt.get(action.id) ?? null,
      longStill: false,
    };
    if (cut.has(action.id)) {
      return { ...blank, outputMs: null, unknown: "cut", framing: null };
    }
    const sourceMs = markerAt.get(action.id);
    if (sourceMs === undefined) {
      return { ...blank, outputMs: null, unknown: "notInVideo", framing: null };
    }
    const outputMs = out(sourceMs);
    // Framing is for what the viewer watches being acted on (spec §2.1).
    if (!VERBS[action.kind].cursorTravels) {
      return { ...blank, outputMs, unknown: null, framing: null };
    }
    const target = rectAt.get(action.id);
    if (target === undefined) {
      return { ...blank, outputMs, unknown: "noRect", framing: null };
    }
    const { visible, shot } = visibleRegion(
      resolved,
      outputMs,
      bundle.viewport,
      scene.branding,
      frame,
    );
    // A drag is framed by its two points (`dragPoints`); anything else, or a
    // drag whose end cannot be placed, by its element's box.
    const points =
      action.kind === "drag"
        ? dragPoints(action, target, endAt.get(action.id))
        : null;
    const startRect = points === null ? target : pointRect(points.start);
    const endRect =
      points === null ? endAt.get(action.id) : pointRect(points.end);
    const label = framingOf(startRect, visible, shot);
    const end =
      endRect === undefined
        ? undefined
        : { label: framingOf(endRect, visible, shot), rect: endRect };
    return {
      ...blank,
      outputMs,
      unknown: null,
      framing: {
        label: end === undefined ? label : worse(label, end.label),
        rect: startRect,
        visible,
        ...(end === undefined ? {} : { end }),
      },
    };
  });

  // Samples inside a stretch a cut removed are not in the film: the timeline
  // maps them all to the seam instant, which would merge the paths either
  // side of it and teleport a cut step's own path. Drop them, and start a
  // fresh run after every gap so no journey spans a cut.
  const removed = (ms: number) =>
    resolved.timeline.cuts.some((c) => ms > c.srcStartMs && ms <= c.srcEndMs);
  const groups: TimedPoint[][] = [[]];
  for (const s of bundle.cursorSamples) {
    if (removed(s.sourceTimeMs)) {
      if ((groups[groups.length - 1] as TimedPoint[]).length > 0)
        groups.push([]);
      continue;
    }
    (groups[groups.length - 1] as TimedPoint[]).push({
      t: out(s.sourceTimeMs),
      x: s.x,
      y: s.y,
    });
  }
  // The travelling steps in video order, for "which step does this arrival
  // precede". Only steps the film shows can be arrived at.
  const travelling = steps
    .filter((s) => VERBS[s.kind].cursorTravels && s.outputMs !== null)
    .sort((a, b) => (a.outputMs as number) - (b.outputMs as number));

  // A drag's held move ends where it let go: it arrives at the drag itself,
  // not at whatever step comes next. Only a journey that sets off while the
  // button was held is that move: a later one that comes to rest on the drop
  // (over the card it left there) is the next step's, and arrives or strays
  // on its own account (review of 2026-10-21).
  const dragEnds = steps.flatMap((s) => {
    const held = bundle.heldPresses?.find((h) => h.actionId === s.actionId);
    return s.kind === "drag" &&
      s.outputMs !== null &&
      s.framing?.end !== undefined &&
      held !== undefined
      ? [
          {
            actionId: s.actionId,
            outputMs: s.outputMs,
            releasedMs: out(held.releaseMs),
            end: s.framing.end.rect,
          },
        ]
      : [];
  });

  const journeys: Journey[] = [];
  for (const run of groups.flatMap(splitJourneys)) {
    let travelledPx = 0;
    for (let i = 1; i < run.length; i++)
      travelledPx += dist(run[i - 1] as TimedPoint, run[i] as TimedPoint);
    if (travelledPx < MIN_JOURNEY_PX) continue;
    const first = run[0] as TimedPoint;
    const last = run[run.length - 1] as TimedPoint;
    const chord = dist(first, last);
    const detourPx = Math.max(...run.map((p) => offChord(p, first, last)));
    const dragged = dragEnds.find(
      (d) =>
        first.t >= d.outputMs &&
        first.t <= d.releasedMs &&
        contains(inflate(d.end, ARRIVAL_SLACK_PX), last),
    );
    const next =
      dragged === undefined
        ? (travelling.find((s) => (s.outputMs as number) >= last.t) ?? null)
        : { actionId: dragged.actionId };
    const nextRect =
      dragged !== undefined
        ? dragged.end
        : next === null
          ? undefined
          : rectAt.get(next.actionId);
    const onTarget =
      nextRect !== undefined &&
      contains(inflate(nextRect, ARRIVAL_SLACK_PX), last);
    journeys.push({
      fromOutputMs: first.t,
      toOutputMs: last.t,
      from: { x: first.x, y: first.y },
      to: { x: last.x, y: last.y },
      travelledPx,
      detourPx,
      detour: detourPx > Math.max(DETOUR_MIN_PX, DETOUR_FRACTION * chord),
      arrival:
        onTarget && next !== null
          ? { onTarget: true, actionId: next.actionId }
          : { onTarget: false, beforeActionId: next?.actionId ?? null },
    });
  }

  // Something is moving when a motion span covers that video time or a
  // journey is under way (spec §2.3).
  const busy: [number, number][] = [
    ...bundle.motionSpans.map(
      (m) => [out(m.startMs), out(m.endMs)] as [number, number],
    ),
    ...journeys.map((j) => [j.fromOutputMs, j.toOutputMs] as [number, number]),
  ];
  let previous: number | null = null;
  for (const step of steps) {
    if (step.outputMs === null) continue;
    if (previous !== null) {
      step.gapMs = step.outputMs - previous;
      step.stillMs = longestGap(previous, step.outputMs, busy);
      step.longStill =
        step.stillMs - (step.pausedMs ?? 0) - (heldAt.get(step.actionId) ?? 0) >
        LONG_STILL_MS;
    }
    previous = step.outputMs;
  }

  const summary: Record<FilmLabel, number> = { ...ZERO_SUMMARY };
  for (const step of steps) {
    if (step.framing) summary[step.framing.label]++;
    if (step.longStill) summary.longStill++;
  }
  for (const j of journeys) {
    if (!j.arrival.onTarget) summary.strayArrival++;
    if (j.detour) summary.detour++;
  }

  return {
    summary,
    steps,
    journeys,
    noCursor: bundle.cursorSamples.length === 0,
  };
}

export function filmForRun(args: {
  refused: boolean;
  scene: SceneDocument | null;
  bundle: FrameBundle | null;
  /** `pausedBeforeActions` of the script that ran; absent on a re-shoot. */
  paused?: ReadonlyMap<string, number>;
}): FilmReport {
  if (args.refused) return { unavailable: "refused" };
  if (args.scene === null) return { unavailable: "noTake" };
  if (args.bundle === null) return { unavailable: "noFrames" };
  // Report-only (spec decision 3): the check runs after the run has already
  // happened — a re-shoot's take is promoted to its new frames by now — so a
  // throw here must not turn a finished run into a lost report. Forgiven,
  // and said: the field carries the words, and the Errors list gets them,
  // because a check that cannot read its own run's film is a fault.
  try {
    return filmQuality(args.scene, args.bundle, args.paused);
  } catch (error) {
    console.error("demoman run: the video check failed", error);
    return {
      unavailable: "checkFailed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The milliseconds of `pause` a script put right before each step it
 * performed, by that step's action id: the pause steps between it and the
 * step attempted before it. A `pause` makes no action, so this is the only
 * place the film check can learn the stillness was asked for. Steps with no
 * pause ahead of them, and steps that never reached the document, are absent.
 */
export function pausedBeforeActions(
  steps: readonly ScriptStep[],
  attempted: readonly { index: number; actionId: string | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  let from = 0;
  for (const step of attempted) {
    let ms = 0;
    for (const s of steps.slice(from, step.index)) {
      if (s.do === "pause") ms += s.ms;
    }
    if (step.actionId !== null && ms > 0) out.set(step.actionId, ms);
    from = step.index + 1;
  }
  return out;
}
