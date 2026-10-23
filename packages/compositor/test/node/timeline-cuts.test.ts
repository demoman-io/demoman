import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { buildTimeline, toOutputMs, toSourceMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene, removedFor } from "../fixtures/scene";

/**
 * `proceduralBundle` with frames running PAST its last marker.
 *
 * The default fixture's last keyframe sits exactly on act-3's marker, so its
 * source axis ends at 9000 — which makes a trailing cut cover zero source
 * time and makes a cut on act-2 reach the video's own end. Both are
 * legitimate states and neither is the one these cases are about, so the
 * cases that need a take with a tail say so by building one.
 */
function bundleWithTail(
  overrides: Parameters<typeof proceduralBundle>[0] = {},
) {
  const base = proceduralBundle();
  return proceduralBundle({
    keyframes: [
      ...base.keyframes,
      {
        sourceTimeMs: 12_000,
        ref: "k-tail",
        width: 3840,
        height: 2400,
        actionId: null,
        byteLength: 0,
      },
    ],
    ...overrides,
  });
}

function cutScene(actionIds: string[]) {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      removed: removedFor(
        scene,
        actionIds.map((actionId, i) => ({ id: `cut-${i + 1}`, actionId })),
      ),
    },
  };
}

describe("buildTimeline and cuts", () => {
  it("drops the cut stretch from the output axis", () => {
    const bundle = proceduralBundle();
    // Premise: the two markers that bound act-2's run are 5800ms apart and
    // both really are in the bundle. Without this the shortening below would
    // be satisfied by a cut that resolved to nothing.
    const at = new Map(bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]));
    expect(at.get("act-2")).toBe(3200);
    expect(at.get("act-3")).toBe(9000);

    const whole = buildTimeline(planScene(readonlyScene()), bundle);
    const cut = buildTimeline(planScene(cutScene(["act-2"])), bundle);

    expect(cut.cuts).toEqual([
      {
        ids: ["cut-1"],
        srcStartMs: 3200,
        srcEndMs: 9000,
        // act-3's frame is this bundle's last, so nothing follows the piece.
        trailing: true,
      },
    ]);
    expect(cut.sourceDurationMs).toBe(9000);
    expect(cut.unplacedCuts).toEqual([]);
    expect(whole.outputDurationMs - cut.outputDurationMs).toBeCloseTo(5800, 6);
    // The SOURCE axis is untouched: a cut removes frames from the video, it
    // does not shorten the take they came from.
    expect(cut.sourceDurationMs).toBe(whole.sourceDurationMs);
  });

  it("merges an adjacent pair into one removed stretch", () => {
    const bundle = proceduralBundle();
    const cut = buildTimeline(planScene(cutScene(["act-1", "act-2"])), bundle);
    expect(cut.cuts).toHaveLength(1);
    expect(cut.cuts[0]).toMatchObject({
      ids: ["cut-1"],
      srcStartMs: 400,
      srcEndMs: 9000,
    });
  });

  it("runs a trailing cut to the end of the bundle and marks it", () => {
    const bundle = bundleWithTail();
    // Premise: the bundle's frames really do run PAST the last marker, so
    // "to the end of the bundle" is a stretch that exists at all. On the
    // default fixture it is empty, and this case would assert nothing.
    const lastMarkerMs = Math.max(...bundle.markers.map((m) => m.sourceTimeMs));
    const lastFrameMs = Math.max(
      ...bundle.keyframes.map((k) => k.sourceTimeMs),
    );
    expect(lastMarkerMs).toBe(9000);
    expect(lastFrameMs).toBeGreaterThan(lastMarkerMs);

    const cut = buildTimeline(planScene(cutScene(["act-3"])), bundle);
    expect(cut.cuts).toHaveLength(1);
    expect(cut.cuts[0]).toMatchObject({
      srcStartMs: 9000,
      srcEndMs: cut.sourceDurationMs,
      trailing: true,
    });
  });

  it("says a trailing cut removed nothing when the take ends on its step", () => {
    // The default fixture: act-3's marker IS the take's last frame, so
    // there is no stretch after it. Nothing is removed, and that is said
    // rather than silently reported as a cut that worked.
    const bundle = proceduralBundle();
    const timeline = buildTimeline(planScene(cutScene(["act-3"])), bundle);
    // Premise: the take really does end on the marker.
    expect(timeline.sourceDurationMs).toBe(9000);
    expect(timeline.cuts).toEqual([]);
    expect(timeline.unplacedCuts[0]?.reason).toMatch(/covers no frames/);
  });

  it("removes nothing, and says why, when the closing step has no marker", () => {
    // A partial rebuild that stopped before act-3: act-2's cut can be opened
    // and not closed. Falling back to the end of the take would delete the
    // rest of the video and report a successful cut.
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 400 },
        { actionId: "act-2", sourceTimeMs: 3200 },
      ],
    });
    // Premise: act-3 really is missing from this bundle.
    expect(bundle.markers.some((m) => m.actionId === "act-3")).toBe(false);

    const timeline = buildTimeline(planScene(cutScene(["act-2"])), bundle);
    expect(timeline.cuts).toEqual([]);
    expect(timeline.unplacedCuts).toEqual([
      {
        ids: ["cut-1"],
        reason:
          'these frames carry no marker for "act-3", so where this piece ends is unknown and no frames were removed',
      },
    ]);
    // And the video is the length it was.
    expect(timeline.outputDurationMs).toBeCloseTo(
      buildTimeline(planScene(readonlyScene()), bundle).outputDurationMs,
      6,
    );
  });

  it("removes nothing, and says why, when the cut step itself has no marker", () => {
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 400 },
        { actionId: "act-3", sourceTimeMs: 9000 },
      ],
    });
    expect(bundle.markers.some((m) => m.actionId === "act-2")).toBe(false);
    const timeline = buildTimeline(planScene(cutScene(["act-2"])), bundle);
    expect(timeline.cuts).toEqual([]);
    expect(timeline.unplacedCuts[0]?.reason).toMatch(
      /carry no marker for "act-2"/,
    );
  });

  it("maps a source instant inside a cut onto the seam, both ways", () => {
    // act-1, not act-2: cutting act-2 runs to act-3's marker, which on this
    // fixture IS the take's end, so its seam would sit at the video's end
    // and "clamped to the seam" would be indistinguishable from "clamped to
    // an end" — the two things this case has to tell apart.
    const bundle = proceduralBundle();
    const timeline = buildTimeline(planScene(cutScene(["act-1"])), bundle);
    const seamOutMs = toOutputMs(timeline, 400);
    // Premise: the seam really is in the middle of the video.
    expect(timeline.cuts[0]).toMatchObject({ srcStartMs: 400, srcEndMs: 3200 });
    expect(seamOutMs).toBeGreaterThan(0);
    expect(seamOutMs).toBeLessThan(timeline.outputDurationMs);

    // Everything inside the removed stretch plays at the seam and nowhere
    // else. Without the clamp this walked BACKWARDS off the segment start.
    expect(toOutputMs(timeline, 1500)).toBeCloseTo(seamOutMs, 6);
    expect(toOutputMs(timeline, 3199)).toBeCloseTo(seamOutMs, 6);
    // And no output instant resolves into the removed stretch.
    for (let out = 0; out <= timeline.outputDurationMs; out += 50) {
      const src = toSourceMs(timeline, out);
      expect(src <= 400 || src >= 3200).toBe(true);
    }
  });

  it("ends a trailing-cut video on the last kept frame, not on the take's last", () => {
    const bundle = bundleWithTail();
    const timeline = buildTimeline(planScene(cutScene(["act-3"])), bundle);
    // Premise: the take really does run past the cut's start, or there
    // would be nothing for the end clamp to get wrong.
    expect(timeline.sourceDurationMs).toBeGreaterThan(9000);
    expect(toSourceMs(timeline, timeline.outputDurationMs)).toBeCloseTo(
      9000,
      6,
    );
  });

  it("starts a leading-cut video on the first kept frame", () => {
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 0 },
        { actionId: "act-2", sourceTimeMs: 3200 },
        { actionId: "act-3", sourceTimeMs: 9000 },
      ],
    });
    // Premise: the cut really opens at source zero, which is the case the
    // `outputMs <= 0` clamp gets wrong on its own.
    expect(bundle.markers[0]?.sourceTimeMs).toBe(0);
    const timeline = buildTimeline(planScene(cutScene(["act-1"])), bundle);
    expect(toSourceMs(timeline, 0)).toBeCloseTo(3200, 6);
  });

  it("leaves a take with no cuts byte-identical", () => {
    const bundle = proceduralBundle();
    const plain = buildTimeline(planScene(readonlyScene()), bundle);
    expect(plain.cuts).toEqual([]);
    expect(plain.unplacedCuts).toEqual([]);
    // The two clamps the cut work rewrote are no-ops here, and this is what
    // says so: the first segment opens at 0 and the last closes at the
    // take's own end, so nothing about cuts can change an uncut answer.
    expect(toSourceMs(plain, 0)).toBe(0);
    expect(toSourceMs(plain, plain.outputDurationMs)).toBe(
      plain.sourceDurationMs,
    );
  });
});
