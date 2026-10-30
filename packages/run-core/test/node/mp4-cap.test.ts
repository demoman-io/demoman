import {
  autoTarget,
  LANDSCAPE_4K,
  LANDSCAPE_1440P,
  type RenderTarget,
  SHARE_LANDSCAPE,
  SHARE_VERTICAL,
  VERTICAL_1080,
} from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  capLadder,
  fitBitrate,
  fitRetry,
  HEADROOM,
} from "../../src/render/mp4-cap";

/** The floor frame: the share look at the 1080p tier's frame, as
 *  `targetFor(…, { maxTier: LANDSCAPE_1080P, quality: "share" })` gives. */
const FLOOR: RenderTarget = {
  ...SHARE_LANDSCAPE,
  width: 1920,
  height: 1080,
};
const FIT = { bitrate: 2_000_000, durationMs: 30_000 };
const kinds = (asked: RenderTarget, share: RenderTarget, floor: RenderTarget) =>
  capLadder(asked, { share, floor }, FIT).map((r) => r.step.kind);

describe("capLadder", () => {
  // The premises the cases below rest on: a full 4K target is 60 fps and
  // encoded by bitrate, the share target 30 fps at 2560 and quality 0.5,
  // and the floor smaller than share. Without them the order is untested.
  it("starts from a full target that differs from share in every way a rung lowers", () => {
    expect(LANDSCAPE_4K.fps).toBe(60);
    expect(LANDSCAPE_4K.encoder?.quality).toBeUndefined();
    expect(SHARE_LANDSCAPE.fps).toBe(30);
    expect(SHARE_LANDSCAPE.width).toBe(2560);
    expect(SHARE_LANDSCAPE.encoder?.quality).toBe(0.5);
    expect(FLOOR.width).toBeLessThan(SHARE_LANDSCAPE.width);
  });

  // Red if HEADROOM drifts from the measured 0.92 or the bytes are not
  // turned into bits over the seconds.
  it("fitBitrate is maxBytes × 0.92 × 8 over the seconds", () => {
    expect(HEADROOM).toBe(0.92);
    expect(fitBitrate(9_500_000, 30_000)).toBe(2_330_667);
  });

  // Red if any rung is skipped or reordered (the author's ruling,
  // 2026-10-18: frame rate first, keep text sharp; 2026-10-29: the floor
  // is the share look at 1920, then fit).
  it("from 60 fps 4K full: fps, share, frame, fit", () => {
    const ladder = capLadder(
      LANDSCAPE_4K,
      { share: SHARE_LANDSCAPE, floor: FLOOR },
      FIT,
    );
    expect(ladder.map((r) => r.step)).toEqual([
      { kind: "fps", from: 60, to: 30 },
      {
        kind: "share",
        from: { width: 3840, height: 2160 },
        to: { width: 2560, height: 1440 },
        quality: 0.5,
      },
      {
        kind: "frame",
        from: { width: 2560, height: 1440 },
        to: { width: 1920, height: 1080 },
      },
      { kind: "fit", bitrate: 2_000_000, durationMs: 30_000 },
    ]);
    expect(ladder[0]?.target).toEqual({
      ...LANDSCAPE_4K,
      fps: 30,
      bitrate: LANDSCAPE_4K.bitrate / 2,
    });
    expect(ladder[2]?.target).toEqual(FLOOR);
    const fit = ladder.at(-1)?.target;
    expect([fit?.width, fit?.height, fit?.fps, fit?.bitrate]).toEqual([
      1920, 1080, 30, 2_000_000,
    ]);
    // Encoded by bitrate: a quality left on would ignore the budget.
    expect(fit?.encoder?.quality).toBeUndefined();
  });

  // Red if a full target already at the share frame skips the share rung:
  // it is encoded by bitrate, and quality 0.5 is what lowers it.
  it("a full target at the share frame still takes the share rung", () => {
    const at = { ...LANDSCAPE_1440P, fps: 30, bitrate: 9_000_000 };
    expect(kinds(at, SHARE_LANDSCAPE, FLOOR)).toEqual([
      "share",
      "frame",
      "fit",
    ]);
  });

  it("from the share target: frame, fit", () => {
    expect(kinds(SHARE_LANDSCAPE, SHARE_LANDSCAPE, FLOOR)).toEqual([
      "frame",
      "fit",
    ]);
  });

  // Red if a frame rung is reported where the frame does not change.
  it("share already 1920 (keyframes back only 1080p): fit alone", () => {
    expect(kinds(FLOOR, FLOOR, FLOOR)).toEqual(["fit"]);
  });

  // 9:16: the full target is 1080x1920 at 60 fps; share and floor are both
  // 720x1280.
  it("9:16 from full: fps, share to 720×1280, fit at 720×1280", () => {
    expect(VERTICAL_1080.fps).toBe(60);
    const ladder = capLadder(
      VERTICAL_1080,
      { share: SHARE_VERTICAL, floor: SHARE_VERTICAL },
      FIT,
    );
    expect(ladder.map((r) => r.step.kind)).toEqual(["fps", "share", "fit"]);
    const fit = ladder.at(-1)?.target;
    expect([fit?.width, fit?.height]).toEqual([720, 1280]);
  });

  // Auto: share and floor are re-solved to the recording, so each rung
  // goes to its own frame, never the 16:9 preset.
  it("Auto's re-solved frames carry through", () => {
    const recording = { width: 1280, height: 900 };
    const share = autoTarget(SHARE_LANDSCAPE, recording, 0.08);
    const floor = autoTarget(FLOOR, recording, 0.08);
    // The premise: Auto's frames are not the 16:9 ones.
    expect(share.height).not.toBe(SHARE_LANDSCAPE.height);
    expect(floor.height).not.toBe(FLOOR.height);
    const frame = capLadder(share, { share, floor }, FIT)[0];
    expect(frame?.step).toEqual({
      kind: "frame",
      from: { width: share.width, height: share.height },
      to: { width: floor.width, height: floor.height },
    });
  });
});

describe("fitRetry", () => {
  // Red if the retry does not scale by the overshoot, or moves the frame.
  it("the retry scales the bitrate by the overshoot", () => {
    const fit = capLadder(FLOOR, { share: FLOOR, floor: FLOOR }, FIT)[0];
    if (fit === undefined) throw new Error("no fit rung");
    const retry = fitRetry(fit, 9_500_000, 11_000_000);
    expect(retry.step).toEqual({
      kind: "fit",
      bitrate: 1_589_091,
      durationMs: 30_000,
    });
    expect(retry.target).toEqual({ ...fit.target, bitrate: 1_589_091 });
  });
});
