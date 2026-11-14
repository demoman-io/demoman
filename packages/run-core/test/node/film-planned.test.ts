import type { FrameBundle } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  pacedBundle,
  SLOW,
  twoStepScene,
} from "../../../compositor/test/fixtures/beats";
import {
  filmQuality,
  insidePlacedIdle,
  LONG_STILL_MS,
  placedIdleSpans,
} from "../../src/replay/film.js";

// Spec 2026-11-13 "same take, any machine", Part 3, "When it cannot be
// applied": a take with a beat plan plays its idle at the planned length, so
// the report says so, and idle the plan placed is never a long still.

const plan = (restMs: number) => ({
  beats: [
    { beforeActionId: "s1", restMs: 500, arriveMs: 200 },
    { beforeActionId: "s2", restMs, arriveMs: 300 },
  ],
  tailMs: 1000,
});

function filmOf(
  scene: ReturnType<typeof twoStepScene>,
  bundle: FrameBundle,
  paused?: ReadonlyMap<string, number>,
) {
  const film = filmQuality(scene, bundle, paused);
  if ("unavailable" in film) throw new Error(film.unavailable);
  return film;
}

const slow = () => pacedBundle(SLOW).bundle;
const s2Of = (film: ReturnType<typeof filmOf>) =>
  film.steps.find((s) => s.actionId === "s2");

describe("filmQuality: a take with a beat plan", () => {
  it("reports the planned length beside the recorded one, and no long still for a 6 s source idle played as a 900 ms rest", () => {
    // Red if `filmCheck`'s `pacing: "planned"` block goes.
    const bundle = slow();
    const film = filmOf(twoStepScene(plan(900)), bundle);
    // Premise: the recording really holds 6 s of idle between the steps, and
    // the marker carries no room.
    expect(film.recordedMs).toBeGreaterThan(6000 + 900);
    expect(bundle.markers.some((m) => m.roomHeldMs !== undefined)).toBe(false);
    expect(s2Of(film)?.stillMs as number).toBeLessThan(LONG_STILL_MS);
    expect(film.pacing).toBe("planned");
    expect(film.plannedMs).toBeLessThan(film.recordedMs as number);
    // The video's length is the plan's, whatever machine recorded it.
    const quick = filmOf(
      twoStepScene(plan(900)),
      pacedBundle({
        openRest: 100,
        openArrive: 150,
        rest: 400,
        arrive: 300,
        tail: 200,
      }).bundle,
    );
    expect(quick.recordedMs as number).toBeLessThan(film.recordedMs as number);
    expect(quick.plannedMs).toBeCloseTo(film.plannedMs as number, 6);
    expect(s2Of(film)?.longStill).toBe(false);
    expect(film.summary.longStill).toBe(0);
    expect(film).not.toHaveProperty("unplacedBeats");
  });

  it("does not call a planned rest longer than the line a long still", () => {
    // Red if `filmCheck`'s `planned && placedBeat.has(...)` branch goes (the
    // pair would then be measured as recorded): a rest of 2 s is planned, so
    // the video holds that long on purpose.
    const film = filmOf(twoStepScene(plan(2000)), slow());
    // Premise: the planned still really is past the line.
    expect(s2Of(film)?.stillMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(s2Of(film)?.longStill).toBe(false);
    expect(film.summary.longStill).toBe(0);
  });

  it("still checks a pair whose beat was unplaced, and counts it", () => {
    // Red if `filmCheck` drops `unplacedSteps` from `placedBeat`: s2 would
    // be skipped as a placed pair although it plays as recorded.
    const bundle = slow();
    const noApproach: FrameBundle = {
      ...bundle,
      markers: bundle.markers.map((m) =>
        m.actionId === "s2"
          ? { actionId: m.actionId, sourceTimeMs: m.sourceTimeMs }
          : m,
      ),
    };
    // Premise: s2 lost its approach, s1 kept its own.
    expect(noApproach.markers[1]).not.toHaveProperty("approachSourceTimeMs");
    expect(noApproach.markers[0]).toHaveProperty("approachSourceTimeMs");
    const film = filmOf(twoStepScene(plan(900)), noApproach);
    expect(film.unplacedBeats).toBe(1);
    expect(film.unplacedBeatSteps).toEqual(["s2"]);
    expect(s2Of(film)?.stillMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(s2Of(film)?.longStill).toBe(true);
  });

  it("names the tail as the step an unplaced tail sits before: none", () => {
    // Red if `plannedIdleOf` stops pushing `null` for an unplaced tail.
    const bundle = slow();
    const noS2: FrameBundle = {
      ...bundle,
      markers: bundle.markers.filter((m) => m.actionId !== "s2"),
    };
    expect(noS2.markers.map((m) => m.actionId)).toEqual(["s1"]);
    const film = filmOf(twoStepScene(plan(900)), noS2);
    expect(film.unplacedBeatSteps).toEqual(["s2", null]);
    expect(film.unplacedBeats).toBe(2);
  });

  it("lists the placed pair's output span, which insidePlacedIdle reads", () => {
    // Red if `filmCheck` stops pushing to `placed`.
    const scene = twoStepScene(plan(900));
    const bundle = slow();
    const spans = placedIdleSpans(scene, bundle);
    const film = filmOf(scene, bundle);
    expect(spans).toEqual([[film.steps[0]?.outputMs, film.steps[1]?.outputMs]]);
    const [from, to] = spans[0] as [number, number];
    expect(insidePlacedIdle(spans, from + 10, to - 10)).toBe(true);
    expect(insidePlacedIdle(spans, from - 10, to - 10)).toBe(false);
    expect(placedIdleSpans(twoStepScene(), bundle)).toEqual([]);
  });
});

describe("filmQuality: a take with no beat plan", () => {
  it("reports exactly the fields it always did, and checks the pair as recorded", () => {
    // Red if `filmCheck` adds `pacing` (or any key) for a take with no plan.
    const scene = twoStepScene();
    const film = filmOf(scene, slow());
    // Premise: the take has no plan, and its 6 s idle really is a long still.
    expect(scene.pacing).toBeUndefined();
    expect(s2Of(film)?.stillMs as number).toBeGreaterThan(LONG_STILL_MS);
    expect(Object.keys(film)).toEqual([
      "summary",
      "steps",
      "journeys",
      "noCursor",
      "finalFrame",
    ]);
    expect(s2Of(film)?.longStill).toBe(true);
  });
});
