import type { CursorSample } from "@demoman/compositor";
import { planScene, resolvePlan, toOutputMs } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import { filmQuality, STILL_MS } from "../../src/replay/film.js";

const rect = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

/** Samples every 8ms along a straight line, then held still for 300ms. */
function moveAndRest(
  from: { x: number; y: number },
  to: { x: number; y: number },
  startMs: number,
  durMs: number,
): CursorSample[] {
  const n = Math.max(2, Math.round(durMs / 8));
  const moving = Array.from({ length: n + 1 }, (_, i) => ({
    sourceTimeMs: startMs + (durMs * i) / n,
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n,
  }));
  const end = startMs + durMs;
  return [...moving, { sourceTimeMs: end + 300, x: to.x, y: to.y }];
}

function journeysOf(
  take: ReturnType<typeof takeOf>,
  bundle: ReturnType<typeof framesOf>,
) {
  const film = filmQuality(take, bundle);
  if ("unavailable" in film) throw new Error(film.unavailable);
  return film;
}

describe("filmQuality: journeys", () => {
  // The fault of 2026-09-29: after a scroll the cursor travelled to the
  // scroll's paragraph and parked there.
  it("flags a journey that ends on a scroll's anchor as a stray arrival", () => {
    const take = takeOf(["click", "scrollTo", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 2500 },
        { actionId: "act-3", sourceTimeMs: 4000 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(800, 400) },
        { actionId: "act-3", anchorId: "a3", rect: rect(300, 600) },
      ],
      cursorSamples: [
        ...moveAndRest({ x: 0, y: 0 }, { x: 150, y: 120 }, 400, 400),
        ...moveAndRest({ x: 150, y: 120 }, { x: 850, y: 420 }, 1900, 400),
        ...moveAndRest({ x: 850, y: 420 }, { x: 350, y: 620 }, 3300, 400),
      ],
    });
    const film = journeysOf(take, bundle);
    // The premise: three journeys, the middle one ending on the scroll anchor.
    expect(film.journeys).toHaveLength(3);
    expect(film.journeys[1]?.to).toEqual({ x: 850, y: 420 });

    expect(film.journeys.map((j) => j.arrival.onTarget)).toEqual([
      true,
      false,
      true,
    ]);
    expect(film.journeys[1]?.arrival).toEqual({
      onTarget: false,
      beforeActionId: "act-3",
    });
    expect(film.summary.strayArrival).toBe(1);
  });

  // A drag's held move ends where it lets go, which is not the next step's
  // target: it arrives at the drag's own end (Excalidraw, 2026-10-21, where
  // every run read one stray arrival for a drag that landed exactly).
  it("reads a drag's held move as arriving at the drag's end", () => {
    const take = takeOf(["drag", "click"]);
    take.actions = take.actions.map((a, i) =>
      i === 0
        ? {
            ...a,
            kind: "drag" as const,
            toAnchorId: null,
            to: { by: { x: 400, y: 200 } },
          }
        : a,
    ) as typeof take.actions;
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 3000 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(900, 600) },
      ],
      heldPresses: [{ actionId: "act-1", pressMs: 1000, releaseMs: 1900 }],
      cursorSamples: [
        ...moveAndRest({ x: 0, y: 0 }, { x: 150, y: 120 }, 400, 400),
        // The held move, from the drag's start to where it let go.
        ...moveAndRest({ x: 150, y: 120 }, { x: 550, y: 320 }, 1000, 600),
        ...moveAndRest({ x: 550, y: 320 }, { x: 950, y: 620 }, 2300, 400),
      ],
    });
    const film = journeysOf(take, bundle);
    // The premise: three journeys, the middle one ending at the drag's end,
    // which is nowhere near the click that follows.
    expect(film.journeys).toHaveLength(3);
    expect(film.journeys[1]?.to).toEqual({ x: 550, y: 320 });
    expect(film.journeys[1]?.arrival).toEqual({
      onTarget: true,
      actionId: "act-1",
    });
    expect(film.summary.strayArrival).toBe(0);
  });

  // Review of 2026-10-21: a later journey that comes to rest on the drop
  // point (over the card the drag left there) is not the drag's held move,
  // and strays from the step it was meant for.
  it("credits a drag only with a journey begun while it was held", () => {
    const take = takeOf(["drag", "click", "click"]);
    take.actions = take.actions.map((a, i) =>
      i === 0
        ? {
            ...a,
            kind: "drag" as const,
            toAnchorId: null,
            to: { by: { x: 400, y: 200 } },
          }
        : a,
    ) as typeof take.actions;
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 3000 },
        { actionId: "act-3", sourceTimeMs: 4500 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(900, 600) },
        { actionId: "act-3", anchorId: "a3", rect: rect(100, 600) },
      ],
      heldPresses: [{ actionId: "act-1", pressMs: 1000, releaseMs: 1900 }],
      cursorSamples: [
        ...moveAndRest({ x: 0, y: 0 }, { x: 150, y: 120 }, 400, 400),
        ...moveAndRest({ x: 150, y: 120 }, { x: 550, y: 320 }, 1000, 600),
        ...moveAndRest({ x: 550, y: 320 }, { x: 950, y: 620 }, 2300, 400),
        // Meant for act-3, it rests on the drag's drop point instead.
        ...moveAndRest({ x: 950, y: 620 }, { x: 552, y: 322 }, 3500, 400),
      ],
    });
    const film = journeysOf(take, bundle);
    // The premise: the last journey ends at the drag's end, far from act-3.
    expect(film.journeys).toHaveLength(4);
    expect(film.journeys[3]?.to).toEqual({ x: 552, y: 322 });
    // The held move still arrives at the drag.
    expect(film.journeys[1]?.arrival).toEqual({
      onTarget: true,
      actionId: "act-1",
    });
    expect(film.journeys[3]?.arrival).toEqual({
      onTarget: false,
      beforeActionId: "act-3",
    });
    expect(film.summary.strayArrival).toBe(1);
  });

  // Review Focus 4, and the reason these are arrivals, not rests: after
  // spec §1 the cursor sits still through a scroll, which is correct.
  it("does not flag a cursor that holds still through a scroll", () => {
    const take = takeOf(["click", "scrollTo", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 2500 },
        { actionId: "act-3", sourceTimeMs: 4000 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(800, 400) },
        { actionId: "act-3", anchorId: "a3", rect: rect(300, 600) },
      ],
      cursorSamples: [
        ...moveAndRest({ x: 0, y: 0 }, { x: 150, y: 120 }, 400, 400),
        ...moveAndRest({ x: 150, y: 120 }, { x: 350, y: 620 }, 3300, 400),
      ],
    });
    const film = journeysOf(take, bundle);
    expect(film.journeys).toHaveLength(2);
    expect(film.summary.strayArrival).toBe(0);
  });

  // The 180px loop: a journey that ends where it began. Spec §2.2 amended:
  // it counts because of the distance travelled, not its displacement.
  it("flags a loop off the target and back as a detour", () => {
    const take = takeOf(["click"]);
    const out = moveAndRest(
      { x: 798, y: 20 },
      { x: 618, y: 20 },
      400,
      350,
    ).slice(0, -1);
    const back = moveAndRest({ x: 618, y: 20 }, { x: 798, y: 20 }, 750, 350);
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1500 }],
      anchorRects: [
        {
          actionId: "act-1",
          anchorId: "a1",
          rect: { x: 747, y: 0, width: 103, height: 40 },
        },
      ],
      cursorSamples: [{ sourceTimeMs: 0, x: 798, y: 20 }, ...out, ...back],
    });
    const film = journeysOf(take, bundle);
    // The premise: one journey, with no displacement and 360px travelled.
    expect(film.journeys).toHaveLength(1);
    expect(film.journeys[0]?.travelledPx).toBeGreaterThan(300);
    expect(film.journeys[0]?.detour).toBe(true);
    expect(film.journeys[0]?.detourPx).toBeCloseTo(180, 0);
  });

  it("does not flag the planner's own 8% bow", () => {
    const take = takeOf(["click"]);
    const from = { x: 0, y: 400 };
    const to = { x: 1000, y: 400 };
    // A bowed path: 80px off the chord at its middle, 8% of 1000.
    const bowed: CursorSample[] = Array.from({ length: 51 }, (_, i) => {
      const t = i / 50;
      return {
        sourceTimeMs: 400 + 8 * i,
        x: from.x + (to.x - from.x) * t,
        y: 400 - 320 * t * (1 - t),
      };
    });
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1200 }],
      anchorRects: [
        {
          actionId: "act-1",
          anchorId: "a1",
          rect: { x: 950, y: 380, width: 100, height: 40 },
        },
      ],
      cursorSamples: [...bowed, { sourceTimeMs: 1100, x: 1000, y: 400 }],
    });
    const film = journeysOf(take, bundle);
    expect(Math.max(...bowed.map((s) => 400 - s.y))).toBeCloseTo(80, 0);
    // The premise: the bow is ONE journey, and it arrives on the target. Split
    // into two halves, each half is nearly straight and would pass
    // `detour: false` without the bow ever being measured.
    expect(film.journeys, JSON.stringify(film.journeys)).toHaveLength(1);
    expect(film.journeys[0]?.arrival).toEqual({
      onTarget: true,
      actionId: "act-1",
    });
    expect(film.journeys[0]?.detour).toBe(false);
  });

  // Review Focus 2.
  it("says there was no cursor rather than reporting no strays", () => {
    const take = takeOf(["scrollTo"]);
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
      anchorRects: [{ actionId: "act-1", anchorId: "a1", rect: rect(0, 0) }],
    });
    const film = journeysOf(take, bundle);
    expect(film.noCursor).toBe(true);
    expect(film.journeys).toEqual([]);
  });
});

/** One walk path, as `dispatchPath` records it: a sample at the start (where
 *  the cursor already rests) then one per step, the last on the destination,
 *  and nothing after it. */
function walkPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  startMs: number,
  durMs: number,
): CursorSample[] {
  const n = Math.round(durMs / 16);
  return Array.from({ length: n + 1 }, (_, i) => ({
    sourceTimeMs: startMs + (durMs * i) / n,
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n,
  }));
}

describe("filmQuality: journeys against a cut and the walk's real sample shape", () => {
  // A cut removes (marker, next marker] of its step. Paths either side of it,
  // the pause between them cut away, meet at the seam instant in video time.
  it("never merges two paths across a cut, nor teleports the cut step's own path", () => {
    const base = takeOf(["click", "click", "click", "click"]);
    // Recorded paces replay the gaps between step timestamps as dead air in
    // the video; bring the steps close so the seam has none to speak of.
    const take = {
      ...base,
      actions: base.actions.map((a, i) => ({ ...a, timestamp: 1000 + 10 * i })),
      edits: {
        ...base.edits,
        removed: [
          {
            id: "c1",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      },
    } as typeof base;
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 2450 },
        { actionId: "act-2", sourceTimeMs: 2500 },
        { actionId: "act-3", sourceTimeMs: 4000 },
        { actionId: "act-4", sourceTimeMs: 4600 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(800, 400) },
        { actionId: "act-3", anchorId: "a3", rect: rect(900, 50) },
        { actionId: "act-4", anchorId: "a4", rect: rect(300, 600) },
      ],
      cursorSamples: [
        ...walkPath({ x: 0, y: 0 }, { x: 150, y: 120 }, 2050, 400),
        // the cut step's own path: inside the removed stretch
        ...walkPath({ x: 150, y: 120 }, { x: 850, y: 420 }, 2600, 400),
        ...walkPath({ x: 850, y: 420 }, { x: 350, y: 620 }, 4020, 400),
      ],
    });
    const resolved = resolvePlan(planScene(take), bundle, take);
    const gap =
      toOutputMs(resolved.timeline, 4020) - toOutputMs(resolved.timeline, 2450);
    expect(resolved.timeline.cuts).toHaveLength(1);
    expect(
      gap,
      "the pause across the cut must be under STILL_MS of video time",
    ).toBeLessThan(STILL_MS);

    const film = journeysOf(take, bundle);
    expect(film.journeys, JSON.stringify(film.journeys)).toHaveLength(2);
    expect(film.journeys.map((j) => j.arrival)).toEqual([
      { onTarget: true, actionId: "act-1" },
      { onTarget: true, actionId: "act-4" },
    ]);
    expect(film.summary.strayArrival).toBe(0);
  });

  // packages/replay-engine/src/walk.ts `dispatchPath` (~706-729): the first
  // sample of every path repeats where the cursor rests, the last lands on the
  // destination, and there is no trailing rest sample.
  it("splits and lands on target for the samples the walk really records", () => {
    const take = takeOf(["click", "click", "click"]);
    const a = { x: 150, y: 120 };
    const b = { x: 850, y: 420 };
    const c = { x: 350, y: 620 };
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 2500 },
        { actionId: "act-3", sourceTimeMs: 4000 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
        { actionId: "act-2", anchorId: "a2", rect: rect(800, 400) },
        { actionId: "act-3", anchorId: "a3", rect: rect(300, 600) },
      ],
      cursorSamples: [
        ...walkPath({ x: 0, y: 0 }, a, 600, 400),
        ...walkPath(a, b, 2100, 400),
        ...walkPath(b, c, 3600, 400),
      ],
    });
    const resolved = resolvePlan(planScene(take), bundle, take);
    for (const [end, start] of [
      [1000, 2100],
      [2500, 3600],
    ] as const) {
      expect(
        toOutputMs(resolved.timeline, start) -
          toOutputMs(resolved.timeline, end),
      ).toBeGreaterThanOrEqual(STILL_MS);
    }
    const film = journeysOf(take, bundle);
    expect(film.journeys, JSON.stringify(film.journeys)).toHaveLength(3);
    expect(film.journeys.map((j) => j.arrival)).toEqual([
      { onTarget: true, actionId: "act-1" },
      { onTarget: true, actionId: "act-2" },
      { onTarget: true, actionId: "act-3" },
    ]);
    expect(film.summary.strayArrival).toBe(0);
  });
});
