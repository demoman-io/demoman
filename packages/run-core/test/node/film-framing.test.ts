import {
  composeForTarget,
  contentScale,
  derivePresentation,
  frameCamera,
  outputRectToCss,
  planScene,
  resolvePlan,
  sampleCamera,
  sampleCursor,
  sampleTrack,
  toOutputMs,
  toSourceMs,
  VERTICAL_1080,
} from "@demoman/compositor";
import { MOTION_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import { filmForRun, filmQuality } from "../../src/replay/film.js";

const rect = (x: number, y: number, w = 100, h = 40) => ({
  x,
  y,
  width: w,
  height: h,
});

/**
 * Follow off, for the cases that measure the window a zoom itself frames:
 * these takes carry no pointer, so the drawn one is synthesized, travelling
 * between the clicks, and the follow-cam would pan after it mid-measurement.
 */
const STILL = { ...MOTION_DEFAULTS, follow: false };

/** One click at `r`, marked at 1000ms. */
function oneClickAt(r: ReturnType<typeof rect>) {
  const take = takeOf(["click"]);
  const bundle = framesOf({
    markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
    anchorRects: [{ actionId: "act-1", anchorId: "a1", rect: r }],
  });
  return { take, bundle };
}

function framingOf(take: SceneDocument, bundle: ReturnType<typeof framesOf>) {
  const film = filmQuality(take, bundle);
  if ("unavailable" in film)
    throw new Error(`unavailable: ${film.unavailable}`);
  return film.steps[0];
}

describe("filmQuality: framing", () => {
  it("reads a target well inside the frame as inside", () => {
    const { take, bundle } = oneClickAt(rect(400, 300));
    expect(framingOf(take, bundle)?.framing?.label).toBe("inside");
  });

  // Padding 0 is edge-to-edge: the page's edge is the film's.
  it("reads a target within 24px of the film's edge as atEdge", () => {
    const { take, bundle } = oneClickAt(rect(400, 800 - 40 - 10));
    const edgeToEdge = {
      ...take,
      branding: { ...take.branding, padding: 0 },
    } as SceneDocument;
    expect(framingOf(edgeToEdge, bundle)?.framing?.label).toBe("atEdge");
  });

  // Excalidraw's toolbar, 20px from the page's top, read atEdge on every
  // click (2026-10-21) while the film showed the window frame above it.
  it("reads a target near the page's edge as inside when the film shows padding past it", () => {
    const { take, bundle } = oneClickAt(rect(400, 800 - 40 - 10));
    // The premise: padded, and the whole page in shot, so the target is
    // 10px from the visible page's edge and the film goes on past it.
    expect(take.branding.padding).toBeGreaterThan(0);
    const framing = framingOf(take, bundle)?.framing;
    expect(framing?.visible).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(framing?.label).toBe("inside");
  });

  // A drag is watched at its two points, where it presses and lets go: a
  // drop point the film leaves out is the drag's framing, whatever the start.
  it("frames a drag by its worse point", () => {
    const take = takeOf(["drag"]);
    const start = rect(400, 300);
    take.actions = take.actions.map((a) => ({
      ...a,
      kind: "drag" as const,
      toAnchorId: null,
      to: { by: { x: 0, y: 500 } },
    })) as SceneDocument["actions"];
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
      anchorRects: [{ actionId: "act-1", anchorId: "a1", rect: start }],
    });
    const framing = framingOf(take, bundle)?.framing;
    // The start's point, the rect's centre, is well inside.
    expect(framing?.rect).toEqual({ x: 450, y: 320, width: 0, height: 0 });
    expect(framing?.label).toBe("outOfFrame");
    expect(framing?.end).toEqual({
      label: "outOfFrame",
      rect: { x: 450, y: 820, width: 0, height: 0 },
    });
  });

  // Excalidraw, 2026-10-21: both ends on a canvas the size of the page. Its
  // box is cut off by any zoom; the two spots the drag drew between are not.
  it("frames a drag on a page-sized canvas by its spots, not the canvas", () => {
    const take = takeOf(["click", "drag"]);
    const canvas = { x: 0, y: 0, width: 1280, height: 800 };
    take.actions = take.actions.map((a, i) =>
      i === 1
        ? {
            ...a,
            kind: "drag" as const,
            toAnchorId: "a2",
            fromAt: { x: 0.35, y: 0.35 },
            to: { at: { x: 0.55, y: 0.6 } },
          }
        : a,
    ) as SceneDocument["actions"];
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 1100 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(600, 380) },
        { actionId: "act-2", anchorId: "a2", rect: canvas, end: canvas },
      ],
    });
    // As the padding case above zooms: on the click, held through the drag.
    const zoomed = {
      ...take,
      motion: STILL,
      camera: [
        {
          id: "cam-1",
          kind: "zoom",
          point: { x: 640, y: 400 },
          marker: { actionId: "act-1", offsetMs: 0 },
          scale: 2,
        },
      ],
    } as SceneDocument;
    const film = filmQuality(zoomed, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    const framing = film.steps[1]?.framing;
    // The premise: zoomed, so the canvas's own box is past the visible page.
    expect(framing?.visible.width).toBeLessThan(canvas.width);
    expect(framing?.label, JSON.stringify(framing)).toBe("inside");
  });

  it("reads a target past the bottom edge as cutOff", () => {
    const { take, bundle } = oneClickAt(rect(400, 780));
    expect(framingOf(take, bundle)?.framing?.label).toBe("cutOff");
  });

  it("reads a target below the viewport as outOfFrame", () => {
    const { take, bundle } = oneClickAt(rect(400, 2460));
    expect(framingOf(take, bundle)?.framing?.label).toBe("outOfFrame");
  });

  // Review Focus 3. The camera, not the viewport: while the camera is zoomed
  // on the second click (top-left), the third click's target in the far
  // corner is inside the browser viewport and outside the video.
  it("measures against the camera, so a zoom elsewhere leaves a target out of frame", () => {
    const take = takeOf(["click", "click", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 500 },
        { actionId: "act-2", sourceTimeMs: 1000 },
        { actionId: "act-3", sourceTimeMs: 1300 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(600, 400) },
        { actionId: "act-2", anchorId: "a2", rect: rect(100, 100) },
        { actionId: "act-3", anchorId: "a3", rect: rect(1150, 740) },
      ],
    });
    const zoomed = {
      ...take,
      camera: [
        {
          id: "cam-1",
          kind: "zoom",
          anchorId: "a2",
          marker: { actionId: "act-2", offsetMs: 0 },
          scale: 2.5,
        },
      ],
    } as SceneDocument;
    // The premise: at the third step's video time the camera is still zoomed,
    // and centred far from the third target. If either fails, move act-3
    // closer to act-2 — never loosen the assertion below.
    const resolved = resolvePlan(planScene(zoomed), bundle, zoomed);
    const at3 = toOutputMs(resolved.timeline, 1300);
    const camera = sampleCamera(resolved.cameraKeys, at3);
    expect(camera.scale).toBeGreaterThan(1.5);
    expect(
      Math.hypot(camera.center.x - 1200, camera.center.y - 760),
    ).toBeGreaterThan(400);
    // And without the zoom the same target is in the frame.
    const bare = filmQuality(take, bundle);
    if ("unavailable" in bare) throw new Error(bare.unavailable);
    expect(bare.steps[2]?.framing?.label).not.toBe("outOfFrame");

    const film = filmQuality(zoomed, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    // The premise: the reported visible window does not touch the target.
    const f = film.steps[2]?.framing;
    if (!f) throw new Error("step 3 has no framing");
    const overlapW =
      Math.min(f.rect.x + f.rect.width, f.visible.x + f.visible.width) -
      Math.max(f.rect.x, f.visible.x);
    const overlapH =
      Math.min(f.rect.y + f.rect.height, f.visible.y + f.visible.height) -
      Math.max(f.rect.y, f.visible.y);
    expect(
      overlapW > 0 && overlapH > 0,
      `visible ${JSON.stringify(f.visible)} vs target ${JSON.stringify(f.rect)}`,
    ).toBe(false);
    expect(film.steps[2]?.framing?.label).toBe("outOfFrame");
  });

  // The camera zooms the whole composition, so at 2x the output shows more
  // of the page than the viewport halved: the window grows past the output's
  // edges. A target 440 CSS px left of a centred zoom is in that shot.
  it("measures the shot the scene camera shows, wider than the viewport over the scale", () => {
    const take = takeOf(["click", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 1100 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(600, 380) },
        { actionId: "act-2", anchorId: "a2", rect: rect(250, 380) },
      ],
    });
    const zoomed = {
      ...take,
      motion: STILL,
      camera: [
        {
          id: "cam-1",
          kind: "zoom",
          point: { x: 640, y: 400 },
          marker: { actionId: "act-1", offsetMs: 0 },
          scale: 2,
        },
      ],
    } as SceneDocument;
    const resolved = resolvePlan(planScene(zoomed), bundle, zoomed);
    const camera = sampleCamera(
      resolved.cameraKeys,
      toOutputMs(resolved.timeline, 1100),
    );
    // The premise: still at 2x on the page's centre at the second click,
    // where a viewport-over-the-scale window (x 320..960) misses the target.
    expect(camera.scale).toBeCloseTo(2, 3);
    expect(camera.center).toEqual({ x: 640, y: 400 });
    const naiveLeft =
      camera.center.x - bundle.viewport.width / 2 / camera.scale;
    expect(250, "the target starts left of that window").toBeLessThan(
      naiveLeft,
    );
    const film = filmQuality(zoomed, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    const f = film.steps[1]?.framing;
    // At the default 8% padding the shot starts near x 217, so the target
    // is in it with its edge margin.
    expect(f?.visible.x, JSON.stringify(f?.visible)).toBeLessThan(250 - 24);
    expect(f?.label).toBe("inside");
  });

  // Review Focus 3. A bigger margin shrinks the window, so the same 2x zoom
  // shows more of the page. Red if the check frames every take with one
  // fixed padding instead of the take's own.
  it("measures with the take's own padding", () => {
    const take = takeOf(["click", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 1100 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(600, 380) },
        { actionId: "act-2", anchorId: "a2", rect: rect(200, 380) },
      ],
    });
    const at = (padding: number) => {
      const zoomed = {
        ...take,
        branding: { ...take.branding, padding },
        motion: STILL,
        camera: [
          {
            id: "cam-1",
            kind: "zoom",
            point: { x: 640, y: 400 },
            marker: { actionId: "act-1", offsetMs: 0 },
            scale: 2,
          },
        ],
      } as SceneDocument;
      const film = filmQuality(zoomed, bundle);
      if ("unavailable" in film) throw new Error(film.unavailable);
      const visible = film.steps[1]?.framing?.visible;
      if (!visible) throw new Error("step 2 has no framing");
      return visible;
    };
    const tight = at(0);
    const roomy = at(0.2);
    // Premise: neither shot is cut to the viewport on this axis, or the
    // comparison would read the page's edge rather than the camera.
    expect(roomy.x).toBeGreaterThan(0);
    expect(roomy.width).toBeGreaterThan(tight.width + 50);
  });

  // Spec 2026-10-06 §3. At padding 0 an Auto frame is the recording, so a
  // 2x zoom on the page's centre shows exactly half the viewport; a 16:9
  // frame around the same 16:10 recording also shows its side bars. Red if
  // the check measures every demo against LANDSCAPE_1080P.
  it("measures an Auto demo with the Auto frame", () => {
    const take = takeOf(["click", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 1100 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(600, 380) },
        { actionId: "act-2", anchorId: "a2", rect: rect(600, 380) },
      ],
    });
    const shot = (aspect: "auto" | "16:9") => {
      const doc = {
        ...take,
        canvas: { aspect },
        branding: { ...take.branding, padding: 0 },
        motion: STILL,
        camera: [
          {
            id: "cam-1",
            kind: "zoom",
            point: { x: 640, y: 400 },
            marker: { actionId: "act-1", offsetMs: 0 },
            scale: 2,
          },
        ],
      } as SceneDocument;
      const film = filmQuality(doc, bundle);
      if ("unavailable" in film) throw new Error(film.unavailable);
      const visible = film.steps[1]?.framing?.visible;
      if (!visible) throw new Error("step 2 has no framing");
      return visible;
    };
    // Premise: the frames are 16:10, so 16:9 leaves bars to differ by.
    expect(bundle.viewport).toEqual({ width: 1280, height: 800 });
    expect(shot("auto").width).toBeCloseTo(640, 0);
    expect(shot("16:9").width).toBeGreaterThan(700);
  });

  // Not for a scroll: its anchor can be taller than the frame (spec §2.1).
  it("gives a scroll no framing, even with an anchor taller than the frame", () => {
    const take = takeOf(["scrollTo"]);
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(0, -40, 1280, 909) },
      ],
    });
    const step = framingOf(take, bundle);
    expect(step?.unknown).toBeNull();
    expect(step?.framing).toBeNull();
  });

  // Review Focus 1: a step the film does not show says so.
  it("reports a step with no marker as notInVideo, and a cut step as cut", () => {
    const take = takeOf(["click", "click"]);
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(400, 300) },
      ],
    });
    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    expect(film.steps[1]).toMatchObject({
      actionId: "act-2",
      unknown: "notInVideo",
      framing: null,
    });

    const cut = {
      ...take,
      edits: {
        ...take.edits,
        removed: [
          {
            id: "c1",
            start: { actionId: "act-1", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: 0 },
          },
        ],
      },
    } as SceneDocument;
    // Frames that reach act-2, so the piece removes act-1's stretch.
    const both = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 2000 },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(400, 300) },
      ],
    });
    const cutFilm = filmQuality(cut, both);
    if ("unavailable" in cutFilm) throw new Error(cutFilm.unavailable);
    expect(cutFilm.steps[0]).toMatchObject({ unknown: "cut", framing: null });
    // Review 2026-10-22: in frames with no act-2 the piece removes nothing,
    // so act-1 is still in the film and is not called cut.
    const nowhere = filmQuality(cut, bundle);
    if ("unavailable" in nowhere) throw new Error(nowhere.unavailable);
    expect(nowhere.steps[0]?.unknown).not.toBe("cut");
  });

  it("reports a travelling step with a marker and no rect as noRect", () => {
    const take = takeOf(["click"]);
    const bundle = framesOf({
      markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
    });
    expect(framingOf(take, bundle)).toMatchObject({
      unknown: "noRect",
      framing: null,
    });
  });
});

describe("filmForRun", () => {
  it("says why there is nothing to check", () => {
    const { take, bundle } = oneClickAt(rect(400, 300));
    expect(filmForRun({ refused: true, scene: null, bundle: null })).toEqual({
      unavailable: "refused",
    });
    expect(filmForRun({ refused: false, scene: null, bundle })).toEqual({
      unavailable: "noTake",
    });
    expect(filmForRun({ refused: false, scene: take, bundle: null })).toEqual({
      unavailable: "noFrames",
    });
    expect("steps" in filmForRun({ refused: false, scene: take, bundle })).toBe(
      true,
    );
  });
});

// A phone shows a page with no meta viewport zoomed out (probe:tap-space):
// the take's rects are in the page's own px, and the film is the screen. A
// target at 1500 page px is past a 1280-wide frame as stored, and at 750 on
// a page shown at half scale.
describe("filmQuality on a zoomed-out page", () => {
  it("reads the target where the screen showed it", () => {
    const { take, bundle } = oneClickAt(rect(1500, 300));
    // The premise: as stored, the target is past the frame.
    expect(framingOf(take, bundle)?.framing?.label).toBe("outOfFrame");
    const zoomed = {
      ...bundle,
      viewportTransforms: [
        { sourceTimeMs: 0, scale: 0.5, offsetX: 0, offsetY: 0 },
      ],
    };
    expect(framingOf(take, zoomed)?.framing?.label).toBe("inside");
  });
});

// Spec 2026-10-22: while zoomed, the camera trails the pointer.
describe("filmQuality: a quick run of clicks, the camera trailing", () => {
  const targets = [rect(250, 210), rect(570, 250), rect(880, 400)];
  /** A hand that travels to each target, arriving 300ms before its click,
   *  and rests there. */
  const HAND = [
    { sourceTimeMs: 0, x: 640, y: 700 },
    { sourceTimeMs: 700, x: 300, y: 230 },
    { sourceTimeMs: 1150, x: 300, y: 230 },
    { sourceTimeMs: 1900, x: 620, y: 270 },
    { sourceTimeMs: 2350, x: 620, y: 270 },
    { sourceTimeMs: 3100, x: 930, y: 420 },
    { sourceTimeMs: 9000, x: 930, y: 420 },
  ];
  /** `hand` false keeps the procedural bundle's own pointer, which parks
   *  in the top-left corner far from every target. */
  function quickRun(
    device?: SceneDocument["meta"]["capture"]["device"],
    hand = true,
  ) {
    const take = takeOf(["click", "click", "click"]);
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: 2200 },
        { actionId: "act-3", sourceTimeMs: 3400 },
      ],
      anchorRects: targets.map((r, i) => ({
        actionId: `act-${i + 1}`,
        anchorId: `a${i + 1}`,
        rect: r,
      })),
      ...(hand ? { cursorSamples: HAND } : {}),
    });
    const zoomed = {
      ...take,
      motion: MOTION_DEFAULTS,
      meta: {
        ...take.meta,
        capture: { ...take.meta.capture, ...(device ? { device } : {}) },
      },
      camera: targets.map((_, i) => ({
        id: `cam-${i + 1}`,
        kind: "zoom",
        anchorId: `a${i + 1}`,
        marker: { actionId: `act-${i + 1}`, offsetMs: -350 },
        scale: 2,
      })),
    } as SceneDocument;
    return { take: zoomed, bundle };
  }

  it("frames every click of a quick run inside", () => {
    const { take, bundle } = quickRun();
    const resolved = resolvePlan(planScene(take), bundle, take);
    // Premise: the run pans from zoom to zoom with no return between.
    const segments = resolved.cameraSegments;
    expect(segments).toHaveLength(3);
    for (let i = 0; i + 1 < segments.length; i++) {
      expect(segments[i]?.endMs).toBe(segments[i + 1]?.startMs);
    }
    // Premise: the camera does trail a pointer here, off the zoom's aim.
    const landing = segments[1]?.startMs as number;
    const keysOnly = sampleCamera(resolved.cameraKeys, landing + 400);
    const drawn = sampleTrack(resolved, landing + 400);
    expect(
      Math.hypot(
        drawn.center.x - keysOnly.center.x,
        drawn.center.y - keysOnly.center.y,
      ),
    ).toBeGreaterThan(2);
    const film = filmQuality(take, bundle);
    if ("unavailable" in film) throw new Error(film.unavailable);
    expect(film.steps).toHaveLength(3);
    for (const step of film.steps) {
      expect(["inside", "atEdge"], JSON.stringify(step.framing)).toContain(
        step.framing?.label,
      );
    }
  });

  it("keeps every click of a run in a 9:16 crop", () => {
    const { take, bundle } = quickRun();
    const { resolved } = composeForTarget({
      plan: planScene(take),
      bundle,
      scene: take,
      target: VERTICAL_1080,
    });
    const { frameRect } = derivePresentation(
      take.branding,
      VERTICAL_1080,
      bundle.viewport,
    );
    const base = contentScale(frameRect, bundle.viewport);
    // Premise: the crop is zoomed at the clicks, so it could miss them.
    const at = (ms: number) => toOutputMs(resolved.timeline, ms);
    expect(sampleTrack(resolved, at(2200)).scale).toBeGreaterThan(1);
    for (const [i, ms] of [1000, 2200, 3400].entries()) {
      const camera = frameCamera(
        sampleTrack(resolved, at(ms)),
        base,
        frameRect,
        bundle.viewport,
        VERTICAL_1080,
      );
      const shot = outputRectToCss(
        {
          x: 0,
          y: 0,
          width: VERTICAL_1080.width,
          height: VERTICAL_1080.height,
        },
        camera,
        frameRect,
        bundle.viewport,
      );
      const t = targets[i] as ReturnType<typeof rect>;
      const where = JSON.stringify({ step: i + 1, shot, target: t });
      expect(t.x, where).toBeGreaterThanOrEqual(shot.x);
      expect(t.y, where).toBeGreaterThanOrEqual(shot.y);
      expect(t.x + t.width, where).toBeLessThanOrEqual(shot.x + shot.width);
      expect(t.y + t.height, where).toBeLessThanOrEqual(shot.y + shot.height);
    }
  });

  // Review of 2026-10-22: a hidden cursor is a pointer nobody sees.
  it("follows no pointer the author has hidden", () => {
    const { take, bundle } = quickRun(undefined, false);
    const hidden = {
      ...take,
      cursor: { ...take.cursor, hidden: true },
    } as SceneDocument;
    const resolved = resolvePlan(planScene(hidden), bundle, hidden);
    const [, second] = resolved.cameraKeys.filter((k) => k.scale > 1);
    if (!second) throw new Error("no key for the second zoom");
    // Premise: shown, the same take's camera chases its pointer off the aim.
    const shown = resolvePlan(planScene(take), bundle, take);
    const off = sampleTrack(shown, second.outputTimeMs + 600).center;
    expect(
      Math.hypot(off.x - second.center.x, off.y - second.center.y),
    ).toBeGreaterThan(100);
    const later = sampleTrack(resolved, second.outputTimeMs + 600).center;
    expect(
      Math.hypot(later.x - second.center.x, later.y - second.center.y),
    ).toBeLessThan(2);
  });

  // Review of 2026-10-22: only a drag with a zoom of its own holds the
  // camera on that zoom's aim. One without (too wide, too close) is pressed
  // inside the click's zoom, and the camera follows the hand through it.
  it("follows the hand through a drag that has no zoom of its own", () => {
    const take = takeOf(["click", "drag"]);
    const dragAt = 1600;
    const bundle = framesOf({
      markers: [
        { actionId: "act-1", sourceTimeMs: 1000 },
        { actionId: "act-2", sourceTimeMs: dragAt },
      ],
      anchorRects: [
        { actionId: "act-1", anchorId: "a1", rect: rect(250, 210) },
        { actionId: "act-2", anchorId: "a2", rect: rect(300, 300) },
      ],
      heldPresses: [
        { actionId: "act-2", pressMs: dragAt, releaseMs: dragAt + 700 },
      ],
      cursorSamples: [
        { sourceTimeMs: 0, x: 300, y: 230 },
        { sourceTimeMs: dragAt, x: 300, y: 230 },
        { sourceTimeMs: dragAt + 700, x: 700, y: 500 },
        { sourceTimeMs: 9000, x: 700, y: 500 },
      ],
    });
    const zoomed = {
      ...take,
      motion: MOTION_DEFAULTS,
      camera: [
        {
          id: "cam-1",
          kind: "zoom",
          anchorId: "a1",
          marker: { actionId: "act-1", offsetMs: -350 },
          // Out well after the release, so the zoom is held through the drag.
          end: { actionId: "act-2", offsetMs: 3000 },
          scale: 2,
        },
      ],
    } as SceneDocument;
    const resolved = resolvePlan(planScene(zoomed), bundle, zoomed);
    const aim = resolved.cameraKeys.find((k) => k.scale > 1);
    if (!aim) throw new Error("no zoom key");
    const [hold] = resolved.holdOutputMs;
    if (!hold) throw new Error("the drag has no held press");
    const release = hold.endMs;
    // Premise: the drag is held inside the click's zoom, and has no zoom.
    expect(resolved.holdOutputMs).toHaveLength(1);
    expect(sampleTrack(resolved, release).scale).toBeGreaterThan(1.5);
    expect(zoomed.camera.map((c) => c.marker.actionId)).toEqual(["act-1"]);
    const hand = sampleCursor(
      resolved.cursor,
      toSourceMs(resolved.timeline, release),
    );
    expect(
      hand && Math.hypot(hand.x - aim.center.x, hand.y - aim.center.y),
    ).toBeGreaterThan(200);
    const at = sampleTrack(resolved, release).center;
    expect(
      Math.hypot(at.x - aim.center.x, at.y - aim.center.y),
      JSON.stringify({ at, aim: aim.center }),
    ).toBeGreaterThan(100);
  });

  it("follows no pointer on a touch take", () => {
    const phone = {
      preset: "phone" as const,
      width: 1280,
      height: 800,
      mobile: true,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone; test)",
    };
    const { take, bundle } = quickRun(phone, false);
    const resolved = resolvePlan(planScene(take), bundle, take);
    expect(resolved.touch).toBe(true);
    const [first, second] = resolved.cameraKeys.filter((k) => k.scale > 1);
    if (!first || !second) throw new Error("no keys for the zooms");
    // Premise: the same take as a desktop take does chase its pointer, which
    // parks far from the aims.
    const desktop = quickRun(undefined, false);
    const desk = resolvePlan(
      planScene(desktop.take),
      desktop.bundle,
      desktop.take,
    );
    const off = sampleTrack(desk, second.outputTimeMs + 600).center;
    expect(
      Math.hypot(off.x - second.center.x, off.y - second.center.y),
    ).toBeGreaterThan(100);
    expect(sampleTrack(resolved, first.outputTimeMs)).toEqual(
      sampleCamera(resolved.cameraKeys, first.outputTimeMs),
    );
    const later = sampleTrack(resolved, second.outputTimeMs + 600).center;
    expect(
      Math.hypot(later.x - second.center.x, later.y - second.center.y),
    ).toBeLessThan(2);
  });
});
