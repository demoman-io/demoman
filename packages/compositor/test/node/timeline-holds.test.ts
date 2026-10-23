import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { buildTimeline, toOutputMs, toSourceMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

function planWithHold(durationMs: number, actionId = "act-3", offsetMs = 0) {
  const scene = readonlyScene();
  return planScene({
    ...scene,
    edits: {
      ...scene.edits,
      holds: [{ id: "hold-1", marker: { actionId, offsetMs }, durationMs }],
    },
  });
}

describe("buildTimeline holds", () => {
  it("lengthens the output by exactly the hold", () => {
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    const held = buildTimeline(planWithHold(800), bundle);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(800, 6);
  });

  it("leaves source duration untouched", () => {
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    const held = buildTimeline(planWithHold(800), bundle);
    expect(held.sourceDurationMs).toBe(base.sourceDurationMs);
  });

  it("emits a zero-source-span segment at the marker", () => {
    const bundle = proceduralBundle();
    const marker = bundle.markers.find((m) => m.actionId === "act-3");
    const held = buildTimeline(planWithHold(800), bundle);
    const hold = held.segments.find((s) => s.kind === "hold");
    expect(hold).toBeDefined();
    expect(hold?.srcStartMs).toBe(hold?.srcEndMs);
    expect(hold?.srcStartMs).toBe(marker?.sourceTimeMs);
    expect((hold?.outEndMs ?? 0) - (hold?.outStartMs ?? 0)).toBeCloseTo(800, 6);
  });

  it("freezes the picture across the hold", () => {
    const held = buildTimeline(planWithHold(800), proceduralBundle());
    const hold = held.segments.find((s) => s.kind === "hold");
    const at = (t: number) => toSourceMs(held, t);
    // Both ends of the hold map to the same source instant, which is what
    // makes it a pause rather than a slow-motion stretch.
    expect(at((hold?.outStartMs ?? 0) + 1)).toBeCloseTo(
      hold?.srcStartMs ?? 0,
      6,
    );
    expect(at((hold?.outEndMs ?? 0) - 1)).toBeCloseTo(hold?.srcStartMs ?? 0, 6);
  });

  it("keeps the map monotone non-decreasing", () => {
    const held = buildTimeline(planWithHold(800), proceduralBundle());
    let previous = -1;
    for (let t = 0; t <= held.outputDurationMs; t += 10) {
      const source = toSourceMs(held, t);
      expect(source).toBeGreaterThanOrEqual(previous);
      previous = source;
    }
  });

  it("still never compresses a motion span", () => {
    const bundle = proceduralBundle();
    const held = buildTimeline(planWithHold(800), bundle);
    for (const segment of held.segments.filter((s) => s.kind === "motion")) {
      expect(segment.outEndMs - segment.outStartMs).toBeCloseTo(
        segment.srcEndMs - segment.srcStartMs,
        6,
      );
    }
  });

  it("maps a held marker to the instant the hold begins", () => {
    const bundle = proceduralBundle();
    // act-1, not act-3: act-3's marker IS sourceDurationMs, and toOutputMs
    // clamps at the end (see the terminal-hold test below).
    const marker = bundle.markers.find((m) => m.actionId === "act-1");
    const held = buildTimeline(planWithHold(500, "act-1"), bundle);
    const hold = held.segments.find((s) => s.kind === "hold");
    expect(toOutputMs(held, marker?.sourceTimeMs ?? 0)).toBeCloseTo(
      hold?.outStartMs ?? 0,
      6,
    );
  });

  it("puts a hold on the final beat at the very end of the output", () => {
    // act-3's marker is the last source instant, and toOutputMs clamps
    // `sourceMs >= sourceDurationMs` to outputDurationMs — the LAST moment
    // that instant is on screen rather than the first. For a terminal hold
    // those differ by the hold itself. Left as-is deliberately: toOutputMs
    // is load-bearing for the camera solver and the click-pulse mapping,
    // and changing its clamp to serve a marker tick would be a large blast
    // radius for a cosmetic gain. The visible consequence is that the
    // editor's last beat tick sits after its own hold.
    const bundle = proceduralBundle();
    const held = buildTimeline(planWithHold(800, "act-3"), bundle);
    const hold = held.segments.find((s) => s.kind === "hold");
    expect(hold?.outEndMs).toBeCloseTo(held.outputDurationMs, 6);
    expect(toOutputMs(held, 9000)).toBeCloseTo(held.outputDurationMs, 6);
  });

  it("drops a hold whose action the bundle never reached", () => {
    // A partial replay stops mid-flow. Inventing a source time for a marker
    // that does not exist is exactly the timestamp anchoring v8 §6 forbids.
    const bundle = proceduralBundle();
    const partial = {
      ...bundle,
      markers: bundle.markers.filter((m) => m.actionId !== "act-3"),
    };
    const base = buildTimeline(planScene(readonlyScene()), partial);
    const held = buildTimeline(planWithHold(800), partial);
    expect(held.outputDurationMs).toBeCloseTo(base.outputDurationMs, 6);
    expect(held.segments.some((s) => s.kind === "hold")).toBe(false);
  });

  it("applies two holds on different beats", () => {
    const scene = readonlyScene();
    const plan = planScene({
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "h1",
            marker: { actionId: "act-1", offsetMs: 0 },
            durationMs: 300,
          },
          {
            id: "h2",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 500,
          },
        ],
      },
    });
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(scene), bundle);
    const held = buildTimeline(plan, bundle);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(800, 6);
    expect(held.segments.filter((s) => s.kind === "hold")).toHaveLength(2);
  });

  // Coverage for the off-marker case that hid the original bug: every test
  // above uses offsetMs: 0, which always lands on a pre-existing cut. A hold
  // that lands strictly inside a span used to add a cut there too, splitting
  // that span into two independently-clamped halves — harmless for motion
  // (two rate-1.0 halves), but for idle it let the min/max clamp fire twice
  // and inflate the output by more than the hold. These land inside spans on
  // purpose and check the delta is exactly the hold, not "close to".

  it("a hold strictly inside an idle span adds exactly the hold, not more", () => {
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    // act-1's marker is 400; +1400 lands at source 1800, inside the idle
    // span [400, 3200] rather than on either of its cut boundaries.
    const held = buildTimeline(planWithHold(800, "act-1", 1400), bundle);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(800, 6);
    let previous = -1;
    for (let t = 0; t <= held.outputDurationMs; t += 10) {
      const source = toSourceMs(held, t);
      expect(source).toBeGreaterThanOrEqual(previous);
      previous = source;
    }
  });

  it("a hold strictly inside a motion span adds exactly the hold and keeps both halves at rate 1.0", () => {
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    // act-2's marker is 3200, the motion span's own start; +400 lands at
    // source 3600, strictly inside the motion span [3200, 4000].
    const held = buildTimeline(planWithHold(300, "act-2", 400), bundle);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(300, 6);
    for (const segment of held.segments.filter((s) => s.kind === "motion")) {
      expect(segment.outEndMs - segment.outStartMs).toBeCloseTo(
        segment.srcEndMs - segment.srcStartMs,
        6,
      );
    }
    let previous = -1;
    for (let t = 0; t <= held.outputDurationMs; t += 10) {
      const source = toSourceMs(held, t);
      expect(source).toBeGreaterThanOrEqual(previous);
      previous = source;
    }
  });

  it("a hold at a negative offset landing before the first marker still adds exactly the hold", () => {
    const bundle = proceduralBundle();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    // act-1's marker is 400; -1000 would be source -600, clamped to 0 — the
    // very first cut, not a split.
    const held = buildTimeline(planWithHold(500, "act-1", -1000), bundle);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(500, 6);
    const hold = held.segments.find((s) => s.kind === "hold");
    expect(hold?.srcStartMs).toBe(0);
    let previous = -1;
    for (let t = 0; t <= held.outputDurationMs; t += 10) {
      const source = toSourceMs(held, t);
      expect(source).toBeGreaterThanOrEqual(previous);
      previous = source;
    }
  });
});
