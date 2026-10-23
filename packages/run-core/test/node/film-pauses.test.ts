import { planScene, resolvePlan, toOutputMs } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import {
  filmQuality,
  LONG_STILL_MS,
  pausedBeforeActions,
} from "../../src/replay/film.js";

const rect = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

/** A hold of `durationMs` right after act-1: video time advances, source
 *  time does not, so the video gap and the source gap differ. */
function withHold<T extends { edits: object }>(take: T, durationMs: number): T {
  return {
    ...take,
    edits: {
      ...take.edits,
      holds: [
        { id: "h1", marker: { actionId: "act-1", offsetMs: 0 }, durationMs },
      ],
    },
  };
}

function twoClicks(
  secondAtMs: number,
  motion: { startMs: number; endMs: number }[] = [],
) {
  const take = takeOf(["click", "click"]);
  const bundle = framesOf({
    markers: [
      { actionId: "act-1", sourceTimeMs: 1000 },
      { actionId: "act-2", sourceTimeMs: secondAtMs },
    ],
    anchorRects: [
      { actionId: "act-1", anchorId: "a1", rect: rect(100, 100) },
      { actionId: "act-2", anchorId: "a2", rect: rect(100, 100) },
    ],
    motionSpans: motion.map((m, i) => ({
      ...m,
      ref: `m-${i}`,
      width: 1280,
      height: 800,
      fps: 30,
      byteLength: 0,
    })),
  });
  return { take, bundle };
}

describe("filmQuality: pauses", () => {
  // Video time, not source time (decision 4). The expectation is computed by
  // the compositor's own retiming, and the premise asserts that retiming
  // changed the number — or this test could not tell the two clocks apart.
  it("measures the gap in video time", () => {
    // The compositor does not compress idle on this bundle, so a 2s hold is
    // what makes video time differ from source time (the first attempt, a bare
    // 8000ms source gap, retimed to exactly 8000 and proved nothing).
    const { take: plain, bundle } = twoClicks(9000);
    const take = withHold(plain, 2000);
    const timeline = resolvePlan(planScene(take), bundle, take).timeline;
    const expected = toOutputMs(timeline, 9000) - toOutputMs(timeline, 1000);
    expect(expected).not.toBe(9000 - 1000);
    expect(expected).toBeCloseTo(10000, 3);

    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    expect(film.steps[0]?.gapMs).toBeNull();
    expect(film.steps[1]?.gapMs).toBeCloseTo(expected, 3);
    expect(film.steps[1]?.stillMs).toBeCloseTo(expected, 3);
  });

  it("breaks a still with motion, and labels only a long one", () => {
    const { take, bundle } = twoClicks(9000, [{ startMs: 4000, endMs: 4500 }]);
    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    const step = film.steps[1];
    // The premise: motion sits strictly inside the gap, so the still is shorter.
    expect(step?.stillMs as number).toBeLessThan(step?.gapMs as number);
    // The fixture's longest quiet stretch, in video time: 4500ms (the motion's
    // end) to 9000ms (act-2), computed by the compositor's own retiming.
    const timeline = resolvePlan(planScene(take), bundle, take).timeline;
    const longest = toOutputMs(timeline, 9000) - toOutputMs(timeline, 4500);
    // ...and it is the longer of the two stretches (the other is 1000..4000),
    // and long enough to be labelled — or `longStill: true` below is not what
    // this fixture should produce.
    expect(longest).toBeGreaterThan(
      toOutputMs(timeline, 4000) - toOutputMs(timeline, 1000),
    );
    expect(longest).toBeGreaterThan(LONG_STILL_MS);
    expect(step?.stillMs).toBeCloseTo(longest, 3);
    expect(step?.longStill).toBe(true);
    expect(film.summary.longStill).toBe(1);
  });

  it("does not label a gap whose every quiet stretch is short", () => {
    // Motion every 1000ms across a 4s gap leaves quiet stretches of ~500ms.
    const motion = [1500, 2500, 3500].map((startMs) => ({
      startMs,
      endMs: startMs + 500,
    }));
    const { take, bundle } = twoClicks(5000, motion);
    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    const step = film.steps[1];
    // The premise: the gap alone is long enough to be labelled.
    expect(step?.gapMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(step?.stillMs as number).toBeLessThanOrEqual(LONG_STILL_MS);
    expect(step?.longStill).toBe(false);
    expect(film.summary.longStill).toBe(0);
  });

  it("a cursor journey across the middle of a gap breaks the still", () => {
    // No motion span at all: only the cursor moves, 2000ms..3000ms of a
    // 1000ms..4000ms gap, so each side is a ~1000ms still and neither is long
    // — while the whole gap, 3000ms, would be.
    const { take, bundle: base } = twoClicks(4000);
    const bundle = {
      ...base,
      cursorSamples: Array.from({ length: 63 }, (_, i) => ({
        sourceTimeMs: 2000 + (1000 * i) / 62,
        x: 10 + 5 * i,
        y: 10,
      })),
    };
    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    const step = film.steps[1];
    expect(bundle.motionSpans.every((m) => m.endMs < 1000)).toBe(true);
    expect(film.journeys, JSON.stringify(film.journeys)).toHaveLength(1);
    expect(step?.gapMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(step?.stillMs as number).toBeLessThanOrEqual(1000 + 1);
    expect(step?.longStill).toBe(false);
  });

  it("labels a two-second hold in the video as longStill", () => {
    const { take, bundle } = twoClicks(1000 + 1);
    const held = withHold(take, 2000);
    const film = filmQuality(held, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    // The premise: the hold reached the video.
    expect(film.steps[1]?.gapMs as number).toBeGreaterThanOrEqual(2000);
    expect(film.steps[1]?.longStill).toBe(true);
  });
});

describe("filmQuality: a pause the script asked for", () => {
  // act-1 at 1000ms, act-2 at 3400ms, nothing moving between: a 2.4s still.
  const stillTake = () => twoClicks(3400);

  it("does not call a still the script's own pause asked for a longStill", () => {
    const { take, bundle } = stillTake();
    const plain = filmQuality(take, bundle);
    if ("unavailable" in plain) throw new Error(plain.unavailable);
    // Premise and control: without the pause, this fixture IS a longStill.
    expect(plain.steps[1]?.stillMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(plain.steps[1]?.longStill).toBe(true);
    expect(plain.steps[1]?.pausedMs).toBeNull();

    const film = filmQuality(take, bundle, new Map([["act-2", 1500]]));
    if ("unavailable" in film) throw new Error(film.unavailable);
    // The still is still measured and still reported; the pause is beside it.
    expect(film.steps[1]?.stillMs).toBeCloseTo(
      plain.steps[1]?.stillMs as number,
      3,
    );
    expect(film.steps[1]?.pausedMs).toBe(1500);
    expect(film.steps[1]?.longStill).toBe(false);
    expect(film.summary.longStill).toBe(0);
  });

  it("still calls the stillness beyond the pause a longStill", () => {
    // act-2 at 5000ms: a 4s still, 1.5s of it asked for, 2.5s not.
    const { take, bundle } = twoClicks(5000);
    const film = filmQuality(take, bundle, new Map([["act-2", 1500]]));
    if ("unavailable" in film) throw new Error(film.unavailable);
    const step = film.steps[1];
    // Premise: what is left after the pause is itself over the line.
    expect((step?.stillMs as number) - 1500).toBeGreaterThan(LONG_STILL_MS);
    expect(step?.pausedMs).toBe(1500);
    expect(step?.longStill).toBe(true);
  });
});

describe("pausedBeforeActions", () => {
  const pause = (ms: number) => ({ do: "pause" as const, ms });
  const click = (name: string) => ({
    do: "click" as const,
    on: { role: "button", name },
  });

  it("sums the pauses between each performed step and the one before it", () => {
    const steps = [
      pause(400), // before the first action: nothing measures a still there
      click("A"),
      pause(800),
      pause(700),
      click("B"),
      click("C"),
      pause(900),
      click("D"), // attempted, never reached the document
    ];
    const paused = pausedBeforeActions(steps, [
      { index: 1, actionId: "act-a" },
      { index: 4, actionId: "act-b" },
      { index: 5, actionId: "act-c" },
      { index: 7, actionId: null },
    ]);
    expect(paused.get("act-b")).toBe(1500);
    expect(paused.has("act-c")).toBe(false);
    expect(paused.get("act-a")).toBe(400);
    expect([...paused.keys()].sort()).toEqual(["act-a", "act-b"]);
  });
});

describe("filmQuality: room the replay added", () => {
  // Spec 2026-10-19: time the replay added so the camera could move
  // unhurried is Demoman's pacing, not a stall.
  it("does not call room the replay added a long still", () => {
    const plain = twoClicks(3500);
    const roomy = {
      ...plain,
      bundle: {
        ...plain.bundle,
        markers: plain.bundle.markers.map((m) =>
          m.actionId === "act-2" ? { ...m, roomMs: 1200, roomHeldMs: 1200 } : m,
        ),
      },
    };
    const without = filmQuality(plain.take, plain.bundle);
    const withRoom = filmQuality(roomy.take, roomy.bundle);
    if ("unavailable" in without || "unavailable" in withRoom) {
      throw new Error("no film");
    }
    // Premise: the still is long without the room counted.
    expect(without.steps[1]?.stillMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(without.steps[1]?.longStill).toBe(true);
    expect(without.steps[1]?.roomMs).toBeNull();
    expect(withRoom.steps[1]?.roomMs).toBe(1200);
    expect(withRoom.steps[1]?.longStill).toBe(false);
  });

  // Code review 2026-10-20 (R4): room is several waits, and one of them is
  // the page still painting, so only the longest single hold may be taken
  // off one still stretch.
  it("forgives only the longest single hold, not all the room", () => {
    const plain = twoClicks(4200);
    const marked = (roomMs: number, roomHeldMs: number) => ({
      ...plain.bundle,
      markers: plain.bundle.markers.map((m) =>
        m.actionId === "act-2" ? { ...m, roomMs, roomHeldMs } : m,
      ),
    });
    const film = filmQuality(plain.take, marked(2300, 1000));
    if ("unavailable" in film) throw new Error(film.unavailable);
    // Premise: the still is longer than LONG_STILL_MS plus the hold, and no
    // longer than it plus all the room.
    const still = film.steps[1]?.stillMs as number;
    expect(still).toBeGreaterThan(LONG_STILL_MS + 1000);
    expect(still).toBeLessThanOrEqual(LONG_STILL_MS + 2300);
    expect(film.steps[1]?.longStill).toBe(true);
  });
});
