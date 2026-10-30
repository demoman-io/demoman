// packages/run-core/src/render/mp4-cap.ts
//
// The ladder an MP4 with a size cap steps down (`export({ maxMB })`, spec
// 2026-10-29 §3.1). Pure: it lists the rungs once, and `renderOutput`
// decides how far down them to go, from the bytes it rendered.
import type { RenderTarget } from "@demoman/compositor";
import type { VideoStep } from "../export/report.js";

/**
 * The share of the cap the fit rung aims at, for the MP4 container and the
 * encoder's overshoot. Measured 2026-10-29 (spec §4): delivered against
 * asked ran 0.48–1.44 between 0.05 and 0.012 bits per pixel per frame, so
 * no constant could cover it; the one retry (`fitRetry`) absorbs the
 * overshoot, and this only keeps the first try off the edge.
 */
export const HEADROOM = 0.92;

/** The frames a cap steps through: the share target, and the floor — the
 *  share look at the 1080p tier's frame (720x1280 for 9:16), the last at
 *  which text is as sharp as the author asked. */
export interface CapTargets {
  share: RenderTarget;
  floor: RenderTarget;
}

export interface CapRung {
  target: RenderTarget;
  step: VideoStep;
}

/** The bitrate a file of `durationMs` may have to land under `maxBytes`. */
export function fitBitrate(maxBytes: number, durationMs: number): number {
  return Math.round((maxBytes * HEADROOM * 8) / (durationMs / 1000));
}

const sizeOf = (t: RenderTarget) => ({ width: t.width, height: t.height });

/**
 * The rungs below `asked`, in the order the author ruled ("frame rate
 * first, keep text sharp", 2026-10-18; the floor at the share look,
 * 2026-10-29), each only when it applies:
 *
 * 1. `fps`: down to `share`'s frame rate (60 to 30), at the same frame and
 *    encoder, the bitrate scaled with it so each frame keeps its bits;
 * 2. `share`: the share target, frame and `quality` in one step, for a
 *    target not at the share frame or encoded by bitrate;
 * 3. `frame`: the floor, when its frame is smaller than share's;
 * 4. `fit`: the floor's frame encoded by `fit.bitrate`, below the floor —
 *    always last, so a cap always ends on a rung that aims at it.
 */
export function capLadder(
  asked: RenderTarget,
  { share, floor }: CapTargets,
  fit: { bitrate: number; durationMs: number },
): CapRung[] {
  const rungs: CapRung[] = [];
  let at = asked;
  if (at.fps > share.fps) {
    const target = {
      ...at,
      fps: share.fps,
      bitrate: Math.round((at.bitrate * share.fps) / at.fps),
    };
    rungs.push({ target, step: { kind: "fps", from: at.fps, to: share.fps } });
    at = target;
  }
  const shareQuality = share.encoder?.quality;
  const quality = at.encoder?.quality;
  const atShare =
    at.width === share.width &&
    at.height === share.height &&
    (shareQuality === undefined ||
      (quality !== undefined && quality <= shareQuality));
  if (!atShare) {
    rungs.push({
      target: share,
      step: {
        kind: "share",
        from: sizeOf(at),
        to: sizeOf(share),
        ...(shareQuality === undefined ? {} : { quality: shareQuality }),
      },
    });
    at = share;
  }
  if (at.width !== floor.width || at.height !== floor.height) {
    rungs.push({
      target: floor,
      step: { kind: "frame", from: sizeOf(at), to: sizeOf(floor) },
    });
  }
  const { quality: _byQuality, ...byBitrate } = floor.encoder ?? {};
  rungs.push({
    target: { ...floor, bitrate: fit.bitrate, encoder: byBitrate },
    step: { kind: "fit", ...fit },
  });
  return rungs;
}

/** The fit rung once more, its bitrate scaled by how far over it came out. */
export function fitRetry(
  fit: CapRung,
  maxBytes: number,
  actualBytes: number,
): CapRung {
  const bitrate = Math.round(
    (fit.target.bitrate * maxBytes * HEADROOM) / actualBytes,
  );
  if (fit.step.kind !== "fit") {
    throw new Error(`fitRetry retries a fit rung, not a ${fit.step.kind} one`);
  }
  return {
    target: { ...fit.target, bitrate },
    step: { kind: "fit", bitrate, durationMs: fit.step.durationMs },
  };
}
