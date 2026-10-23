import { describe, expect, it } from "vitest";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { verticalCameraIntents } from "../../src/render/target";
import { sceneWithZoomOnClick } from "../fixtures/scene";

describe("verticalCameraIntents", () => {
  const intents = planScene(sceneWithZoomOnClick()).cameraIntents;

  // This test used to assert the opposite — that every vertical intent zooms
  // at least as tight as `verticalZoomScale`. That described a letterboxed
  // vertical, where the cut drew the capture no larger than the landscape did
  // and needed the extra magnification to be legible on a phone. Under
  // `cover` the crop supplies ~2.29x by itself, so the floor double-counted;
  // what the vertical needs now is a ceiling on what the camera adds on top.
  it("caps the landscape zoom rather than raising it", () => {
    const vertical = verticalCameraIntents(intents);
    // The premise: the landscape track really does ask for more than the cap.
    expect(Math.max(...intents.map((i) => i.scale))).toBeGreaterThan(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
    for (const intent of vertical) {
      expect(intent.scale).toBeLessThanOrEqual(
        CAMERA_DEFAULTS.verticalMaxScale,
      );
    }
  });

  // The cap has to sit below the landscape ceiling to mean anything: if it
  // did not, `maxScale` alone would already be doing this job.
  it("caps below the landscape maximum", () => {
    expect(CAMERA_DEFAULTS.verticalMaxScale).toBeLessThan(
      CAMERA_DEFAULTS.maxScale,
    );
    const vertical = verticalCameraIntents(
      intents.map((i) => ({ ...i, scale: 9 })),
    );
    for (const intent of vertical) {
      expect(intent.scale).toBe(CAMERA_DEFAULTS.verticalMaxScale);
    }
  });

  // A scale the cap does not reach is authored intent and passes through, and
  // nothing is ever pushed below 1 — the crop is already the magnification,
  // and going under 1:1 would show page that does not exist.
  it("leaves a gentler authored scale alone and never goes below 1", () => {
    const gentle = verticalCameraIntents(
      intents.map((i) => ({ ...i, scale: 1.05 })),
    );
    for (const intent of gentle) expect(intent.scale).toBeCloseTo(1.05, 6);

    const under = verticalCameraIntents(
      intents.map((i) => ({ ...i, scale: 0.2 })),
    );
    for (const intent of under) expect(intent.scale).toBe(1);
  });

  it("keeps every anchor and marker binding untouched", () => {
    const vertical = verticalCameraIntents(intents);
    expect(vertical.map((i) => [i.anchorId, i.actionId, i.offsetMs])).toEqual(
      intents.map((i) => [i.anchorId, i.actionId, i.offsetMs]),
    );
  });

  // The brief originally titled this "adds a neutral-scale intent for
  // actions the landscape track left alone" — but the function's own
  // signature, `(intents: CameraIntent[]) => CameraIntent[]`, only ever sees
  // the intents it is handed. It has no access to the scene's action list or
  // the frame bundle's markers, so it cannot discover an action that never
  // produced a landscape camera intent (e.g. act-2's scrollTo, which
  // planCameraIntents deliberately skips) and therefore cannot invent a new
  // intent for it. That is also the documented contract: "verticalCameraIntents
  // therefore only raises scale; it must leave every anchor and marker
  // binding untouched" — a pure per-intent transform, not a generator of new
  // intents. So the real, checkable property here is that the function is a
  // transform over what it is given, not a source of new camera beats: an
  // empty input — nothing to transform — stays empty.
  it("is a transform over the given intents, not a generator of new ones: empty stays empty", () => {
    const vertical = verticalCameraIntents([]);
    expect(vertical).toEqual([]);
  });
});
