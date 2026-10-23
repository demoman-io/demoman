import { describe, expect, it } from "vitest";
import { easings } from "../../src/easing";
import { rectCenter } from "../../src/geometry";
import {
  CURSOR_DEFAULTS,
  planCursorSegment,
  planCursorSegments,
  sampleSegment,
  segmentDurationMs,
} from "../../src/plan/cursor";
import { readonlyScene, sceneWithNavigationWait } from "../fixtures/scene";

function rectOf(scene = readonlyScene()) {
  return (anchorId: string) =>
    scene.anchors.find((a) => a.id === anchorId)?.fingerprint.boundingRect ??
    null;
}

describe("segmentDurationMs", () => {
  it("clamps short hops up to the floor", () => {
    expect(segmentDurationMs({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(
      CURSOR_DEFAULTS.minDurationMs,
    );
  });

  it("clamps long traversals down to the ceiling", () => {
    expect(segmentDurationMs({ x: 0, y: 0 }, { x: 6000, y: 0 })).toBe(
      CURSOR_DEFAULTS.maxDurationMs,
    );
  });

  it("scales with distance in between", () => {
    const short = segmentDurationMs({ x: 0, y: 0 }, { x: 400, y: 0 });
    const long = segmentDurationMs({ x: 0, y: 0 }, { x: 900, y: 0 });
    expect(long).toBeGreaterThan(short);
  });

  // The author's ruling of 2026-10-07, after watching an agent take: its
  // moves were too fast, and should run at about half that speed. That take's
  // 300-630px moves took 233-334ms under the rule then (180ms + 0.35ms/px,
  // 240-700ms); every term of it doubles. In numbers rather than through
  // CURSOR_DEFAULTS, so that the pace itself is what this pins.
  it("moves at half the pace the author found too fast", () => {
    expect(segmentDurationMs({ x: 0, y: 0 }, { x: 400, y: 0 })).toBe(640);
    expect(segmentDurationMs({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(480);
    expect(segmentDurationMs({ x: 0, y: 0 }, { x: 6000, y: 0 })).toBe(1400);
  });
});

describe("planCursorSegments", () => {
  const scene = readonlyScene();

  it("emits one segment per action the cursor travels to", () => {
    // Premise: the fixture holds a scroll, so "per action" and "per
    // travelling action" differ here.
    expect(scene.actions.map((a) => a.kind)).toEqual([
      "type",
      "scrollTo",
      "click",
    ]);
    const segments = planCursorSegments(scene, rectOf(scene));
    // A scroll is not a cursor stop (film-check spec §1).
    expect(segments).toHaveLength(scene.actions.length - 1);
    expect(segments.map((s) => s.toActionId)).toEqual(["act-1", "act-3"]);
  });

  it("starts the first segment from nowhere in particular", () => {
    const [first] = planCursorSegments(scene, rectOf(scene));
    expect(first?.fromActionId).toBeNull();
  });

  // The invariant that makes inversion meaningful: the cursor is on the
  // anchor when the action fires, so the hover pixels replay harvested and
  // the cursor the compositor draws describe the same moment.
  it("lands each segment exactly on its anchor's centre", () => {
    const segments = planCursorSegments(scene, rectOf(scene));
    for (const segment of segments) {
      const target = rectOf(scene)(
        scene.actions.find((a) => a.id === segment.toActionId)?.anchorId ?? "",
      );
      expect(target).not.toBeNull();
      expect(sampleSegment(segment, 1)).toEqual(rectCenter(target as never));
    }
  });

  it("chains each segment's start to the previous segment's end", () => {
    const segments = planCursorSegments(scene, rectOf(scene));
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.from).toEqual(segments[i - 1]?.to);
    }
  });

  it("dwells longer on a hover-sensitive scene so the hover UI can settle", () => {
    const plain = planCursorSegments(scene, rectOf(scene));
    const hover = planCursorSegments(
      { ...scene, flags: { ...scene.flags, hoverSensitive: true } },
      rectOf(scene),
    );
    expect(hover[0]?.dwellMs).toBe(CURSOR_DEFAULTS.hoverDwellMs);
    expect(plain[0]?.dwellMs).toBe(CURSOR_DEFAULTS.dwellMs);
  });

  it("skips an action whose anchor has no known rect", () => {
    const segments = planCursorSegments(scene, () => null);
    expect(segments).toEqual([]);
  });

  it("bows the path off the straight line so travel does not read as a ruler", () => {
    const segments = planCursorSegments(scene, rectOf(scene));
    // The click: the third action, the second segment (the scroll has none).
    const segment = segments.find((s) => s.toActionId === "act-3");
    if (!segment) throw new Error("expected a segment to the click");
    const mid = sampleSegment(segment, 0.5);
    const straight = {
      x: (segment.from.x + segment.to.x) / 2,
      y: (segment.from.y + segment.to.y) / 2,
    };
    expect(Math.hypot(mid.x - straight.x, mid.y - straight.y)).toBeGreaterThan(
      1,
    );
  });

  it("gathers and settles over the whole move instead of spiking through its middle", () => {
    // Sampled exactly the way replay dispatches it (`pathPointAt`): the
    // segment's own easing, then the curve.
    const segment = planCursorSegment({
      from: { x: 100, y: 600 },
      to: { x: 900, y: 200 },
      index: 0,
      fromActionId: null,
      toActionId: "act-1",
    });
    const steps = 400;
    const points = Array.from({ length: steps + 1 }, (_, i) =>
      sampleSegment(segment, easings[segment.easing](i / steps)),
    );
    const speeds = points
      .slice(1)
      .map((p, i) =>
        Math.hypot(p.x - (points[i]?.x ?? 0), p.y - (points[i]?.y ?? 0)),
      );
    const travelled = speeds.reduce((a, b) => a + b, 0);
    const average = travelled / steps;
    // The premise: a real move of several hundred pixels was planned, so the
    // ratios below are measured on travel rather than on rounding.
    expect(travelled).toBeGreaterThan(800);
    const peak = Math.max(...speeds);
    // easeInOutCubic peaks at ~3x the average (12t^2 meeting its mirror in a
    // spike); minimum jerk is a bell peaking at 1.875x, and the bow adds a
    // little either way.
    expect(peak / average).toBeLessThan(2.2);
    // ...and still starts and ends at rest.
    expect((speeds[0] as number) / average).toBeLessThan(0.01);
    expect((speeds.at(-1) as number) / average).toBeLessThan(0.01);
  });

  it("is deterministic for the same scene", () => {
    expect(planCursorSegments(scene, rectOf(scene))).toEqual(
      planCursorSegments(scene, rectOf(scene)),
    );
  });
});

describe("planCursorSegments and scrolls", () => {
  // The premise: the fixture has a scroll between two travelling steps, with
  // an anchor that has a rect — so the planner COULD make it a waypoint.
  it("does not send the cursor to a scroll's anchor", () => {
    const scene = readonlyScene();
    expect(scene.actions.map((a) => a.kind)).toEqual([
      "type",
      "scrollTo",
      "click",
    ]);
    expect(rectOf(scene)("a-row")).not.toBeNull();

    const segments = planCursorSegments(scene, rectOf(scene));

    expect(segments.map((s) => s.toActionId)).toEqual(["act-1", "act-3"]);
    // The click's move starts where the type left the cursor, not at the row.
    const typeRect = rectOf(scene)("a-search");
    expect(segments[1]?.fromActionId).toBe("act-1");
    expect(segments[1]?.from).toEqual(
      rectCenter(typeRect as NonNullable<typeof typeRect>),
    );
  });
});

describe("planCursorSegments with a nullable anchor", () => {
  // v3: a navigation waitFor carries anchorId: null. It names no element, so
  // it can contribute no waypoint — and the chain must not notice it was
  // ever there.
  const scene = sceneWithNavigationWait();

  it("emits no segment for the null-anchor action", () => {
    // Premise: the fixture carries the null-anchor wait and a scroll.
    expect(scene.actions.map((a) => a.kind)).toEqual([
      "type",
      "waitFor",
      "scrollTo",
      "click",
    ]);
    const segments = planCursorSegments(scene, rectOf(scene));
    // A scroll is not a cursor stop (film-check spec §1).
    expect(segments.map((s) => s.toActionId)).toEqual(["act-1", "act-3"]);
    expect(segments.some((s) => s.toActionId === "act-nav")).toBe(false);
  });

  // The part most likely to break silently: the segment after the skipped
  // action must start from the previous *surviving* segment's endpoint, not
  // teleport back to the entry point or to some default position.
  it("chains the surviving segment after the gap to the prior surviving landing point", () => {
    const withGap = planCursorSegments(scene, rectOf(scene));
    const withoutGap = planCursorSegments(readonlyScene(), rectOf());

    // A scroll is not a cursor stop (film-check spec §1), so the surviving
    // segment after the gap is the click's.
    const clickSegment = withGap.find((s) => s.toActionId === "act-3");
    const expectedClickSegment = withoutGap.find(
      (s) => s.toActionId === "act-3",
    );
    expect(clickSegment?.fromActionId).toBe("act-1");
    expect(expectedClickSegment?.fromActionId).toBe("act-1");
    expect(clickSegment?.from).toEqual(expectedClickSegment?.from);
    // Positive control: the start is the type's landing point, not a default.
    const typeRect = rectOf(scene)("a-search");
    expect(clickSegment?.from).toEqual(
      rectCenter(typeRect as NonNullable<typeof typeRect>),
    );
  });
});
