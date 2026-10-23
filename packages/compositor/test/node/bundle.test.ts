import { describe, expect, it } from "vitest";
import {
  coversViewport,
  type FrameBundle,
  isRealTime,
  servingMotionSpan,
  validateBundle,
} from "../../src/bundle";

function minimalBundle(): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-1",
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0.png",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 1000,
        ref: "k1.png",
        width: 3840,
        height: 2400,
        actionId: "act-1",
      },
    ],
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 100, y: 100 },
      { sourceTimeMs: 500, x: 400, y: 300 },
    ],
    cursorGaps: [],
    anchorRects: [
      {
        actionId: "act-1",
        anchorId: "a-checkout",
        rect: { x: 980, y: 620, width: 160, height: 44 },
      },
    ],
    markers: [{ actionId: "act-1", sourceTimeMs: 1000 }],
    degradations: [],
  };
}

describe("validateBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(validateBundle(minimalBundle()).sceneId).toBe("scene-1");
  });

  it("rejects an unknown bundle version", () => {
    expect(() =>
      validateBundle({ ...minimalBundle(), bundleVersion: 2 }),
    ).toThrow();
  });

  it("requires at least one keyframe", () => {
    expect(() => validateBundle({ ...minimalBundle(), keyframes: [] })).toThrow(
      /at least one keyframe/,
    );
  });

  it("rejects keyframes that are not in ascending time order", () => {
    const bundle = minimalBundle();
    const [a, b] = bundle.keyframes;
    bundle.keyframes = [b as never, a as never];
    expect(() => validateBundle(bundle)).toThrow(/ascending/);
  });

  it("rejects cursor samples that are not in ascending time order", () => {
    const bundle = minimalBundle();
    bundle.cursorSamples = [
      { sourceTimeMs: 500, x: 0, y: 0 },
      { sourceTimeMs: 100, x: 0, y: 0 },
    ];
    expect(() => validateBundle(bundle)).toThrow(/ascending/);
  });

  it("rejects a motion span that ends before it starts", () => {
    const bundle = minimalBundle();
    bundle.motionSpans = [
      {
        byteLength: 0,
        startMs: 800,
        endMs: 400,
        ref: "m0.mp4",
        width: 2560,
        height: 1600,
        fps: 60,
      },
    ];
    expect(() => validateBundle(bundle)).toThrow(/endMs/);
  });

  it("rejects overlapping motion spans", () => {
    const bundle = minimalBundle();
    bundle.motionSpans = [
      {
        byteLength: 0,
        startMs: 0,
        endMs: 500,
        ref: "m0.mp4",
        width: 2560,
        height: 1600,
        fps: 60,
      },
      {
        byteLength: 0,
        startMs: 400,
        endMs: 900,
        ref: "m1.mp4",
        width: 2560,
        height: 1600,
        fps: 60,
      },
    ];
    expect(() => validateBundle(bundle)).toThrow(/overlap/);
  });

  // A mutating scene is frozen frames: replay never ran, so it dispatched
  // nothing. The compositor synthesizes a cursor there instead.
  it("accepts a capture-source bundle with no cursor samples", () => {
    const bundle = minimalBundle();
    bundle.source = "capture";
    bundle.cursorSamples = [];
    bundle.anchorRects = [];
    expect(validateBundle(bundle).source).toBe("capture");
  });

  it("rejects a replay-source bundle with no cursor samples", () => {
    const bundle = minimalBundle();
    bundle.cursorSamples = [];
    expect(() => validateBundle(bundle)).toThrow(/replay bundle/);
  });

  // Spec 2026-09-30 §1: a scroll leaves the pointer where it is, so a take of
  // nothing but scrolls dispatches no path. Its frames are still the take.
  describe("a replay that moved no cursor", () => {
    const step = (actionId: string, kind: string) => ({
      actionId,
      kind,
      anchorId: "a-checkout",
      text: null,
    });
    const sampleless = (madeFrom: FrameBundle["madeFrom"]): FrameBundle => ({
      ...minimalBundle(),
      cursorSamples: [],
      madeFrom,
    });

    it("accepts it when every marked step is a scroll", () => {
      const bundle = sampleless([step("act-1", "scrollTo")]);
      // The premise: a marker exists, and it names the scroll.
      expect(bundle.markers.map((m) => m.actionId)).toEqual(["act-1"]);
      expect(validateBundle(bundle).cursorSamples).toEqual([]);
    });

    it("refuses it when a marked step is one the cursor travels to", () => {
      const bundle = sampleless([step("act-1", "click")]);
      expect(() => validateBundle(bundle)).toThrow(/replay bundle/);
    });

    it("refuses it when a marker names no step in the log", () => {
      const bundle = sampleless([step("act-9", "scrollTo")]);
      expect(() => validateBundle(bundle)).toThrow(/replay bundle/);
    });

    it("refuses it when there is no log to prove the steps by", () => {
      const bundle = sampleless(undefined);
      expect(() => validateBundle(bundle)).toThrow(/replay bundle/);
    });

    // `every` over no markers is true, so without a marker to prove it by the
    // exemption would pass on nothing. The walk never makes such a bundle
    // (it pushes a marker with every rect); the schema must not admit one.
    it("refuses it when there is no marker to prove the exemption by", () => {
      const bundle = {
        ...sampleless([step("act-1", "scrollTo")]),
        markers: [],
      };
      // The premise: the log would prove a scroll if a marker named it.
      expect(bundle.madeFrom?.map((s) => s.kind)).toEqual(["scrollTo"]);
      expect(() => validateBundle(bundle)).toThrow(/replay bundle/);
    });
  });
});

/**
 * The take that produced this: a 1710x840 capture viewport replayed in a
 * 900x640 window. `Page.captureScreenshot` followed the emulation override
 * and returned 5130x2520 keyframes — a clean 3x. `Page.screencastFrame`
 * followed the window's compositor surface and returned 1800x1104, which is
 * the popup's own content area at the display's DPR and is not a scale of
 * the viewport at all. The frames are a crop of the page's top-left corner,
 * and `renderFrame` maps a frame's full extent onto the full viewport rect,
 * so they rendered 1.90x magnified across and 1.52x down for as long as the
 * page was moving.
 */
const HARVESTED = {
  viewport: { width: 1710, height: 840 },
  keyframe: { width: 5130, height: 2520 },
  fromTheSurface: { width: 1800, height: 1104 },
};

describe("coversViewport", () => {
  it("accepts a frame that is a uniform scale of the viewport", () => {
    expect(coversViewport(HARVESTED.keyframe, HARVESTED.viewport)).toBe(true);
    expect(
      coversViewport({ width: 3420, height: 1680 }, HARVESTED.viewport),
    ).toBe(true);
  });

  // The one legitimate source of disagreement, and it must stay inside the
  // tolerance or every span with an odd pixel height would be thrown away.
  it("accepts H.264's even-dimension rounding", () => {
    expect(
      coversViewport({ width: 5130, height: 2524 }, HARVESTED.viewport),
    ).toBe(true);
  });

  it("rejects the frame the window surface produced", () => {
    expect(coversViewport(HARVESTED.fromTheSurface, HARVESTED.viewport)).toBe(
      false,
    );
  });

  it("rejects a frame with no pixels rather than dividing by zero", () => {
    expect(coversViewport({ width: 0, height: 0 }, HARVESTED.viewport)).toBe(
      false,
    );
  });
});

describe("servingMotionSpan and a surface-cropped span", () => {
  function bundleWithSpan(span: {
    width: number;
    height: number;
  }): FrameBundle {
    const bundle = minimalBundle();
    bundle.viewport = HARVESTED.viewport;
    bundle.keyframes = [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0.png",
        width: HARVESTED.keyframe.width,
        height: HARVESTED.keyframe.height,
        actionId: null,
      },
    ];
    bundle.motionSpans = [
      { byteLength: 0, startMs: 100, endMs: 900, ref: "m-0", fps: 60, ...span },
    ];
    return bundle;
  }

  it("serves a span whose frames cover the viewport", () => {
    const bundle = bundleWithSpan({ width: 3420, height: 1680 });
    expect(servingMotionSpan(bundle, 500)?.ref).toBe("m-0");
  });

  // The defect, at the seam where it does its damage. Without the guard this
  // returns the span and the render magnifies a corner of the page.
  it("refuses a span whose frames are of the window surface", () => {
    const bundle = bundleWithSpan(HARVESTED.fromTheSurface);
    expect(servingMotionSpan(bundle, 500)).toBeNull();
  });
});

describe("byteLength on entries", () => {
  it("defaults byteLength to 0 for rows written before it existed", () => {
    const bundle = minimalBundle();
    // Strip the field the way an old row lacks it.
    const stale = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    for (const k of stale.keyframes as Record<string, unknown>[])
      delete k.byteLength;
    const parsed = validateBundle(stale);
    expect(parsed.keyframes[0]?.byteLength).toBe(0);
  });

  it("keeps a byteLength it is given", () => {
    const bundle = minimalBundle();
    bundle.keyframes = bundle.keyframes.map((k, i) =>
      i === 0 ? { ...k, byteLength: 4321 } : k,
    );
    expect(validateBundle(bundle).keyframes[0]?.byteLength).toBe(4321);
  });

  it("refuses a negative byteLength", () => {
    const bundle = minimalBundle();
    bundle.keyframes = bundle.keyframes.map((k, i) =>
      i === 0 ? { ...k, byteLength: -1 } : k,
    );
    expect(() => validateBundle(bundle)).toThrow();
  });

  it("accepts the motionReclaimed degradation kind", () => {
    const bundle = minimalBundle();
    bundle.degradations = [
      { startMs: 0, endMs: 500, kind: "motionReclaimed", note: "reclaimed" },
    ];
    expect(validateBundle(bundle).degradations[0]?.kind).toBe(
      "motionReclaimed",
    );
  });
});

describe("timing", () => {
  it("accepts timing: real on a replay bundle", () => {
    const bundle = { ...minimalBundle(), timing: "real" as const };
    expect(validateBundle(bundle).timing).toBe("real");
  });

  it("refuses timing on a capture bundle", () => {
    const bundle = {
      ...minimalBundle(),
      source: "capture" as const,
      timing: "real" as const,
    };
    expect(() => validateBundle(bundle)).toThrow(/capture bundle is real time/);
  });

  // Byte-identical rendering of every bundle already on disk rests on this:
  // parsing must not invent the field.
  it("leaves a bundle without timing without it", () => {
    expect("timing" in validateBundle(minimalBundle())).toBe(false);
  });

  it("accepts pacedGaps on a real-time replay and refuses them anywhere else", () => {
    const pacedGaps = [{ afterActionId: "a1", durationMs: 1000 }];
    expect(
      validateBundle({ ...minimalBundle(), timing: "real", pacedGaps })
        .pacedGaps,
    ).toEqual(pacedGaps);
    expect(() => validateBundle({ ...minimalBundle(), pacedGaps })).toThrow(
      /pacedGaps needs timing: real/,
    );
  });

  it("accepts a stillFailed degradation", () => {
    const bundle = minimalBundle();
    bundle.degradations = [
      { startMs: 5, endMs: 5, kind: "stillFailed", note: "probe" },
    ];
    expect(validateBundle(bundle).degradations[0]?.kind).toBe("stillFailed");
  });
});

describe("isRealTime", () => {
  it("is true for capture and for a real-time replay, false for a sampled replay", () => {
    expect(isRealTime({ source: "capture" })).toBe(true);
    expect(isRealTime({ source: "replay", timing: "real" })).toBe(true);
    expect(isRealTime({ source: "replay" })).toBe(false);
  });
});
