import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAMERA_DEFAULTS,
  LANDSCAPE_1080P,
  motionTimings,
  planScene,
  resolvePlan,
} from "@demoman/compositor";
import { MOTION_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createFileFrameStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { renderToFiles } from "../src/render.js";
import { sampleMp4 } from "./mp4-probe.js";
import { fillJpeg, keyframeOnlyBundle } from "./render-small.js";

// The record is final (author's ruling 2026-11-28): the renderer draws a
// zoom's recorded `arrives` and never decides over it. Before, a recorded
// return the take's gap had no room for was drawn as a pan; it is now drawn
// as a return squeezed into that gap. This is that change, on decoded frames.
//
// Two renders of one take, two zooms 2.2 s apart (the clock pans between
// them: a return needs 2725 ms at the default smoothness), differing only
// in the second zoom's record: "pan" is the control, and the picture the
// old renderer drew for "return" too.
//
// Two renders at 640x360; the compare lane's 320x180 film takes 3.5 s
// here and up to 25 s on a macOS runner (`compare-measure.test.ts`).
const RENDER_MS = 60_000;
const SMALL = { ...LANDSCAPE_1080P, width: 640, height: 360, fps: 30 };
/** A corner of the frame: the backdrop at full frame, the app zoomed in. */
const CORNER: [number, number] = [0.03, 0.03];
/** Where the second zoom's step lands, in source and output ms: near
 *  enough to the first (400) that the clock pans, far enough that a
 *  squeezed return still lands after the first zoom has arrived. */
const SECOND_MS = 2600;
/** Frames large enough to back the zoom: the detail clamp keeps a take
 *  whose frames are smaller than the zoom draws them at full frame. */
const FRAME = { width: 1280, height: 800 };

/** Two zooms on the viewport's centre, so zoomed in the app fills the frame. */
function take(second: "pan" | "return"): SceneDocument {
  const zoom = (id: string, actionId: string) => ({
    id,
    kind: "zoom" as const,
    point: { x: 640, y: 400 },
    marker: { actionId, offsetMs: CAMERA_DEFAULTS.leadInMs },
    scale: 1.8,
  });
  const scene = readonlyScene();
  return {
    ...scene,
    // The step's own time paces the take, so it moves with the marker.
    actions: scene.actions.map((a) =>
      a.id === "act-2" ? { ...a, timestamp: SECOND_MS } : a,
    ),
    camera: [
      { ...zoom("z1", "act-1"), arrives: "return" },
      { ...zoom("z2", "act-2"), arrives: second },
    ],
  };
}

let dir: string;
const corner = new Map<string, [number, number, number]>();
let atSec = 0;
let decided: string | undefined;
/** The return render's camera keys, as evidence for a red run. */
let keys = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "demoman-camera-record-"));
  const launched = await launch({ headless: true });
  try {
    const store = createFileFrameStore(dir);
    // The app is black, so a zoomed frame is black to its corners.
    const black = await fillJpeg(launched.page, "#000000", FRAME);
    const base = await keyframeOnlyBundle(store, take("return"));
    const at = (actionId: string | null, ms: number) =>
      actionId === "act-2" ? SECOND_MS : ms;
    const bundle = {
      ...base,
      keyframes: await Promise.all(
        base.keyframes.map(async (k, i) => ({
          ...k,
          sourceTimeMs: at(k.actionId, k.sourceTimeMs),
          ...FRAME,
          ref: await store.putKeyframe(base.sceneId, 50 + i, black),
        })),
      ),
      // Zoomed, the camera trails the pointer (`solveFollow`): held at the
      // zooms' centre, the corner reads the zoom alone.
      cursorSamples: base.cursorSamples.map((c) => ({ ...c, x: 640, y: 400 })),
      markers: base.markers.map((m) => ({
        ...m,
        sourceTimeMs: at(m.actionId, m.sourceTimeMs),
      })),
    };
    const returned = take("return");
    const plan = resolvePlan(planScene(returned), bundle, returned);
    decided = plan.cameraDecided.get("z2");
    keys = JSON.stringify(
      plan.cameraKeys.map((k) => [k.outputTimeMs, k.scale, k.transitionMs]),
    );
    // Read at the middle of the squeezed return's plateau at full frame:
    // the pull-out lands where the second push-in must set off, a plateau
    // before it (`insertNeutralKeys`' `latestMs`), and holds that plateau.
    // From the rule, not the keys, so a renderer that draws a pan instead is
    // read at the same instant.
    const { minPlateauMs } = CAMERA_DEFAULTS.neutral;
    const landsMs =
      SECOND_MS +
      CAMERA_DEFAULTS.leadInMs -
      motionTimings(MOTION_DEFAULTS.smoothness).zoomInMs -
      minPlateauMs;
    atSec = (landsMs + minPlateauMs / 2) / 1000;
    for (const second of ["pan", "return"] as const) {
      const scene = take(second);
      const rendered = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: launched.page,
        target: SMALL,
        fileType: "mp4",
        logo: null,
      });
      const bytes = rendered.files[0]?.bytes;
      if (bytes === undefined) throw new Error("the render produced no file");
      const read = await sampleMp4(bytes, {
        colors: [],
        blockPoints: [CORNER],
        atSecs: [atSec],
      });
      const block = read.readings[0]?.blocks[0];
      if (block === undefined)
        throw new Error(`no reading at ${atSec}s: ${JSON.stringify(read)}`);
      corner.set(second, block);
    }
  } finally {
    await launched.close();
  }
}, RENDER_MS);

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const brightness = ([r, g, b]: [number, number, number]) => (r + g + b) / 3;

describe("a recorded return the gap has no room for", () => {
  // Premise: this is the take the change is about. Decided on its own
  // timing, the second zoom is a pan (the clock's answer, which the old
  // renderer drew over the record), so the record and the timing disagree.
  it("is one the take's timing decides as a pan", () => {
    expect(decided, keys).toBe("pan");
  });

  // Premise: the control is zoomed in at the instant read, so the corner
  // is the app's black. Without this a render that never zoomed would pass.
  it("pans in the control: the corner is the app, zoomed in", () => {
    const pan = corner.get("pan");
    expect(pan, `at ${atSec}s`).toBeDefined();
    expect(
      brightness(pan as [number, number, number]),
      `${pan} at ${atSec}s, keys ${keys}`,
    ).toBeLessThan(40);
  });

  // Red if `arrivesOf` puts back its `!fits` override: the return would be
  // drawn as the pan, and its corner would read black like the control's.
  it("is drawn as a return: the corner is the backdrop, at full frame", () => {
    const returned = corner.get("return");
    expect(returned, `at ${atSec}s`).toBeDefined();
    expect(
      brightness(returned as [number, number, number]),
      `${returned} at ${atSec}s (the control read ${corner.get("pan")}), keys ${keys}`,
    ).toBeGreaterThan(180);
  });
});
