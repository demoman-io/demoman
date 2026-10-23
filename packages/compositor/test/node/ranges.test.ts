import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { markerOutputMs, resolveRange } from "../../src/plan/ranges";
import { buildTimeline, toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const bundle = proceduralBundle();
const timeline = buildTimeline(planScene(readonlyScene()), bundle);
const markerSourceMs = new Map(
  bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
);

describe("markerOutputMs", () => {
  it("is the marker's output instant plus the offset", () => {
    const at = markerOutputMs(
      { actionId: "act-2", offsetMs: 250 },
      timeline,
      markerSourceMs,
    );
    const marker = bundle.markers.find((m) => m.actionId === "act-2");
    expect(at).toBeCloseTo(
      toOutputMs(timeline, marker?.sourceTimeMs ?? 0) + 250,
      6,
    );
  });

  it("is null for a step the bundle has no marker for", () => {
    expect(
      markerOutputMs(
        { actionId: "act-ghost", offsetMs: 0 },
        timeline,
        markerSourceMs,
      ),
    ).toBeNull();
  });
});

describe("resolveRange", () => {
  it("runs the whole take when both ends are null", () => {
    const r = resolveRange({
      id: "t",
      kind: "trim",
      start: null,
      end: null,
      timeline,
      markerSourceMs,
    });
    expect(r).toEqual({
      range: { startMs: 0, endMs: timeline.outputDurationMs },
      unplaced: [],
      clamped: null,
    });
  });

  it("clamps an inverted range to nothing and says so by name", () => {
    const r = resolveRange({
      id: "mask-1",
      kind: "mask",
      start: { actionId: "act-3", offsetMs: 0 },
      end: { actionId: "act-1", offsetMs: 0 },
      timeline,
      markerSourceMs,
    });
    expect(r.range.endMs).toBe(r.range.startMs);
    expect(r.clamped?.id).toBe("mask-1");
    expect(r.clamped?.kind).toBe("mask");
    expect(r.clamped?.note).toMatch(/before it starts/);
  });

  it("reports an unplaced end and falls back to the take's end for it", () => {
    const r = resolveRange({
      id: "z",
      kind: "zoom",
      start: { actionId: "act-2", offsetMs: -350 },
      end: { actionId: "act-ghost", offsetMs: 0 },
      timeline,
      markerSourceMs,
    });
    expect(r.unplaced).toEqual(["end"]);
    expect(r.range.endMs).toBe(timeline.outputDurationMs);
  });

  it("clamps an offset that runs off the take to the take", () => {
    const r = resolveRange({
      id: "t",
      kind: "trim",
      start: { actionId: "act-1", offsetMs: -99_999 },
      end: { actionId: "act-3", offsetMs: 99_999 },
      timeline,
      markerSourceMs,
    });
    expect(r.range).toEqual({ startMs: 0, endMs: timeline.outputDurationMs });
    expect(r.clamped).toBeNull();
  });
});

describe("resolveRange, a range collapsed to exactly zero", () => {
  // F2: `endMs < startMs` let `endMs === startMs` through unreported, and
  // `renderScene`'s `Math.max(1, ...)` then rendered one frame and returned
  // non-empty bytes — nothing-drawn indistinguishable from working over an
  // empty region, the case this module's own docblock exists to refuse.
  it("reports two markers that resolve to the same instant", () => {
    const r = resolveRange({
      id: "mask-2",
      kind: "mask",
      start: { actionId: "act-2", offsetMs: 0 },
      end: { actionId: "act-2", offsetMs: 0 },
      timeline,
      markerSourceMs,
    });
    expect(r.range.endMs).toBe(r.range.startMs);
    expect(r.clamped?.id).toBe("mask-2");
    expect(r.clamped?.kind).toBe("mask");
    expect(r.clamped?.note).toMatch(/same instant/);
  });

  it("reports a trim whose two sides both saturate at the take's end", () => {
    // The Rebuild-shortens-the-take case: both markers' `toOutputMs` run
    // past the new duration and clamp to it, so no inversion is left to see.
    const r = resolveRange({
      id: "trim",
      kind: "trim",
      start: { actionId: "act-3", offsetMs: 99_999 },
      end: { actionId: "act-3", offsetMs: 199_999 },
      timeline,
      markerSourceMs,
    });
    expect(r.range).toEqual({
      startMs: timeline.outputDurationMs,
      endMs: timeline.outputDurationMs,
    });
    expect(r.clamped?.note).toMatch(/same instant/);
  });
});

describe("resolveRange on a take with no duration", () => {
  // A take whose output axis is zero long makes EVERY range zero long, and
  // that is not a collapse — nothing was cut, there is simply no take. The
  // first cut of F2's `<=` reported it as one, which turned
  // `apps/runner`'s missing-keyframe case into "the trim covers nothing"
  // and hid the fault that actually mattered. A reason that fires whether or
  // not anything is wrong is the shape CLAUDE.md names.
  const empty = { ...timeline, outputDurationMs: 0 };

  it("says nothing about an unauthored range", () => {
    const r = resolveRange({
      id: "trim",
      kind: "trim",
      start: null,
      end: null,
      timeline: empty,
      markerSourceMs,
    });
    expect(r.range).toEqual({ startMs: 0, endMs: 0 });
    expect(r.clamped).toBeNull();
  });

  it("still reports an authored side that collapsed onto the other", () => {
    const r = resolveRange({
      id: "trim",
      kind: "trim",
      start: { actionId: "act-2", offsetMs: 0 },
      end: null,
      timeline: empty,
      markerSourceMs,
    });
    expect(r.clamped?.note).toMatch(/same instant/);
  });
});
