import {
  type CursorSegment,
  easings,
  planCursorSegment,
  sampleSegment,
  segmentDurationMs,
} from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { pathPointAt, retargetSegment } from "../../src/index.js";

const segment: CursorSegment = {
  fromActionId: null,
  toActionId: "act-1",
  from: { x: 0, y: 0 },
  to: { x: 100, y: 100 },
  via: [
    { x: 0, y: 0 },
    { x: 40, y: 70 },
    { x: 100, y: 100 },
  ],
  durationMs: 400,
  easing: "easeInOutCubic",
  dwellMs: 120,
};

describe("retargetSegment", () => {
  it("leaves a segment alone when the page agrees with the plan", () => {
    const same = retargetSegment(segment, { x: 0, y: 0 }, { x: 100, y: 100 });
    expect(same.via).toEqual(segment.via);
  });

  // The cursor is where it is; the target is where the page says. Both ends
  // are pinned and the curve in between is carried across relative to the
  // travel: (40, 70) sits 0.55 of the way along the planned chord and 0.15 of
  // its length off to the side, and it lands at the same place on the new
  // chord. It used to be carried as an absolute displacement, which kept the
  // (60, 30)-px bend whatever the new travel was — see the next test.
  it("pins both ends and carries the curve across, relative to the travel", () => {
    const moved = retargetSegment(segment, { x: 0, y: 0 }, { x: 200, y: 100 });
    expect(moved.via.at(0)).toEqual({ x: 0, y: 0 });
    expect(moved.via.at(-1)).toEqual({ x: 200, y: 100 });
    expect(moved.via[1]?.x).toBeCloseTo(95, 9);
    expect(moved.via[1]?.y).toBeCloseTo(85, 9);
  });

  // The author's take of 2026-09-29. The click's segment was planned from
  // the hover's rect (a bad one, two screens down) to the click's, a 2310px
  // move bowed 185px to one side. At replay the cursor was already on the
  // button, and the bow was carried across at full size: the path swung
  // 180px off the button and back, over the planned 700ms.
  it("scales the bow with the travel, so a short move does not loop", () => {
    const planned = planCursorSegment({
      from: { x: 798, y: 2480 },
      to: { x: 798, y: 170 },
      index: 1,
      fromActionId: "act-3",
      toActionId: "act-4",
    });
    // The premise: the plan really does bow far off its chord and take the
    // longest duration there is, or a short move could not inherit either.
    const plannedOff = Math.max(...planned.via.map((p) => Math.abs(p.x - 798)));
    expect(plannedOff).toBeGreaterThan(150);
    expect(planned.durationMs).toBe(1400);

    const from = { x: 700, y: 20 };
    const to = { x: 798, y: 20 };
    const moved = retargetSegment(planned, from, to);

    const travel = 98;
    const off = Array.from(
      { length: Math.floor(moved.durationMs / 8) + 1 },
      (_, i) => pathPointAt(moved, i * 8),
    ).map((p) => Math.abs(p.y - 20));
    // The compositor's own bow is 8% of the travel; a little headroom for the
    // spline passing its control point.
    expect(Math.max(...off)).toBeLessThanOrEqual(travel * 0.1);
    // And the compositor's own rule for how long a move this short takes.
    expect(moved.durationMs).toBe(segmentDurationMs(from, to));
  });

  it("does not move at all when the cursor is already on the target", () => {
    const planned = planCursorSegment({
      from: { x: 798, y: 2480 },
      to: { x: 798, y: 170 },
      index: 1,
      fromActionId: "act-3",
      toActionId: "act-4",
    });
    const here = { x: 798, y: 20 };
    const moved = retargetSegment(planned, here, here);
    expect(moved.durationMs).toBe(0);
    expect(moved.via.every((p) => p.x === 798 && p.y === 20)).toBe(true);
  });

  // A click on the element a hover just moved to: the plan itself has no
  // travel, and the page agrees with it. The plan still carries the
  // shortest move's duration, and replay used to hold the cursor still for
  // all of it before the click: 240ms of nothing (found 2026-10-07), and
  // 480ms at the halved pace.
  it("takes no time when the plan has no travel and the page agrees", () => {
    const at = { x: 220, y: 252 };
    const planned = planCursorSegment({
      from: at,
      to: at,
      index: 1,
      fromActionId: "act-7",
      toActionId: "act-8",
    });
    // The premise: a plan with no travel still asks for time, and its ends
    // are where the page says, so this is the agreeing case.
    expect(planned.durationMs).toBeGreaterThan(0);
    expect(planned.via.at(0)).toEqual(at);
    expect(planned.via.at(-1)).toEqual(at);

    const moved = retargetSegment(planned, at, at);
    expect(moved.durationMs).toBe(0);
  });

  it("starts from where the cursor actually is, not where the plan assumed", () => {
    const moved = retargetSegment(
      segment,
      { x: 10, y: 10 },
      { x: 100, y: 100 },
    );
    expect(moved.via.at(0)).toEqual({ x: 10, y: 10 });
    expect(moved.via.at(-1)).toEqual({ x: 100, y: 100 });
  });
});

describe("pathPointAt", () => {
  it("starts on the segment's start and finishes exactly on its target", () => {
    expect(pathPointAt(segment, 0)).toEqual({ x: 0, y: 0 });
    expect(pathPointAt(segment, 400)).toEqual({ x: 100, y: 100 });
    // A send that comes back late still lands, rather than overshooting.
    expect(pathPointAt(segment, 1000)).toEqual({ x: 100, y: 100 });
  });

  it("answers the target for a segment of no duration", () => {
    // `retargetSegment` makes these when the cursor is already there.
    expect(pathPointAt({ ...segment, durationMs: 0 }, 0)).toEqual({
      x: 100,
      y: 100,
    });
  });

  // Easing is applied to the curve parameter, not to time: a quarter of the
  // way through the time is easeInOutCubic(0.25) of the way along the curve.
  it("eases along the curve rather than by the clock", () => {
    const eased = sampleSegment(segment, easings.easeInOutCubic(0.25));
    const linear = sampleSegment(segment, 0.25);
    // The premise: the ease puts the point somewhere else than the clock
    // would, by enough to tell apart.
    expect(Math.hypot(eased.x - linear.x, eased.y - linear.y)).toBeGreaterThan(
      5,
    );
    expect(pathPointAt(segment, 100)).toEqual(eased);
  });
});
