import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  frameCamera,
  sampleCamera,
} from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { composeForTarget } from "../../src/render/compose-for-target";
import { contentScale } from "../../src/render/presentation";
import { LANDSCAPE_1080P, type RenderTarget } from "../../src/render/target";
import {
  COVER_BUTTON,
  COVER_ROW,
  COVER_TARGET,
  COVER_ZOOM_SCALE,
  coverBundle,
  coverScene,
} from "../fixtures/cover-fit";

type Rect = { x: number; y: number; width: number; height: number };

function compose(target: RenderTarget, rect: Rect = COVER_ROW) {
  const scene = coverScene();
  const bundle = coverBundle(rect);
  return composeForTarget({ plan: planScene(scene), bundle, scene, target });
}

/** The CSS rect of page the frame shows at `outputTimeMs` — the camera
 *  exactly as `renderFrame` draws it (`frameCamera` over `sampleCamera`). */
function shownAt(
  composed: ReturnType<typeof compose>,
  target: RenderTarget,
  outputTimeMs: number,
): Rect & { scale: number } {
  const { frameRect } = composed.presentation;
  const viewport = composed.resolved.plan.viewport;
  const base = contentScale(frameRect, viewport);
  const camera = frameCamera(
    sampleCamera(composed.resolved.cameraKeys, outputTimeMs),
    base,
    frameRect,
    viewport,
    target,
  );
  const k = base * camera.scale;
  const width = frameRect.width / k;
  const height = frameRect.height / k;
  return {
    x: camera.center.x - width / 2,
    y: camera.center.y - height / 2,
    width,
    height,
    scale: camera.scale,
  };
}

/** Mid-plateau: the push-in has arrived and the pull-out has not begun. */
function plateauMs(composed: ReturnType<typeof compose>): number {
  const segment = composed.resolved.cameraSegments[0];
  if (!segment) throw new Error("the zoom has no segment");
  return segment.startMs + 200;
}

const holds = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6;

describe("a zoom in a cover (9:16) render", () => {
  // The premise: the row fits the crop at 1x and not at the vertical cap,
  // and the zoom the take carries is the landscape default. If any of these
  // stops being true the cases below sample nothing.
  it("is a row the crop holds at 1x and cuts at the cap", () => {
    const composed = compose(COVER_TARGET);
    const { frameRect } = composed.presentation;
    const viewport = composed.resolved.plan.viewport;
    const atOne = frameRect.width / contentScale(frameRect, viewport);
    const atCap = atOne / CAMERA_DEFAULTS.verticalMaxScale;
    expect(atOne).toBeCloseTo(450, 6);
    expect(COVER_ROW.width).toBeGreaterThan(atCap);
    expect(COVER_ROW.width).toBeLessThan(atOne);
    expect(coverScene().camera[0]?.scale).toBe(COVER_ZOOM_SCALE);
    expect(COVER_ZOOM_SCALE).toBeGreaterThan(CAMERA_DEFAULTS.verticalMaxScale);
    // Centred, so the follow crop's clamp at the page edges is not what
    // keeps it in or out of frame.
    expect(COVER_ROW.x + COVER_ROW.width / 2).toBe(viewport.width / 2);
  });

  // Red with the fit removed: the plateau sits at the 1.15 cap, which shows
  // 391 CSS px of a 440 px row.
  it("shows the whole clicked row on the zoom's plateau", () => {
    const composed = compose(COVER_TARGET);
    const shown = shownAt(composed, COVER_TARGET, plateauMs(composed));
    expect(
      holds(shown, COVER_ROW),
      `shown ${JSON.stringify(shown)} vs row ${JSON.stringify(COVER_ROW)}`,
    ).toBe(true);
    expect(shown.scale).toBe(1);
  });

  // A zoom fitted all the way to 1 is still a zoom: it keeps its segment on
  // the editor's Zoom lane and its return before the next beat. Red if the
  // camera reads scale 1 as the opening key: no segment, no pull-out.
  it("keeps its segment and its return when fitted to 1", () => {
    const composed = compose(COVER_TARGET);
    expect(composed.resolved.cameraSegments).toHaveLength(1);
    const [segment] = composed.resolved.cameraSegments;
    if (!segment) throw new Error("no segment");
    expect(segment.endMs).toBeLessThan(
      composed.resolved.timeline.outputDurationMs,
    );
    expect(
      composed.resolved.cameraKeys.some(
        (key) => Math.abs(key.outputTimeMs - segment.endMs) < 1e-6,
      ),
      "no key lands at the segment's end",
    ).toBe(true);
  });

  // Controls: the fit only ever lowers a scale that would crop.
  it("keeps the cap for a button the crop holds at the cap", () => {
    const composed = compose(COVER_TARGET, COVER_BUTTON);
    const shown = shownAt(composed, COVER_TARGET, plateauMs(composed));
    expect(shown.scale).toBe(CAMERA_DEFAULTS.verticalMaxScale);
    expect(holds(shown, COVER_BUTTON)).toBe(true);
  });

  it("leaves a landscape (contain) zoom at the scale it carries", () => {
    const target = { ...LANDSCAPE_1080P, width: 1920, height: 1080 };
    const composed = compose(target);
    // No zoom was cut. Not "no violations": the plateau crosses the
    // fixture's 2560px motion span, and a follow-cam glide landing in it
    // reports the upscale there (`clampToSourceDetail`) — true of the
    // picture, and not what this case is about.
    expect(
      composed.violations.filter((v) => v.grantedScale < v.requestedScale),
    ).toEqual([]);
    const shown = shownAt(composed, target, plateauMs(composed));
    expect(shown.scale).toBe(COVER_ZOOM_SCALE);
  });

  // The fit changes what the author's zoom does, so it says so: under the
  // timeline in a 9:16 preview, through `clampedRanges`. Red if the fit
  // narrows silently — the lane still reads the zoom's own scale while the
  // picture is a pan (2026-10-09 review).
  describe("says when it narrowed a zoom", () => {
    const fits = (composed: ReturnType<typeof compose>) =>
      composed.resolved.clampedRanges.filter((c) => c.kind === "zoomFit");

    it("to 1, as a pan", () => {
      const composed = compose(COVER_TARGET);
      // Premise: the plateau is at 1 (the case above).
      expect(shownAt(composed, COVER_TARGET, plateauMs(composed)).scale).toBe(
        1,
      );
      const id = coverScene().camera[0]?.id;
      expect(fits(composed)).toEqual([
        {
          id,
          kind: "zoomFit",
          note: expect.stringContaining("pans to it at 1x"),
        },
      ]);
      // Not an end clamp: the inspector's "the end you set could not be
      // reached" is for those.
      expect(composed.resolved.cameraSegments[0]?.endClamped).toBe(false);
    });

    it("part way, with the scale it got", () => {
      // 370 px plus the margin fits 450 px at 1.07, under the 1.15 cap.
      const rect = {
        ...COVER_ROW,
        x: COVER_ROW.x + (COVER_ROW.width - 370) / 2,
        width: 370,
      };
      const composed = compose(COVER_TARGET, rect);
      const scale = shownAt(composed, COVER_TARGET, plateauMs(composed)).scale;
      // Premise: narrowed, and not to 1.
      expect(scale).toBeGreaterThan(1);
      expect(scale).toBeLessThan(CAMERA_DEFAULTS.verticalMaxScale);
      // The author's 1.8x, not the 1.15x cap it passed through on the way:
      // red before 2026-10-14, when this note read "asked for 1.15x".
      expect(COVER_ZOOM_SCALE).toBe(1.8);
      expect(fits(composed).map((c) => c.note)).toEqual([
        `zoom "${coverScene().camera[0]?.id}" asked for 1.8x, and was narrowed to ${scale}x so its target fits this frame's crop`,
      ]);
      expect(composed.resolved.loweredZooms).toEqual([
        {
          id: coverScene().camera[0]?.id,
          actionId: "act-2",
          asked: 1.8,
          got: scale,
          by: "fit",
        },
      ]);
    });

    it("and is quiet when the zoom kept its scale", () => {
      const landscape = compose({
        ...LANDSCAPE_1080P,
        width: 1920,
        height: 1080,
      });
      expect(fits(landscape)).toEqual([]);
      expect(landscape.resolved.loweredZooms).toEqual([]);
    });
  });

  // The cap is a change to the author's zoom too, and the data says so: a
  // 1.8x zoom on a button the crop holds at the cap plays at 1.15x, and the
  // CLI's export names it (once, for every capped click). It is NOT a note:
  // the editor lists every `clampedRanges` note under the timeline
  // (`lanes.ts`, `notices.push(clamped.note)` for each), and the cap applies
  // to every zoom in a 9:16 frame, so a note would be a notice per click
  // (author, 2026-10-14). So `clampedRanges` is asserted whole: it is the
  // list the editor reads its notes from.
  it("records a zoom the cap alone held as data, with no note for the editor", () => {
    const composed = compose(COVER_TARGET, COVER_BUTTON);
    // Premise: the plateau is at the cap, below the 1.8x the zoom carries.
    expect(shownAt(composed, COVER_TARGET, plateauMs(composed)).scale).toBe(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
    expect(coverScene().camera[0]?.scale).toBe(1.8);
    const id = coverScene().camera[0]?.id;
    expect(composed.resolved.loweredZooms).toEqual([
      { id, actionId: "act-2", asked: 1.8, got: 1.15, by: "cap" },
    ]);
    expect(composed.resolved.clampedRanges).toEqual([]);
  });
});
