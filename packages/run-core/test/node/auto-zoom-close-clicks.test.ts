import {
  planScene,
  resolvePlan,
  sampleCamera,
  toOutputMs,
} from "@demoman/compositor";
import {
  MOTION_DEFAULTS,
  type SceneDocument,
  SceneDocumentSchema,
  type SceneZoomSkipped,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import { zoomSkippedNote, zoomsForClicks } from "../../src/auto-zoom.js";
import { MIN_ZOOM_GAP_MS } from "../../src/zoom-defaults.js";

/**
 * The author's decision of 2026-10-09: a zoom on every click, and between
 * clicks too close to return to full frame the camera glides from one zoom
 * straight to the next. A glide is only worth having if the camera is
 * settled on each click it passes through, so this asks the rendered camera
 * — the zooms `zoomsForClicks` writes, solved by `resolvePlan` — where it is
 * at each click's own video instant.
 */
describe("zooms on clicks too close to return between", () => {
  const RECTS = [
    { x: 120, y: 100, width: 140, height: 40 },
    { x: 900, y: 360, width: 160, height: 44 },
    { x: 300, y: 620, width: 120, height: 40 },
  ];
  const centre = (r: (typeof RECTS)[number]) => ({
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
  });

  function take(AT: number[]): {
    scene: SceneDocument;
    bundle: ReturnType<typeof framesOf>;
  } {
    const base = takeOf(["click", "click", "click"]);
    const actions = base.actions.map((a, i) => ({
      ...a,
      timestamp: AT[i] as number,
    }));
    const { camera } = zoomsForClicks(actions, base.meta.capture.viewport);
    // Follow off: these takes carry no pointer, so the drawn one is
    // synthesized between the clicks and the follow-cam would pan after it;
    // this measures where the zooms themselves put the camera.
    const scene = {
      ...base,
      actions,
      camera,
      motion: { ...MOTION_DEFAULTS, follow: false },
    };
    const bundle = framesOf({
      markers: actions.map((a, i) => ({
        actionId: a.id,
        sourceTimeMs: AT[i] as number,
      })),
      anchorRects: actions.map((a, i) => ({
        actionId: a.id,
        anchorId: a.anchorId as string,
        rect: RECTS[i] as (typeof RECTS)[number],
      })),
    });
    return { scene, bundle };
  }

  // 2s apart: red on the room rule, which made one zoom here (the second
  // and third clicks fell inside its ~4s), so the camera at clicks two and
  // three was pulling out or at full frame. At `MIN_ZOOM_GAP_MS` apart, the
  // closest pair auto-zoom makes: red, too, without the compositor's settled
  // glide — one that kept the push-in's full 1300ms left 650ms before the
  // click it was leaving, so the camera was already moving at that click.
  it.each([
    ["2s apart", [1_000, 3_000, 5_000]],
    [
      "MIN_ZOOM_GAP_MS apart",
      [1_000, 1_000 + MIN_ZOOM_GAP_MS, 1_000 + 2 * MIN_ZOOM_GAP_MS],
    ],
  ])("is settled on each click's zoom at that click, %s", (_, AT) => {
    const { scene, bundle } = take(AT);
    // Premises: one zoom per click, at the default scale (the rects fit it),
    // and the clicks are too close for a return — the camera never reaches
    // full frame between them, which is the case being measured.
    expect(scene.camera.map((c) => c.marker.actionId)).toEqual(
      scene.actions.map((a) => a.id),
    );
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const segments = resolved.cameraSegments;
    expect(segments).toHaveLength(3);
    expect(segments[0]?.endMs).toBeCloseTo(segments[1]?.startMs ?? 0, 6);
    expect(segments[1]?.endMs).toBeCloseTo(segments[2]?.startMs ?? 0, 6);

    AT.forEach((sourceMs, i) => {
      const atClick = toOutputMs(resolved.timeline, sourceMs);
      const camera = sampleCamera(resolved.cameraKeys, atClick);
      const want = centre(RECTS[i] as (typeof RECTS)[number]);
      const zoom = scene.camera[i];
      const evidence = `click ${i + 1} at ${atClick}ms: ${JSON.stringify(camera)} vs ${JSON.stringify({ want, scale: zoom?.scale })}`;
      expect(camera.scale, evidence).toBeCloseTo(zoom?.scale ?? 0, 3);
      expect(camera.center.x, evidence).toBeCloseTo(want.x, 1);
      expect(camera.center.y, evidence).toBeCloseTo(want.y, 1);
    });
  });
});

// Nothing in the schema orders action timestamps, so a click can carry one
// earlier than the click before it (two clocks, a retried authored step).
// The gap is a distance either way: a click 40ms before the last zoom is as
// close as one 40ms after it, and one 5s before is not close at all. The
// skip records the signed gap, so the note shows the out-of-order stamp
// rather than hiding it. Red on a signed comparison (the 5s-early click
// skipped) and on a schema that wants a non-negative gap (the parse throws,
// which at Stop lost the take).
describe("clicks whose timestamps run backwards", () => {
  function zoomed(AT: number[]) {
    const base = takeOf(["click", "click"]);
    const actions = base.actions.map((a, i) => ({
      ...a,
      timestamp: AT[i] as number,
    }));
    const zooms = zoomsForClicks(actions, base.meta.capture.viewport);
    const scene = { ...base, actions, ...zooms };
    return { actions, scene, ...zooms };
  }

  it("skips a click 40ms before the last zoom, records the gap as -40, and validates", () => {
    const { actions, scene, camera, zoomsSkipped } = zoomed([1_000, 960]);
    const [a, b] = actions;
    if (!a || !b) throw new Error("fixture: two clicks");
    expect(b.timestamp - a.timestamp).toBe(-40); // guard: runs backwards
    expect(camera.map((c) => c.marker.actionId)).toEqual([a.id]);
    expect(zoomsSkipped).toEqual([
      { actionId: b.id, reason: "tooClose", afterActionId: a.id, gapMs: -40 },
    ]);
    expect(() => SceneDocumentSchema.parse(scene)).not.toThrow();
    expect(zoomSkippedNote(zoomsSkipped[0] as SceneZoomSkipped)).toContain(
      `40ms before ${a.id}`,
    );
  });

  it("zooms a click far enough before the last zoom", () => {
    const { actions, camera, zoomsSkipped } = zoomed([6_000, 1_000]);
    expect(MIN_ZOOM_GAP_MS).toBeLessThan(5_000); // guard: past the gap
    expect(camera.map((c) => c.marker.actionId)).toEqual(
      actions.map((a) => a.id),
    );
    expect(zoomsSkipped).toEqual([]);
  });
});
