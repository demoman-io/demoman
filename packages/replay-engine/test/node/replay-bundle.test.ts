import type { FrameBundle } from "@demoman/compositor";
import type { SceneAction } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  buildCaptureBundle,
  chooseActiveBundle,
  decodeBase64,
  jpegSize,
  tagKeyframes,
} from "../../src/index.js";
import { scene as sceneFixture } from "../helpers/replay-scene";

const actions = [
  {
    id: "act-1",
    kind: "click",
    anchorId: "a",
    timestamp: 500,
    marker: "click:a",
  },
  {
    id: "act-2",
    kind: "click",
    anchorId: "b",
    timestamp: 1500,
    marker: "click:b",
  },
] as SceneAction[];

const bundle = (source: "replay" | "capture"): FrameBundle =>
  ({
    bundleVersion: 1,
    sceneId: "s",
    source,
    dpr: 2,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        sourceTimeMs: 0,
        ref: "k",
        width: 1280,
        height: 800,
        actionId: null,
        byteLength: 0,
      },
    ],
    motionSpans: [],
    cursorSamples: source === "replay" ? [{ sourceTimeMs: 0, x: 0, y: 0 }] : [],
    cursorGaps: [],
    anchorRects: [],
    markers: [],
    degradations: [],
  }) as FrameBundle;

describe("tagKeyframes", () => {
  // The capture harvester shoots *after* an action, so the action a shot
  // belongs to is the last one whose timestamp precedes it.
  it("tags a shot with the action it followed", () => {
    const tagged = tagKeyframes(
      [
        { sourceTimeMs: 0, ref: "k-0", width: 100, height: 50, byteLength: 0 },
        {
          sourceTimeMs: 600,
          ref: "k-1",
          width: 100,
          height: 50,
          byteLength: 0,
        },
        {
          sourceTimeMs: 1600,
          ref: "k-2",
          width: 100,
          height: 50,
          byteLength: 0,
        },
      ],
      actions,
    );
    expect(tagged.map((k) => k.actionId)).toEqual([null, "act-1", "act-2"]);
  });

  // Two actions inside the harvester's throttle share one shot. The later
  // one owns it and the earlier gets none, which actionId is nullable for.
  it("gives one shot to the later of two actions it followed", () => {
    const tagged = tagKeyframes(
      [
        {
          sourceTimeMs: 1600,
          ref: "k-0",
          width: 100,
          height: 50,
          byteLength: 0,
        },
      ],
      actions,
    );
    expect(tagged[0]?.actionId).toBe("act-2");
  });
});

describe("chooseActiveBundle", () => {
  it("prefers a complete replay and drops nothing else on the floor", () => {
    expect(
      chooseActiveBundle(bundle("replay"), bundle("capture"), true, "demo")
        ?.source,
    ).toBe("replay");
  });

  // A partial replay stops mid-flow; the capture bundle covers the whole
  // take. Neither is deleted, but the whole one is what gets rendered.
  it("prefers frozen frames over a replay that stopped early", () => {
    expect(
      chooseActiveBundle(bundle("replay"), bundle("capture"), false, "demo")
        ?.source,
    ).toBe("capture");
  });

  it("falls back to a partial replay when there are no frozen frames", () => {
    expect(
      chooseActiveBundle(bundle("replay"), null, false, "demo")?.source,
    ).toBe("replay");
  });

  it("has nothing to offer when neither exists", () => {
    expect(chooseActiveBundle(null, null, false, "demo")).toBeNull();
  });
});

describe("image", () => {
  it("decodes base64 CDP payloads to bytes", () => {
    expect([...decodeBase64("AAEC")]).toEqual([0, 1, 2]);
  });

  // Page.captureScreenshot returns no dimensions, and guessing viewport x dpr
  // would let a surface-capped capture claim a resolution it never had.
  it("reads a JPEG's real size out of its start-of-frame marker", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
      0x03, 0x11, 0x01,
    ]);
    expect(jpegSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it("refuses bytes that are not a JPEG it understands", () => {
    expect(() => jpegSize(new Uint8Array([1, 2, 3]))).toThrow(/JPEG/);
  });
});

describe("buildCaptureBundle", () => {
  it("is frozen frames and nothing else", () => {
    const bundle = buildCaptureBundle(sceneFixture(), [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
      {
        sourceTimeMs: 600,
        ref: "kf:s:1",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
    ]);

    expect(bundle.source).toBe("capture");
    expect(bundle.motionSpans).toEqual([]);
    // No samples: replay never ran, so there is no dispatched path to draw
    // from. SP6 synthesizes there, against capture timestamps.
    expect(bundle.cursorSamples).toEqual([]);
    // No anchor rects on purpose: SP6 falls back to the fingerprint's
    // capture-time rect, which is exactly right for a frozen frame.
    expect(bundle.anchorRects).toEqual([]);
    expect(bundle.dpr).toBe(2);
  });

  // The shots are the take's own frames, carried through unchanged: the
  // refs the store handed back and the sizes the JPEGs actually declared,
  // tagged with the action each one followed.
  it("carries the shots it was given", () => {
    const bundle = buildCaptureBundle(sceneFixture(), [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
      {
        sourceTimeMs: 600,
        ref: "kf:s:1",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
      {
        sourceTimeMs: 1200,
        ref: "kf:s:2",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
    ]);
    expect(bundle.keyframes).toEqual([
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 2560,
        height: 1600,
        actionId: "act-1",
        byteLength: 0,
      },
      {
        sourceTimeMs: 600,
        ref: "kf:s:1",
        width: 2560,
        height: 1600,
        actionId: "act-1",
        byteLength: 0,
      },
      {
        sourceTimeMs: 1200,
        ref: "kf:s:2",
        width: 2560,
        height: 1600,
        actionId: "act-2",
        byteLength: 0,
      },
    ]);
    expect(bundle.sceneId).toBe(sceneFixture().meta.id);
    expect(bundle.viewport).toEqual(sceneFixture().meta.capture.viewport);
  });

  // The number a compositor stretches these frames to is the take's recorded
  // viewport, and the debugger infobar shrinks the page after that number is
  // measured. The bundle records what the pixels say instead of repeating the
  // claim: a 2560x1530 frame at DPR 2 was taken through a 1280x765 viewport,
  // whatever `meta.capture` says.
  it("records the viewport its own frames were taken through", () => {
    const bundle = buildCaptureBundle(sceneFixture(), [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 2560,
        height: 1530,
        byteLength: 0,
      },
      {
        sourceTimeMs: 600,
        ref: "kf:s:1",
        width: 2560,
        height: 1530,
        byteLength: 0,
      },
    ]);
    expect(sceneFixture().meta.capture.viewport).toEqual({
      width: 1280,
      height: 800,
    });
    expect(bundle.viewport).toEqual({ width: 1280, height: 765 });
  });

  // Measured, not assumed: with no device-metrics override — which the
  // harvester never sends — real Chromium returns CSS pixels from
  // captureScreenshot whatever devicePixelRatio says. A 1280x765 frame at DPR
  // 2 is a 1280x765 viewport, and dividing by the DPR would have called it
  // 640x383.
  it("reads unscaled frames at their own size, not divided by the DPR", () => {
    const doc = sceneFixture();
    expect(doc.meta.capture.dpr).toBe(2);
    const bundle = buildCaptureBundle(doc, [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 1280,
        height: 765,
        byteLength: 0,
      },
    ]);
    expect(bundle.viewport).toEqual({ width: 1280, height: 765 });
  });

  // The opening shot can race the reflow the infobar causes; the closing one,
  // taken at Stop, cannot. So the last frame is the one believed.
  it("believes the closing frame over the opening one", () => {
    const bundle = buildCaptureBundle(sceneFixture(), [
      {
        sourceTimeMs: 0,
        ref: "kf:s:0",
        width: 2560,
        height: 1600,
        byteLength: 0,
      },
      {
        sourceTimeMs: 600,
        ref: "kf:s:1",
        width: 2560,
        height: 1530,
        byteLength: 0,
      },
    ]);
    expect(bundle.viewport).toEqual({ width: 1280, height: 765 });
  });

  it("marks each action at the moment the take recorded it", () => {
    const bundle = buildCaptureBundle(sceneFixture(), [
      {
        sourceTimeMs: 600,
        ref: "kf:s:0",
        width: 100,
        height: 50,
        byteLength: 0,
      },
    ]);
    expect(bundle.markers.map((m) => m.actionId)).toEqual(["act-1", "act-2"]);
    // The take's own timestamps, not the shots' — a marker is where the
    // action happened, and the shot after it is a different instant.
    expect(bundle.markers.map((m) => m.sourceTimeMs)).toEqual([0, 900]);
  });

  // A bundle with no keyframes is not a thin bundle, it is an invalid one:
  // SP6's schema refuses it. Better to throw here than to store something
  // the compositor will reject when the author asks for a render.
  it("refuses to build a bundle out of no shots at all", () => {
    expect(() => buildCaptureBundle(sceneFixture(), [])).toThrow(
      /at least one keyframe/,
    );
  });
});
