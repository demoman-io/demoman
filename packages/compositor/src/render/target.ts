import type { SceneAspect } from "@demoman/scene-schema";
import type { FrameBundle } from "../bundle.js";
import { clamp } from "../geometry.js";
import { CAMERA_DEFAULTS } from "../plan/camera.js";
import type { CameraIntent } from "../plan/types.js";

/**
 * How the MP4 encoder is asked to work, beyond the target's bitrate. Absent
 * on every preset: the encode is then the bitrate alone, as it always was.
 */
export interface Mp4EncoderHints {
  /** 0..1: when set, the encoder is steered by quality rather than by the
   *  target's `bitrate`. */
  quality?: number;
  bitrateMode?: "constant" | "variable";
  hardwareAcceleration?:
    | "no-preference"
    | "prefer-hardware"
    | "prefer-software";
}

export interface RenderTarget {
  format: "mp4" | "gif" | "png";
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** App-frame corner radius, in output pixels. */
  cornerRadius: number;
  /**
   * How the capture meets a target whose aspect it does not share.
   *
   * `contain` fits the whole viewport inside the padded box, so the frame
   * carries the *capture's* aspect and the background margin is part of the
   * presentation. Right for every target close to the capture's own shape.
   *
   * `cover` fills the padded box, so the frame carries the *target's* aspect
   * and the capture is cropped to it — the camera then decides which part of
   * the page that crop sits over. Right for a vertical cut, where a
   * letterboxed 9:16 leaves the UI too small to read on a phone, which is the
   * entire point of the format.
   *
   * Explicit per preset rather than inferred from an aspect threshold: the
   * choice is editorial, and a magic number here would silently change the
   * deliverable the first time a target's dimensions moved.
   */
  fit: "contain" | "cover";
  /**
   * Set by `autoTarget`: this frame was solved to the recording's shape, so
   * whatever separates the two is its own even rounding, and
   * `derivePresentation` closes that gap instead of drawing it. Absent on
   * every preset — a fixed frame's near fit keeps its bars, which is what
   * it draws at every resolution.
   */
  shapedToRecording?: true;
  /** MP4 only; see `Mp4EncoderHints`. */
  encoder?: Mp4EncoderHints;
}

/**
 * No preset carries a padding: the margin is the author's
 * (`SceneBranding.padding`, spec 2026-10-05), one value for every format.
 * Until 2026-10-05 each preset had its own — 15% landscape, 8% vertical, 4%
 * GIF, 5% stills — and the landscape value was chosen for zoom headroom;
 * `clampToSourceDetail` keeps that note.
 */
export const LANDSCAPE_4K: RenderTarget = {
  format: "mp4",
  width: 3840,
  height: 2160,
  fps: 60,
  bitrate: 40_000_000,
  cornerRadius: 36,
  fit: "contain",
};

export const LANDSCAPE_1440P: RenderTarget = {
  format: "mp4",
  width: 2560,
  height: 1440,
  fps: 60,
  bitrate: 18_000_000,
  cornerRadius: 24,
  fit: "contain",
};

export const LANDSCAPE_1080P: RenderTarget = {
  format: "mp4",
  width: 1920,
  height: 1080,
  fps: 60,
  bitrate: 10_000_000,
  cornerRadius: 18,
  fit: "contain",
};

export const VERTICAL_1080: RenderTarget = {
  format: "mp4",
  width: 1080,
  height: 1920,
  fps: 60,
  bitrate: 12_000_000,
  cornerRadius: 24,
  fit: "cover",
};

/**
 * The share targets: what an export is by default, sized for a chat, a
 * pull request or a 10 MB upload limit (spec 2026-10-18 §3). The author
 * picked them on 2026-10-18 from `pnpm share:measure` over three takes (§8):
 * 30 fps, encoded by quality (`quality: 0.5`) rather than by bitrate, over
 * the smaller `0.35` for text that stays sharp; the long side was 1920 then
 * (about 0.1 MB a second in the headed window) and is 2560 since 2026-10-29
 * (below).
 *
 * What `quality` becomes depends on the browser. mediabunny maps it to a
 * constant quantizer where the encoder takes quantizer mode, and otherwise
 * falls back to variable bitrate at a rate it computes from the frame size
 * and the quality (not the frame rate). On Chromium 151 on macOS, measured
 * 2026-10-18, a headed window takes AVC quantizer mode at 1920x1080 and
 * 720x1280, which is what the author's pick ran under (0.86 Mbps real at
 * 1080p); headless refuses it, and the same target is a VBR file at about
 * 3.2 Mbps. `EncoderUsed.rateControl` says which ran.
 *
 * `bitrate` is nominal. `createMp4Sink` asks the encoder for `quality` when
 * `encoder.quality` is set and never reads `bitrate`; it is here because a
 * `RenderTarget` carries one, and `autoTarget` scales it by area. Nothing
 * may report it as the file's rate: the file's own byte length is that.
 *
 * Landscape: LANDSCAPE_1440P's frame and corner radius; its 18 Mbps at half
 * the frames. `targetFor` reshapes it for Auto through `landscapeFrame`.
 * Long side 2560 since 2026-10-29 (the author, over 1920): zoomed out, a
 * 1920 frame draws a 1280px page at ~1.3 px per CSS px and reads soft on a
 * Retina screen. Measured on one take with `pnpm share:measure --qualities`,
 * full-screen on a 14" MacBook: 16% more sharp text edges zoomed out, 4%
 * zoomed in, for 63% more bytes (~0.4 MB a second, software encoder).
 */
export const SHARE_LANDSCAPE: RenderTarget = {
  format: "mp4",
  width: 2560,
  height: 1440,
  fps: 30,
  bitrate: 9_000_000,
  cornerRadius: 24,
  fit: "contain",
  encoder: { quality: 0.5 },
};

/**
 * 9:16 at 720x1280, which the author judged crisp enough on a phone (§8).
 * The corner radius scales VERTICAL_1080's 24 by 720/1080; the nominal
 * bitrate is VERTICAL_1080's 12 Mbps scaled by area and halved for 30 fps
 * (12M x (720x1280)/(1080x1920) / 2 = 2.67M), read by nothing (see
 * SHARE_LANDSCAPE).
 */
export const SHARE_VERTICAL: RenderTarget = {
  format: "mp4",
  width: 720,
  height: 1280,
  fps: 30,
  bitrate: 2_670_000,
  cornerRadius: 16,
  fit: "cover",
  encoder: { quality: 0.5 },
};

/**
 * The high targets: what an export is by default when it is not going to
 * GitHub (the author, 2026-10-23: "60fps and higher quality", "20-40MB for
 * a 30 second clip"). 60 fps, encoded by bitrate so the size is predictable:
 * 8 Mbps is 30 MB for 30 s, the middle of that band. A take that changes
 * little on screen comes in under it; VBR spends no bits a frame does not
 * need.
 *
 * Landscape: LANDSCAPE_1440P's frame and corner radius when the keyframes
 * back it, else the tier's own at this bitrate (`targetFor`).
 */
export const HIGH_LANDSCAPE: RenderTarget = {
  ...LANDSCAPE_1440P,
  bitrate: 8_000_000,
};

/** The most an Auto frame's area may scale HIGH_LANDSCAPE's bitrate to:
 *  37.5 MB for 30 s, under the author's 40. Uncapped, a square recording's
 *  2560x2560 frame asked 14.2 Mbps, 53 MB. */
export const HIGH_MAX_BITRATE = 10_000_000;

/** 9:16 at VERTICAL_1080's frame, at HIGH_LANDSCAPE's bitrate. */
export const HIGH_VERTICAL: RenderTarget = {
  ...VERTICAL_1080,
  bitrate: HIGH_LANDSCAPE.bitrate,
};

export const GIF_800: RenderTarget = {
  format: "gif",
  width: 800,
  height: 450,
  fps: 15,
  bitrate: 0,
  cornerRadius: 10,
  fit: "contain",
};

export const STILL_1440: RenderTarget = {
  format: "png",
  width: 2560,
  height: 1440,
  fps: 0,
  bitrate: 0,
  cornerRadius: 24,
  fit: "contain",
};

/**
 * GIF_800 turned on end, for a 9:16 canvas. `cover`, like VERTICAL_1080, so
 * the camera follows each step and `cameraIntentsForTarget` applies the
 * vertical cap.
 * The corner radius scales VERTICAL_1080's 24 by 450/1080.
 */
export const GIF_VERTICAL_450: RenderTarget = {
  format: "gif",
  width: 450,
  height: 800,
  fps: 15,
  bitrate: 0,
  cornerRadius: 10,
  fit: "cover",
};

/** STILL_1440's portrait counterpart, at VERTICAL_1080's size. */
export const STILL_VERTICAL_1080: RenderTarget = {
  format: "png",
  width: 1080,
  height: 1920,
  fps: 0,
  bitrate: 0,
  cornerRadius: 24,
  fit: "cover",
};

/**
 * The deliverable's resolution comes from the keyframes (SP1: the motion
 * stream is surface-capped and gets upscaled, keyframes honour emulated DPR).
 * Pick the largest target the keyframes can actually back.
 */
export function pickLandscapeTarget(bundle: FrameBundle): RenderTarget {
  const widest = Math.max(...bundle.keyframes.map((k) => k.width), 0);
  if (widest >= LANDSCAPE_4K.width) return LANDSCAPE_4K;
  if (widest >= LANDSCAPE_1440P.width) return LANDSCAPE_1440P;
  return LANDSCAPE_1080P;
}

/**
 * The tier an Auto MP4 is sized from. `autoTarget` gives the frame the
 * tier's LONG side, so the keyframes back it along theirs: a portrait
 * window at DPR 3 (2700x4200) backs a 3840-tall frame. Measured by width,
 * as `pickLandscapeTarget` must for a 16:9 frame, it got 1440's 2560
 * (review, 2026-10-06).
 */
export function pickAutoTier(bundle: FrameBundle): RenderTarget {
  const longest = Math.max(
    ...bundle.keyframes.map((k) => Math.max(k.width, k.height)),
    0,
  );
  if (longest >= LANDSCAPE_4K.width) return LANDSCAPE_4K;
  if (longest >= LANDSCAPE_1440P.width) return LANDSCAPE_1440P;
  return LANDSCAPE_1080P;
}

/** The MP4 tier the keyframes back for a demo of `aspect`: along their long
 *  side for Auto (`pickAutoTier`), by width for a fixed shape. */
export function pickMp4Tier(
  bundle: FrameBundle,
  aspect: SceneAspect,
): RenderTarget {
  return aspect === "auto" ? pickAutoTier(bundle) : pickLandscapeTarget(bundle);
}

/**
 * The demo's own landscape frame from a landscape tier: Auto's computed one
 * (`autoTarget`), or the tier itself for 16:9 — and for 9:16, which those
 * that take a landscape frame (the film check, the headless runner) measure
 * and render landscape. The editor turns 9:16 on end before it gets here.
 * One place for the rule, which `targetFor`, the film check and the runner
 * each wrote out until the review of 2026-10-06.
 */
export function landscapeFrame(
  aspect: SceneAspect,
  tier: RenderTarget,
  recording: { width: number; height: number },
  padding: number,
): RenderTarget {
  return aspect === "auto" ? autoTarget(tier, recording, padding) : tier;
}

/** H.264 level 5.2's largest frame, in 16x16 macroblocks: 3840x2400 fits,
 *  3840x2554 (level 6) is refused by Chrome's encoder. */
const MAX_MP4_MACROBLOCKS = 36_864;

const macroblocks = (w: number, h: number) =>
  Math.ceil(w / 16) * Math.ceil(h / 16);

/**
 * `width`x`height` scaled down whole, to even sides, until Chrome's H.264
 * encoder takes it (`MAX_MP4_MACROBLOCKS`); the size itself when it fits. A
 * motion span is muxed at its screencast's size, and the screencast can
 * deliver at REPLAY_DPR 3: a 1710x1107 window's 5130x3320 is 66,880
 * macroblocks, and the encoder refused every such span (2026-10-21).
 */
export function fitH264Frame(
  width: number,
  height: number,
): { width: number; height: number } {
  if (macroblocks(width, height) <= MAX_MP4_MACROBLOCKS) {
    return { width, height };
  }
  const even = (x: number) => Math.max(2, 2 * Math.floor(x / 2));
  let scale = Math.sqrt((MAX_MP4_MACROBLOCKS * 256) / (width * height));
  for (;;) {
    const fit = { width: even(width * scale), height: even(height * scale) };
    if (macroblocks(fit.width, fit.height) <= MAX_MP4_MACROBLOCKS) return fit;
    scale *= 0.995;
  }
}

/**
 * The Auto frame (spec 2026-10-06 §2): the recording at its own shape, plus
 * the padding as an even margin on all four sides — so padding 0 is
 * edge-to-edge recording, whatever shape the author's window made the page.
 *
 * The frame's LONG side is the tier's (1920/2560/3840 for MP4, 800 GIF, 2560
 * stills), so a tall, narrow window cannot produce a 3840-wide, 4600-tall
 * file. The other side is solved so the margin — `padding` × the frame's
 * shorter side, the unit `derivePresentation` insets by — comes out equal:
 * for a landscape recording of aspect `a` and long side `L`,
 *
 *     contentWidth = L / (1 + 2p / (a(1 − 2p)))
 *     height       = (contentWidth / a) / (1 − 2p)
 *
 * and symmetrically for a portrait one. Both sides round to even pixels for
 * H.264, so one margin may differ from another by up to a pixel. Bitrate
 * scales with the area so quality per pixel matches the tier's 16:9 preset.
 *
 * An MP4 frame is then held to H.264 level 5.2's largest frame
 * (`MAX_MP4_MACROBLOCKS`), scaled down whole so the margin stays even. Only
 * the 4K tier reaches it: a replay at REPLAY_DPR 3 of a 1280x800 window has
 * 3840-wide keyframes, and at padding 0.08 the formula gives 3840x2554 —
 * level 6, which Chrome's encoder refuses (final review, 2026-10-06).
 */
export function autoTarget(
  tier: RenderTarget,
  viewport: { width: number; height: number },
  padding: number,
): RenderTarget {
  const aspect = viewport.width / viewport.height;
  const inner = 1 - 2 * padding;
  const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
  // The frame for a given long side, its short side rounded once to even.
  const solve = (long: number): { width: number; height: number } => {
    if (aspect >= 1) {
      const content = long / (1 + (2 * padding) / (aspect * inner));
      return { width: long, height: even(content / aspect / inner) };
    }
    const content = long / (1 + (2 * padding * aspect) / inner);
    return { width: even((content * aspect) / inner), height: long };
  };
  let long = Math.max(tier.width, tier.height);
  let { width, height } = solve(long);
  if (
    tier.format === "mp4" &&
    macroblocks(width, height) > MAX_MP4_MACROBLOCKS
  ) {
    // A shorter long side, solved by the same formula — not the frame
    // scaled down and re-rounded, which compounds two roundings and drifts
    // the shape outside `derivePresentation`'s snap.
    long =
      2 *
      Math.floor(
        (long * Math.sqrt((MAX_MP4_MACROBLOCKS * 256) / (width * height))) / 2,
      );
    for (;;) {
      ({ width, height } = solve(long));
      if (macroblocks(width, height) <= MAX_MP4_MACROBLOCKS) break;
      long -= 2;
    }
  }
  return {
    ...tier,
    width,
    height,
    fit: "contain",
    shapedToRecording: true,
    bitrate: Math.round(
      (tier.bitrate * width * height) / (tier.width * tier.height),
    ),
  };
}

/**
 * The vertical cut is the same camera solver with a different target aspect,
 * following the active anchor — not a letterbox. Every anchor and marker
 * binding passes through untouched; only scale moves, and now only *down*.
 *
 * This used to raise scale to `verticalZoomScale`, on the reasoning that a
 * 9:16 cut is unreadable at landscape zoom levels. That was true of the
 * letterbox, where the vertical drew the capture no larger than the landscape
 * did. Under `cover` the crop itself magnifies (~2.29x for a 1280-wide
 * capture at 1080x1920), so the floor compounded a compensation with the
 * thing it compensated for, and the landscape zoom track compounds with it
 * too: a 1.8x zoom over the crop leaves a 241 CSS px window in which
 * the panel a click opens is a featureless slab.
 *
 * So the crop supplies the magnification and this caps what the camera may
 * add on top of it. See `CAMERA_DEFAULTS.verticalMaxScale` for how the cap
 * was measured. `maxScale` is not applied again — the vertical cap is
 * strictly below it, so it would be dead code.
 *
 * Callers do not have to remember this: `cameraIntentsForTarget` applies it,
 * and `renderScene`/`renderStills` call that. This stays exported because a
 * caller building a plan for its own vertical preview may want it directly,
 * and because clamping is idempotent, so a second application is harmless.
 */
export function verticalCameraIntents(intents: CameraIntent[]): CameraIntent[] {
  return intents.map((intent) => {
    const scale = clamp(intent.scale, 1, CAMERA_DEFAULTS.verticalMaxScale);
    // The author's own scale rides along when the cap lowers it, so the
    // camera can say "asked for 1.8x" rather than "asked for 1.15x". Kept
    // from a first application, so a second one stays idempotent.
    return scale < intent.scale
      ? {
          ...intent,
          scale,
          requestedScale: intent.requestedScale ?? intent.scale,
        }
      : { ...intent, scale };
  });
}

/**
 * The camera intents a given target may actually use.
 *
 * The vertical cap used to be opt-in, and nothing in the render path applied
 * it: `verticalCameraIntents` was called by one script and one test, so the
 * obvious call — `renderScene({ plan, target: VERTICAL_1080 })`, which is
 * exactly what SP7's editor will write — shipped the landscape 1.8x zoom
 * on top of the ~2.29x crop. That is a ~241 CSS px window with the panel the
 * click opens reduced to a featureless slab: precisely the compounding the
 * cap exists to prevent. A safeguard that depends on caller discipline is a
 * safeguard the first new caller loses.
 *
 * Driven by `fit` rather than by aspect or by preset identity, for the same
 * reason `fit` is explicit in the first place: `cover` is what makes the crop
 * itself a magnification, so `cover` is what the cap is a response to. Any
 * future cover preset inherits it without a second decision.
 */
export function cameraIntentsForTarget(
  target: RenderTarget,
  intents: CameraIntent[],
): CameraIntent[] {
  return target.fit === "cover" ? verticalCameraIntents(intents) : intents;
}
