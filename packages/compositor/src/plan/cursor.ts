import { type SceneDocument, spotIn } from "@demoman/scene-schema";
import { catmullRom } from "../easing.js";
import { clamp, distance, type Rect, type Vec } from "../geometry.js";
import type { CursorSegment } from "./types.js";
import { VERBS } from "./verbs.js";

export const CURSOR_DEFAULTS = {
  // Half the pace these once set (240-700ms, 180ms + 0.35ms/px): the author
  // watched an agent take on 2026-10-07 and found its moves too fast.
  minDurationMs: 480,
  maxDurationMs: 1400,
  baseMs: 360,
  msPerPx: 0.7,
  dwellMs: 300,
  /** SP1 measured a tooltip needing ~275 ms to appear after the path lands. */
  hoverDwellMs: 450,
  /** Lateral bow as a fraction of travel distance. */
  bowFraction: 0.08,
} as const;

/** Distance-based, floored and ceilinged: short hops don't crawl, long ones don't sprint. */
export function segmentDurationMs(from: Vec, to: Vec): number {
  const d = distance(from, to);
  return Math.round(
    clamp(
      CURSOR_DEFAULTS.baseMs + CURSOR_DEFAULTS.msPerPx * d,
      CURSOR_DEFAULTS.minDurationMs,
      CURSOR_DEFAULTS.maxDurationMs,
    ),
  );
}

/**
 * A single lateral control point, bowing the path perpendicular to travel.
 * Deterministic: the sign alternates on the segment index rather than on a
 * random draw, so the same scene always plans the same path.
 */
function bowPoint(from: Vec, to: Vec, index: number): Vec {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: from.x, y: from.y };
  const sign = index % 2 === 0 ? 1 : -1;
  const bow = d * CURSOR_DEFAULTS.bowFraction * sign;
  return {
    x: from.x + dx / 2 - (dy / d) * bow,
    y: from.y + dy / 2 + (dx / d) * bow,
  };
}

/** Position along a segment at normalized progress `t`, easing already applied by the caller. */
export function sampleSegment(segment: CursorSegment, t: number): Vec {
  return catmullRom(segment.via, clamp(t, 0, 1));
}

/**
 * Where the cursor starts before it has ever moved: just outside the first
 * target, low and to the left, so the opening move reads as an approach
 * rather than a teleport.
 *
 * Exported for the authored door (`runAuthored`), which cannot pass its first
 * target's centre: an authored run measures each rect only when it reaches
 * that step, which is the whole reason the walk's source is pulled lazily. It
 * applies this rule to the viewport's own centre instead, so the opening move
 * still reads as an approach and the offsets live in one place.
 */
export function cursorEntryPoint(
  first: Vec,
  viewport: { width: number; height: number },
): Vec {
  return {
    x: clamp(first.x - viewport.width * 0.25, 0, viewport.width),
    y: clamp(first.y + viewport.height * 0.3, 0, viewport.height),
  };
}

/**
 * One planned move: the bowed spline, how long it takes, and the settle at
 * the far end.
 *
 * Factored out of `planCursorSegments` below, which is the only caller that
 * can plan the whole path up front. An authored run cannot — it learns each
 * rect as it arrives at that step — so it plans one segment at a time
 * through here rather than carrying a second copy of the bow fraction, the
 * speed curve and the easing choice. Two copies of those is two cursors that
 * move at different speeds the first time anybody tunes one.
 *
 * `dwellMs` is optional for exactly one caller: an authored run cannot know
 * whether hovering changes this page (the walk MEASURES that and reports it
 * as `hoverSensitive`), so it takes the resting dwell. Nothing is lost —
 * `pathPointAt` dispatches from `durationMs` and `easing` alone, and a later
 * plan built from the finished document applies the hover dwell itself.
 */
export function planCursorSegment(args: {
  from: Vec;
  to: Vec;
  /** Alternates which side the path bows to, keyed on the segment's ordinal
   *  rather than a random draw, so a plan is reproducible. */
  index: number;
  fromActionId: string | null;
  toActionId: string;
  dwellMs?: number;
}): CursorSegment {
  const { from, to } = args;
  return {
    fromActionId: args.fromActionId,
    toActionId: args.toActionId,
    from,
    to,
    via: [from, bowPoint(from, to, args.index), to],
    durationMs: segmentDurationMs(from, to),
    easing: "minimumJerk",
    dwellMs: args.dwellMs ?? CURSOR_DEFAULTS.dwellMs,
  };
}

export function planCursorSegments(
  scene: SceneDocument,
  rectOf: (anchorId: string, actionId: string) => Rect | null,
): CursorSegment[] {
  const targets = scene.actions.flatMap((action) => {
    // A null anchorId (a navigation waitFor) names no element, so it has no
    // on-screen position and contributes no waypoint — same treatment as an
    // anchor whose rect is unknown. A kind the cursor does not travel to (a
    // scroll, a wait) contributes none either: see `VERBS`.
    if (action.anchorId === null || !VERBS[action.kind].cursorTravels) {
      return [];
    }
    const rect = rectOf(action.anchorId, action.id);
    return rect
      ? [
          {
            action,
            point: spotIn(
              rect,
              action.kind === "click" ? action.at : undefined,
            ),
          },
        ]
      : [];
  });
  if (targets.length === 0) return [];

  const dwellMs = scene.flags.hoverSensitive
    ? CURSOR_DEFAULTS.hoverDwellMs
    : CURSOR_DEFAULTS.dwellMs;

  const first = targets[0] as { action: { id: string }; point: Vec };
  let from = cursorEntryPoint(first.point, scene.meta.capture.viewport);
  let previousActionId: string | null = null;

  return targets.map((target, index) => {
    const to = target.point;
    const segment = planCursorSegment({
      from,
      to,
      index,
      fromActionId: previousActionId,
      toActionId: target.action.id,
      dwellMs,
    });
    from = to;
    previousActionId = target.action.id;
    return segment;
  });
}
