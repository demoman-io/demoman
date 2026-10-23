import { describe, expect, it } from "vitest";
import { summarisePreviewFrames } from "../../../pages/src/editor/preview";

describe("summarisePreviewFrames", () => {
  it("reports the rate actually drawn against the rate asked for", () => {
    const line = summarisePreviewFrames({
      requestedFrames: 120,
      drawnFrames: 36,
      elapsedMs: 2000,
      sourceLookupMs: 180,
      composeMs: 1260,
      blitMs: 72,
      sourceFrame: { width: 3840, height: 2400 },
    });
    // 36 frames in 2s is 18fps drawn; 120 asked for is 60fps.
    expect(line).toContain("18.0 fps drawn");
    expect(line).toContain("60.0 asked");
    // And where the time went, per drawn frame: 5.0 / 35.0 / 2.0 ms.
    expect(line).toContain("source 5.0ms");
    expect(line).toContain("compose 35.0ms");
    expect(line).toContain("blit 2.0ms");
    // The size being resampled every frame, which is the first thing to
    // suspect when `compose` dominates: a DPR-3 keyframe is 9 megapixels and
    // `compose.ts` redraws it at `imageSmoothingQuality: "high"`.
    expect(line).toContain("3840x2400");
  });

  it("does not call two different quantities the same thing", () => {
    // `renderFrame` reports the decode as a stage called `fetch`, and the
    // headline figure beside it is the memoised lookup of the frame SOURCE,
    // which is ~0 after the first frame. Printing both as "fetch" put a
    // 0.0ms answer where a reader looks for the decode and a 15.1ms one at
    // the end of the same line.
    const line = summarisePreviewFrames({
      requestedFrames: 60,
      drawnFrames: 30,
      elapsedMs: 1000,
      sourceLookupMs: 0,
      composeMs: 1050,
      blitMs: 0,
      decodeMs: 453,
    });
    expect(line).toContain("decode 15.1ms");
    // Named differently from the headline lookup, so the two quantities
    // cannot be read as one another.
    expect(line).not.toMatch(/source/);
  });

  /**
   * The per-stage breakdown was removed on 2026-09-21, and this is the test
   * that keeps it removed.
   *
   * It printed every `onStage` name dearest first. On a real GPU that is
   * `cursor 0.0, background 0.0, chrome 0.0, frame 0.0` — the synchronous
   * draw calls are queued, so whichever stage happens to force the flush is
   * charged for all of them and the rest read zero. Measured: removing the
   * cursor entirely changed the frame time by nothing and simply moved the
   * whole cost to `background`. Under software rasterisation the same
   * misattribution happens, just with a big number on an arbitrary stage.
   *
   * `fetch` is the exception and the only one kept: it is an `await`, so it
   * is measured honestly, and on the author's machine it was 0.9ms of a
   * 1.1ms composite — the one figure in that list that ever pointed
   * anywhere. It is reported as `decode`.
   *
   * Measuring the synchronous stages truthfully would mean forcing a flush
   * between each, which changes what is being measured. Do not re-add them.
   */
  it("does not name the synchronous draw stages, which cannot be measured", () => {
    const line = summarisePreviewFrames({
      requestedFrames: 60,
      drawnFrames: 30,
      elapsedMs: 1000,
      sourceLookupMs: 0,
      composeMs: 300,
      blitMs: 0,
      decodeMs: 60,
    });
    // Matched as "<name> 1.2ms", not as a bare substring: the line says
    // "per drawn frame", so a `toContain("frame")` would fail on the
    // prose and pass for the wrong reason if the prose ever changed.
    for (const stage of [
      "background",
      "chrome",
      "frame",
      "cosmetics",
      "logo",
      "cursor",
    ]) {
      expect(line).not.toMatch(new RegExp(`\\b${stage} [\\d.]+ms`));
    }
    expect(line).toMatch(/\bdecode [\d.]+ms/);
  });

  it("omits the source size when nothing recorded one", () => {
    const line = summarisePreviewFrames({
      requestedFrames: 10,
      drawnFrames: 10,
      elapsedMs: 1000,
      sourceLookupMs: 0,
      composeMs: 0,
      blitMs: 0,
    });
    expect(line).not.toContain("x");
  });

  it("says so when nothing was drawn, rather than printing NaN", () => {
    // A diagnostic that answers with NaN has reported nothing while looking
    // like it reported something — the failure this whole surface exists to
    // avoid.
    const line = summarisePreviewFrames({
      requestedFrames: 30,
      drawnFrames: 0,
      elapsedMs: 500,
      sourceLookupMs: 0,
      composeMs: 0,
      blitMs: 0,
    });
    expect(line).not.toMatch(/NaN|Infinity/);
    expect(line).toContain("no frames drawn");
  });

  it("says so when no time passed, rather than dividing by zero", () => {
    const line = summarisePreviewFrames({
      requestedFrames: 1,
      drawnFrames: 1,
      elapsedMs: 0,
      sourceLookupMs: 0,
      composeMs: 0,
      blitMs: 0,
    });
    expect(line).not.toMatch(/NaN|Infinity/);
  });
});

/**
 * What the preview DECIDED, not only what it achieved.
 *
 * The playback height is solved from a measured cost, and until now nothing
 * printed either the height or the cost. So when the author reported the
 * picture as "a bit sharper at times", there was no way to tell a working
 * adaptation from a broken one without simulating the estimator offline —
 * which is exactly the round trip a checked-in readout exists to prevent.
 */
describe("summarisePreviewFrames, the resolution it chose", () => {
  const base = {
    requestedFrames: 60,
    drawnFrames: 60,
    elapsedMs: 1000,
    sourceLookupMs: 0,
    composeMs: 300,
    blitMs: 0,
  };

  it("names the bitmap it played at and the one it parks at", () => {
    const line = summarisePreviewFrames({
      ...base,
      bitmap: { width: 1920, height: 1080 },
      parkedHeight: 1314,
      msPerMegapixel: 4.9,
    });
    expect(line).toContain("1920x1080");
    expect(line).toContain("1314");
    expect(line).toContain("4.9");
  });

  it("says outright when playback is already at full resolution", () => {
    const line = summarisePreviewFrames({
      ...base,
      bitmap: { width: 2336, height: 1314 },
      parkedHeight: 1314,
      msPerMegapixel: 2,
    });
    expect(line).toMatch(/full/i);
  });

  // The uncalibrated case is the one that looks like a bug from outside:
  // playback sitting on its floor because nothing was measured reads
  // exactly like playback sitting on its floor because the machine is slow.
  it("distinguishes not-yet-measured from measured-and-slow", () => {
    const unmeasured = summarisePreviewFrames({
      ...base,
      bitmap: { width: 1280, height: 720 },
      parkedHeight: 1314,
      msPerMegapixel: null,
    });
    const slow = summarisePreviewFrames({
      ...base,
      bitmap: { width: 1280, height: 720 },
      parkedHeight: 1314,
      msPerMegapixel: 40,
    });
    expect(unmeasured).toMatch(/not measured|unmeasured/i);
    expect(slow).not.toMatch(/not measured|unmeasured/i);
    expect(slow).toContain("40");
  });

  it("stays quiet about resolution when it was not told any", () => {
    const line = summarisePreviewFrames(base);
    expect(line).not.toMatch(/parked/i);
    expect(line).toContain("fps drawn");
  });
});

describe("summarisePreviewFrames, the source lookup", () => {
  const base = {
    requestedFrames: 60,
    drawnFrames: 60,
    elapsedMs: 1000,
    composeMs: 60,
    blitMs: 6,
  };

  /**
   * The memoised `FrameSource` lookup is ~0 after the first frame by design,
   * so printing it every time spends a field on a number that is almost
   * always zero. It is kept for the one case it describes — a first frame
   * that waits seconds on a demux, which from outside looks exactly like a
   * slow composite — and shown only then.
   */
  it("stays quiet when the lookup cost nothing, which is the usual case", () => {
    expect(summarisePreviewFrames({ ...base, sourceLookupMs: 0 })).not.toMatch(
      /source/,
    );
  });

  it("says so when the lookup really did cost something", () => {
    const line = summarisePreviewFrames({ ...base, sourceLookupMs: 60_000 });
    expect(line).toContain("source");
    expect(line).toContain("1000.0ms");
  });
});
