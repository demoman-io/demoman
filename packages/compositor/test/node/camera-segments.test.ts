import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  returnsBetween,
  sampleCamera,
  solveCamera,
} from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { buildTimeline, toOutputMs } from "../../src/plan/timeline";
import type { CameraIntent } from "../../src/plan/types";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const bundle = proceduralBundle();
const scene = readonlyScene();
const timeline = buildTimeline(planScene(scene), bundle);
const markerSourceMs = new Map(
  bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
);
const viewport = { width: 1280, height: 800 };
const rectOf = () => ({ x: 980, y: 620, width: 160, height: 44 });
const act = (id: string) => toOutputMs(timeline, markerSourceMs.get(id) ?? 0);

const zoom = (over: Partial<CameraIntent>): CameraIntent => ({
  id: "z",
  kind: "zoom",
  anchorId: null,
  point: { x: 300, y: 500 },
  actionId: "act-2",
  offsetMs: 0,
  scale: 2,
  end: null,
  ...over,
});

describe("solveCamera", () => {
  it("aims a point target at the point itself", () => {
    const { keys } = solveCamera(
      [zoom({})],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    const key = keys.find((k) => k.scale === 2);
    expect(key?.center).toEqual({ x: 300, y: 500 });
  });

  it("describes an un-authored end at the neutral key's own instant", () => {
    const { keys, segments } = solveCamera(
      [zoom({})],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    const neutral = keys.find((k, i) => i > 0 && k.scale === 1);
    expect(segments).toEqual([
      {
        id: "z",
        departMs: act("act-2") - CAMERA_DEFAULTS.zoomInMs,
        startMs: act("act-2"),
        endMs: neutral?.outputTimeMs,
        endAuthored: false,
        endClamped: false,
        endUnplaced: false,
        fitted: null,
      },
    ]);
  });

  // The Zoom lane draws a block from `departMs`; it has to be where the
  // preview starts moving, not where the zoom has landed (author,
  // 2026-10-22: the preview zoomed in before the playhead reached the block).
  it("departs where the camera first leaves full frame, and a pan where it leaves the zoom before", () => {
    const { keys, segments } = solveCamera(
      [
        zoom({ id: "a" }),
        zoom({ id: "b", offsetMs: 500, point: { x: 900, y: 300 } }),
      ],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    const [a, b] = segments;
    // Fixture guard: the second zoom pans on from the first rather than
    // returning between them, and its pan was shortened below `zoomInMs`.
    expect(keys.filter((k) => k.scale === 1)).toHaveLength(2);
    expect(b && b.startMs - b.departMs).toBeLessThan(CAMERA_DEFAULTS.zoomInMs);
    for (const s of [a, b]) {
      if (!s) throw new Error("two segments expected");
      const before = sampleCamera(keys, s.departMs);
      const after = sampleCamera(keys, s.departMs + 50);
      expect(
        after.scale !== before.scale || after.center.x !== before.center.x,
      ).toBe(true);
      expect(sampleCamera(keys, s.departMs - 50)).toEqual(before);
    }
  });

  it("places the return at an authored end", () => {
    const endMs = act("act-2") + 2500;
    const { keys, segments } = solveCamera(
      [zoom({ end: { actionId: "act-2", offsetMs: 2500 } })],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    expect(
      keys.some(
        (k) => k.scale === 1 && Math.abs(k.outputTimeMs - endMs) < 1e-6,
      ),
    ).toBe(true);
    expect(segments[0]).toMatchObject({
      endMs,
      endAuthored: true,
      endClamped: false,
    });
    // Fixture guard: 2500 is not what the compositor would have chosen.
    const { zoomOutMs, neutral } = CAMERA_DEFAULTS;
    expect(endMs).not.toBeCloseTo(
      act("act-2") + neutral.zoomHoldMs + zoomOutMs,
      0,
    );
  });

  it("clamps an authored end that lands before the shortest plateau, and says so", () => {
    const { zoomOutMs, neutral } = CAMERA_DEFAULTS;
    const { segments } = solveCamera(
      [zoom({ end: { actionId: "act-2", offsetMs: 10 } })],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    expect(segments[0]).toMatchObject({
      endMs: act("act-2") + neutral.minPlateauMs + zoomOutMs,
      endAuthored: true,
      endClamped: true,
    });
  });

  it("reports an authored end whose step the bundle has no marker for as unplaced, not as no end at all", () => {
    // Fixture guard: a plain un-authored intent reports endUnplaced: false —
    // otherwise this test could pass by every segment saying `true`.
    const plain = solveCamera(
      [zoom({})],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    expect(plain.segments[0]).toMatchObject({ endUnplaced: false });

    const ghost = solveCamera(
      [zoom({ end: { actionId: "act-ghost", offsetMs: 0 } })],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    expect(ghost.segments[0]).toMatchObject({
      endAuthored: true,
      endUnplaced: true,
      endClamped: false,
    });
    // The unplaced end falls back to the same timing the un-authored case
    // uses — nothing about a dropped end invents its own instant.
    expect(ghost.segments[0]?.endMs).toBe(plain.segments[0]?.endMs);
  });

  it("surfaces a clamped end on the resolved plan by the zoom's id", () => {
    const s = {
      ...scene,
      camera: [
        {
          id: "cam-tight",
          kind: "zoom" as const,
          point: { x: 300, y: 500 },
          marker: { actionId: "act-2", offsetMs: 0 },
          end: { actionId: "act-2", offsetMs: 10 },
          scale: 2,
        },
      ],
    };
    const r = resolvePlan(planScene(s), bundle, s);
    expect(r.cameraSegments.map((c) => c.id)).toEqual(["cam-tight"]);
    expect(r.clampedRanges.map((c) => [c.kind, c.id])).toEqual([
      ["zoom", "cam-tight"],
    ]);
  });
});

describe("solveCamera, endClamped says whether the end actually moved", () => {
  // F7: the two fall-through branches set `endClamped: resolvedAuthored` for
  // ANY resolved authored end rather than testing that the instant moved, so
  // `resolvePlan` emitted "was asked to end at an instant the camera cannot
  // reach … so it returns at Nms instead" for a zoom whose authored end was
  // honoured exactly, and the editor hatched the cap. A flag that fires
  // whether or not anything is wrong is the shape CLAUDE.md names.
  it("is false when a seed at the take's own end is honoured, true when it is cut short", () => {
    // `act-3` sits exactly on `outputDurationMs`, so `atMs` can never exceed
    // the seed and both cases take the no-next-seed branch.
    const honoured = solveCamera(
      [zoom({ actionId: "act-3", end: { actionId: "act-3", offsetMs: 0 } })],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    expect(honoured.segments[0]).toMatchObject({
      endMs: timeline.outputDurationMs,
      endAuthored: true,
      endClamped: false,
    });

    const cutShort = solveCamera(
      [
        zoom({
          actionId: "act-3",
          end: { actionId: "act-3", offsetMs: -1000 },
        }),
      ],
      rectOf,
      timeline,
      markerSourceMs,
      viewport,
    );
    // Same resolved end, because the take has nowhere later to put it — the
    // difference is only whether the author asked for that instant.
    expect(cutShort.segments[0]).toMatchObject({
      endMs: timeline.outputDurationMs,
      endAuthored: true,
      endClamped: true,
    });
  });

  it("is false when a zoom that pans straight into the next one was asked to end exactly there", () => {
    const pair = (endOffsetMs: number) =>
      solveCamera(
        [
          zoom({
            id: "a",
            offsetMs: 0,
            end: { actionId: "act-2", offsetMs: endOffsetMs },
          }),
          zoom({ id: "b", offsetMs: 500 }),
        ],
        rectOf,
        timeline,
        markerSourceMs,
        viewport,
      );

    const honoured = pair(500);
    // Fixture guard: 500ms apart leaves no room to return to full frame
    // (`latestMs < earliestMs`), which is the branch under test. If the two
    // seeds ever drift apart, this lands in the neutral-key branch instead
    // and the assertion below stops saying anything.
    expect(honoured.segments[0]?.endMs).toBe(act("act-2") + 500);
    expect(honoured.segments[0]).toMatchObject({
      endAuthored: true,
      endClamped: false,
    });

    const overrun = pair(200);
    expect(overrun.segments[0]).toMatchObject({
      endMs: act("act-2") + 500,
      endAuthored: true,
      endClamped: true,
    });
  });
});

// Spec 2026-10-22: the replay asks the same rule the camera pans by, so the
// walk never paces a click as a pan the camera renders as a return.
describe("returnsBetween", () => {
  const { zoomInMs, zoomOutMs } = CAMERA_DEFAULTS;
  const room = zoomInMs + zoomOutMs + 2 * CAMERA_DEFAULTS.neutral.minPlateauMs;

  it("pans exactly where returnsBetween says there is no room to return", () => {
    const pair = (gapMs: number) =>
      solveCamera(
        [
          zoom({ id: "a", actionId: "act-1", offsetMs: 0 }),
          zoom({ id: "b", actionId: "act-1", offsetMs: gapMs }),
        ],
        rectOf,
        timeline,
        markerSourceMs,
        viewport,
      ).segments;
    const [a1, b1] = pair(room - 1);
    const [a0, b0] = pair(room);
    // Premise: the two arrivals are the gap apart.
    expect((b1?.startMs ?? 0) - (a1?.startMs ?? 0)).toBe(room - 1);
    expect((b0?.startMs ?? 0) - (a0?.startMs ?? 0)).toBe(room);

    expect(returnsBetween(0, room - 1, { zoomInMs, zoomOutMs })).toBe(false);
    expect(a1?.endMs).toBe(b1?.startMs);
    expect(returnsBetween(0, room, { zoomInMs, zoomOutMs })).toBe(true);
    expect(a0?.endMs).toBeLessThan(b0?.departMs ?? 0);
  });
});
