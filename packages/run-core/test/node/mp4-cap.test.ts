import {
  autoTarget,
  LANDSCAPE_4K,
  LANDSCAPE_1440P,
  type RenderTarget,
  SHARE_LANDSCAPE,
  SHARE_QUALITY_FLOOR,
  SHARE_VERTICAL,
  VERTICAL_1080,
} from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import type { VideoStep } from "../../src/export/report";
import { nextCapStep } from "../../src/render/mp4-cap";

/** Every step from `start` until the ladder ends, with the target each one
 *  renders at. The guard is the test's own: a ladder that never ends fails
 *  here rather than hanging the lane. */
function ladder(start: RenderTarget, share: RenderTarget) {
  const taken: { target: RenderTarget; step: VideoStep }[] = [];
  let at = start;
  for (let guard = 0; guard < 10; guard++) {
    const next = nextCapStep(at, share);
    if (next === null) return taken;
    taken.push(next);
    at = next.target;
  }
  throw new Error(`the ladder did not end: ${JSON.stringify(taken)}`);
}

describe("nextCapStep", () => {
  // The premises the cases below rest on: a full 4K target is 60 fps and
  // encoded by bitrate, the share target 30 fps at a smaller frame and
  // quality 0.5, above the floor. Without them the order below is untested.
  it("starts from a full target that differs from share in every way a step lowers", () => {
    expect(LANDSCAPE_4K.fps).toBe(60);
    expect(LANDSCAPE_4K.encoder?.quality).toBeUndefined();
    expect(SHARE_LANDSCAPE.fps).toBe(30);
    expect([SHARE_LANDSCAPE.width, SHARE_LANDSCAPE.height]).not.toEqual([
      LANDSCAPE_4K.width,
      LANDSCAPE_4K.height,
    ]);
    expect(SHARE_LANDSCAPE.encoder?.quality).toBe(0.5);
    expect(SHARE_QUALITY_FLOOR).toBe(0.35);
  });

  // Red if the frame or quality is lowered before the frame rate (the
  // author's ruling, 2026-10-18: frame rate first, keep text sharp).
  it("fps first: 60 to 30 at the same frame and encoder, bits per frame kept", () => {
    const next = nextCapStep(LANDSCAPE_4K, SHARE_LANDSCAPE);
    expect(next?.step).toEqual({ kind: "fps", from: 60, to: 30 });
    expect(next?.target).toEqual({
      ...LANDSCAPE_4K,
      fps: 30,
      bitrate: LANDSCAPE_4K.bitrate / 2,
    });
  });

  // Red if a 30 fps full target skips the share step, or lowers quality on
  // a target encoded by bitrate.
  it("then share: the share target's frame and quality in one step", () => {
    const at = { ...LANDSCAPE_4K, fps: 30, bitrate: 20_000_000 };
    const next = nextCapStep(at, SHARE_LANDSCAPE);
    expect(next?.step).toEqual({
      kind: "share",
      from: { width: 3840, height: 2160 },
      to: { width: 2560, height: 1440 },
      quality: 0.5,
    });
    expect(next?.target).toEqual(SHARE_LANDSCAPE);
  });

  // Red if a full target already at the share frame is taken for share: it
  // is encoded by bitrate, and the step to quality 0.5 is what lowers it.
  it("a full target at the share frame still takes the share step", () => {
    const at = { ...LANDSCAPE_1440P, fps: 30, bitrate: 9_000_000 };
    const next = nextCapStep(at, SHARE_LANDSCAPE);
    expect(next?.step).toMatchObject({
      kind: "share",
      from: { width: 2560, height: 1440 },
      to: { width: 2560, height: 1440 },
    });
    expect(next?.target.encoder?.quality).toBe(0.5);
  });

  // Red if the ladder stops at the share target (the floor ruling the
  // author superseded) or lowers the frame below it.
  it("then quality: 0.5 to 0.35 at the share frame", () => {
    const next = nextCapStep(SHARE_LANDSCAPE, SHARE_LANDSCAPE);
    expect(next?.step).toEqual({ kind: "quality", from: 0.5, to: 0.35 });
    expect(next?.target).toEqual({
      ...SHARE_LANDSCAPE,
      encoder: { quality: 0.35 },
    });
  });

  // Red if a step that does not apply is reported, or the ladder goes on
  // below the floor.
  it("skipped steps are not reported, and nothing goes below the floor", () => {
    expect(ladder(SHARE_VERTICAL, SHARE_VERTICAL).map((t) => t.step)).toEqual([
      { kind: "quality", from: 0.5, to: 0.35 },
    ]);
    const floor = { ...SHARE_LANDSCAPE, encoder: { quality: 0.35 } };
    expect(nextCapStep(floor, SHARE_LANDSCAPE)).toBeNull();
  });

  // Red if the ladder can take more than three steps (four renders with
  // the first), or loops.
  it("four renders at most: three steps from a 60 fps 4K full target, then none", () => {
    const taken = ladder(LANDSCAPE_4K, SHARE_LANDSCAPE);
    expect(taken.map((t) => t.step.kind)).toEqual(["fps", "share", "quality"]);
    const last = taken.at(-1)?.target;
    expect([last?.width, last?.height, last?.fps]).toEqual([2560, 1440, 30]);
    expect(last?.encoder?.quality).toBe(0.35);
  });

  it("one step from a share target, then none", () => {
    expect(ladder(SHARE_LANDSCAPE, SHARE_LANDSCAPE)).toHaveLength(1);
  });

  // 9:16: the full target is 1080x1920 at 60 fps, share 720x1280.
  it("9:16 from full: fps, then 720x1280, then quality", () => {
    expect(ladder(VERTICAL_1080, SHARE_VERTICAL).map((t) => t.step)).toEqual([
      { kind: "fps", from: 60, to: 30 },
      {
        kind: "share",
        from: { width: 1080, height: 1920 },
        to: { width: 720, height: 1280 },
        quality: 0.5,
      },
      { kind: "quality", from: 0.5, to: 0.35 },
    ]);
  });

  // Auto: the share frame is re-solved to the recording, so it is what the
  // share step goes to, never the 16:9 preset.
  it("Auto goes to its own re-solved share frame", () => {
    const recording = { width: 1280, height: 900 };
    const full = autoTarget(LANDSCAPE_4K, recording, 0.08);
    const share = autoTarget(SHARE_LANDSCAPE, recording, 0.08);
    // The premise: Auto's share frame is not the 16:9 one.
    expect(share.height).not.toBe(SHARE_LANDSCAPE.height);
    const taken = ladder(full, share);
    expect(taken[1]?.target).toEqual(share);
    expect(taken[1]?.step).toMatchObject({
      to: { width: share.width, height: share.height },
    });
  });
});
