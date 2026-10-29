// packages/run-core/src/render/output.ts
//
// One render for every door: the extension's offscreen document and the
// CLI's render page both call `renderOutput` (moved here from the offscreen
// renderer's `renderOne`, launch D1). Browser-only: the sinks need
// OffscreenCanvas and WebCodecs. Naming and storing the files are the
// callers', since each door saves differently.
import {
  blurWallpaper,
  type ClampedRange,
  composeForTarget,
  createGifSink,
  createImageFrameSource,
  createMp4Sink,
  createOffscreenSurface,
  createPngSink,
  createVideoFrameSource,
  type DetailViolation,
  type FrameBundle,
  type FrameImage,
  type FrameSource,
  isGifOverBudget,
  type LoweredZoom,
  logoRasterHeight,
  planScene,
  type RenderTarget,
  renderScene,
  renderStills,
  type Screens,
  type UnavailableSpan,
  type UnplacedStill,
  wallpaperBlurPx,
  wallpaperRasterSize,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import type { CapRender, VideoCap } from "../export/report.js";
import {
  type FileType,
  MAX_STILL_SIDE,
  type StillsOptions,
  type WallpaperWarning,
} from "../export/target.js";
import type { LogoSource } from "../logo.js";
import { MAX_CAP_STEPS, nextCapStep } from "./mp4-cap.js";

/** The exact `reason` a reclaimed range's `UnavailableSpan` carries, so the
 *  extension's export row can tell "reclaimed to free space" from a decode
 *  failure without a second copy of the string. */
export const RECLAIMED_SPAN_REASON = "motion reclaimed to free space";

/** A logo as the caller could get it: decoded, or the reason it is not. */
export type LogoLoad =
  | { ok: true; source: LogoSource }
  | { ok: false; error: string };

/** A wallpaper or uploaded image as the caller could get it
 *  (`wallpaperLoader`), or the reason it is not. `natural` is the image's
 *  own size, which each output's `wallpaperRasterSize` and the soft warning
 *  are measured against; `image(size)` answers it decoded at least that
 *  large and never above `natural` (the loader's, freed by its `close`).
 *  `name` is the id or the path, for the warning. */
export type WallpaperLoad =
  | {
      ok: true;
      name: string;
      natural: { width: number; height: number };
      image(size: { width: number; height: number }): Promise<FrameImage>;
      close(): void;
    }
  | { ok: false; error: string };

/** One frame by ref: encoded video bytes for a `span:` ref, an image for a
 *  keyframe. Both doors' loaders route on the prefix the same way. */
export type FrameLoad = (ref: string) => Promise<Uint8Array | FrameImage>;

/**
 * A bundle's frames. Motion spans arrive as encoded video and keyframes as
 * stills. `createVideoFrameSource` is async (it demuxes) and
 * `createImageFrameSource` is not, so this has to be async or the union
 * leaks into `CompositorPorts`.
 */
export async function framesFor(
  bundle: FrameBundle,
  load: FrameLoad,
): Promise<FrameSource> {
  return bundle.motionSpans.length > 0
    ? await createVideoFrameSource(bundle, load)
    : createImageFrameSource(bundle, load);
}

/** What `onFrame` is told: the frame, and for a re-rendering ladder the
 *  width (a budgeted GIF, a capped MP4) and the render (a capped MP4). */
export type FrameReport = (
  done: number,
  total: number,
  width?: number,
  pass?: CapRender,
) => void;

/**
 * Whole percents only: a 60 fps minute is 3,600 frames, and one report per
 * frame is 3,600 messages for a bar that can show 101 states. The last
 * frame always reports, so the bar never stops at 99.
 */
export function wholePercent(report: FrameReport): FrameReport {
  let lastPercent = -1;
  let lastWidth: number | undefined;
  let lastRender: number | undefined;
  return (done, total, width, pass) => {
    const percent = Math.floor((done * 100) / total);
    // A new width or a new render is a new render: always said, whatever
    // its percent.
    if (
      percent === lastPercent &&
      done !== total &&
      width === lastWidth &&
      pass?.render === lastRender
    ) {
      return;
    }
    lastPercent = percent;
    lastWidth = width;
    lastRender = pass?.render;
    if (width === undefined) report(done, total);
    else if (pass === undefined) report(done, total, width);
    else report(done, total, width, pass);
  };
}

export interface RenderFacts {
  detailViolations: DetailViolation[];
  /** Motion the frame source could not serve, then the ranges the storage
   *  lifecycle reclaimed before this render ran. */
  unavailableSpans: UnavailableSpan[];
  /** Steps that got no still. Empty for mp4 and gif. */
  unplacedStills: UnplacedStill[];
  loweredZooms: LoweredZoom[];
  /** Why the file has no logo, when the scene has one. */
  logoWarning: string | null;
  /** Why the file shows the gradient instead of the scene's wallpaper, or
   *  that the image is too small for the deepest zoom; null when neither. */
  wallpaperWarning: WallpaperWarning | null;
  clampedRanges: ClampedRange[];
  /** The size the file was rendered at. The target, except for a GIF with
   *  a budget, which may render wider (`gifBudget`), and an MP4 with a
   *  cap, which may be the frame rate and frame of a later step
   *  (`videoCap`). */
  rendered: { width: number; height: number; fps: number };
  /** Stills only: the width asked for (`width` or `native`) when the 4K cap
   *  (`MAX_STILL_SIDE`) cut it; `rendered` holds what was drawn. */
  stillsCapped?: { askedWidth: number };
  /** Set when the caller gave the GIF a byte budget: the widths it would
   *  not fit at, widest first, and the size of the file that was kept —
   *  over `maxBytes` when even the target's own width did not fit. */
  gifBudget?: {
    maxBytes: number;
    byteLength: number;
    /** `detail`: the width would hold a zoom lower, or draw more from too
     *  few pixels, than the target's own width does — the recording does
     *  not have the pixels for it. `budget`: it was over `maxBytes`. */
    refused: {
      width: number;
      height: number;
      limit: "detail" | "budget";
    }[];
  };
  /** Set when the caller gave the MP4 a size cap (`mp4Cap`): the steps it
   *  took, and whether the kept file is within it. */
  videoCap?: VideoCap;
  /** The still screens of the render that was kept. Set for mp4 and gif;
   *  stills have none. */
  screens?: Screens;
}

/**
 * The widths a budgeted GIF tries, as multiples of its target, widest
 * first. The GIF targets are 800 px wide (450 on end), and a Mac's Retina
 * screen draws each GIF pixel as four: measured 2026-10-16, an 800 px GIF
 * looked soft in Preview and a 1600 px one of the same take looked sharp.
 * Width is what costs bytes, so a long take steps down until it fits.
 */
export const GIF_WIDTH_LADDER = [2, 1.5, 1] as const;

function scaledTarget(target: RenderTarget, factor: number): RenderTarget {
  return {
    ...target,
    width: Math.round(target.width * factor),
    height: Math.round(target.height * factor),
    cornerRadius: target.cornerRadius * factor,
  };
}

/**
 * The stills target `options.width` asks for, scaled from the stills
 * target as a whole so the frame's shape is kept. `windowAt` measures how
 * wide a target draws the recording's window; `recorded` is the widest
 * keyframe.
 *
 * The default never draws the window wider than the recording: 2560 px is
 * Retina-sharp at 1280 px on screen, wider than a GitHub pull request's
 * body, and a still drawn wider than its recording only stretches it.
 * Measured 2026-10-16: 14 stills of a 3420 px recording at 2560 averaged
 * 930 KB; at the recording's own size each would be about 2.3x the pixels.
 */
function stillsTarget(
  target: RenderTarget,
  width: StillsOptions["width"],
  windowAt: (t: RenderTarget) => number,
  recorded: number,
): { target: RenderTarget; cappedFrom: number | null } {
  const window = windowAt(target);
  const native = window > 0 && recorded > 0 ? recorded / window : 1;
  const asked =
    width === undefined
      ? Math.min(1, native)
      : width === "native"
        ? native
        : width / target.width;
  const cap = MAX_STILL_SIDE / Math.max(target.width, target.height);
  return {
    target: scaledTarget(target, Math.min(asked, cap)),
    // Said, never only applied: a width the cap cut would otherwise be
    // reported as the width asked for.
    cappedFrom: asked > cap ? Math.round(target.width * asked) : null,
  };
}

/**
 * What a width costs the take's picture: zoom scale given up to keep detail,
 * and stretches drawn from fewer pixels than they need. Read from the
 * composition alone, so a width can be judged without rendering it.
 */
function detailCost(violations: readonly DetailViolation[]): {
  lostScale: number;
  upscaled: number;
} {
  let lostScale = 0;
  let upscaled = 0;
  for (const v of violations) {
    lostScale += Math.max(0, v.requestedScale - v.grantedScale);
    if (v.sourceWidth < v.neededWidth) upscaled++;
  }
  return { lostScale, upscaled };
}

/** One entry per span and reason: the ladder renders from one frame source,
 *  which reports a span it cannot decode on every pass. */
function oncePerSpan(spans: UnavailableSpan[]): UnavailableSpan[] {
  const seen = new Set<string>();
  return spans.filter((s) => {
    const key = `${s.ref}\u0000${s.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RenderOutput {
  /** One file, `name: null` (the caller names it), for mp4 and gif; one per
   *  step, named by `renderStills`, for stills. */
  files: { name: string | null; bytes: Uint8Array }[];
  facts: RenderFacts;
}

export async function renderOutput(input: {
  fileType: FileType;
  target: RenderTarget;
  scene: SceneDocument;
  bundle: FrameBundle;
  frames: FrameSource;
  logo: LogoLoad | null;
  /** The scene's wallpaper or image; null for a solid or gradient. */
  wallpaper: WallpaperLoad | null;
  /** Each frame handed to a sink. A budgeted GIF and a capped MP4 also
   *  pass the width they are rendering at, and a capped MP4 which render
   *  it is (`CapRender`): a re-render starts again from frame 0, and
   *  without them the count would read as the same render going
   *  backwards. */
  onFrame?: FrameReport;
  /** GIF only: render as wide as `GIF_WIDTH_LADDER` allows within this many
   *  bytes. Without it the GIF renders at `target`, as the extension's
   *  export panel, which names the size from `targetFor`, expects. */
  gifBudget?: { maxBytes: number };
  /** MP4 only: keep the file to `maxBytes`, rendering again down the
   *  ladder `nextCapStep` gives (frame rate, then `share`, then quality)
   *  while it is over, at most four renders. A file still over after the
   *  last step, or when a later step's render throws, is the smallest one
   *  made, kept and reported over (`RenderFacts.videoCap`, with `failed`
   *  for the throw). A first render that throws rejects, as without a cap.
   *  Without it the MP4 renders once, at `target`. */
  mp4Cap?: { maxBytes: number; share: RenderTarget };
  /** Stills only: their size and framing (`StillsOptions`). Without it the
   *  stills render at `target`, framed as the video, as the extension's
   *  export panel — which names the size from `targetFor` — expects. */
  stills?: StillsOptions;
}): Promise<RenderOutput> {
  const { fileType, target, scene, bundle, frames, onFrame } = input;
  // Rasterised per output: an SVG is drawn at each target's own size. A
  // logo that cannot be had never fails the output — it is decoration —
  // but the facts say the file has none.
  const logoAt = async (
    at: RenderTarget,
  ): Promise<{ logo: FrameImage | null; logoWarning: string | null }> => {
    if (input.logo === null) return { logo: null, logoWarning: null };
    if (!input.logo.ok) {
      return {
        logo: null,
        logoWarning: `The logo was left out: ${input.logo.error}`,
      };
    }
    try {
      return {
        logo: await input.logo.source.rasterAt(
          logoRasterHeight(scene.branding, at),
        ),
        logoWarning: null,
      };
    } catch (error) {
      return {
        logo: null,
        logoWarning: `The logo was left out: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
  // Rasterised per output, as the logo is: each target draws the image at
  // its own `wallpaperRasterSize` (a GIF rung, a cap step, a stills size),
  // never one decided for another. One that cannot be had never fails the
  // output: the frame shows the gradient and the facts say why.
  const wallpaperAt = async (
    at: RenderTarget,
  ): Promise<{
    image: FrameImage | null;
    failed: string | null;
    held?: FrameImage;
  }> => {
    const load = input.wallpaper;
    const kind = scene.branding.background.kind;
    // A scene on an image with none handed in is one left out, not a
    // scene with nothing to draw.
    if (load === null)
      return {
        image: null,
        failed:
          kind === "wallpaper" || kind === "image"
            ? "no wallpaper was supplied to the render"
            : null,
      };
    if (!load.ok) return { image: null, failed: load.error };
    const size = wallpaperRasterSize(at, load.natural);
    let held: FrameImage;
    try {
      held = await load.image(size);
    } catch (error) {
      return {
        image: null,
        failed: `${load.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let sized = held;
    if (size.width < held.width) {
      try {
        const bitmap = await createImageBitmap(held.image, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: "high",
        });
        sized = {
          ...held,
          image: bitmap,
          width: size.width,
          height: size.height,
        };
      } catch (error) {
        return {
          image: null,
          failed: `"${load.name}" could not be resized to ${size.width}×${size.height} (${
            error instanceof Error ? error.message : String(error)
          })`,
        };
      }
    }
    // Blurred here, once for this output, as the take records it: never
    // per frame, and never re-decided from anything else.
    const bg = scene.branding.background;
    const blur = bg.kind === "wallpaper" || bg.kind === "image" ? bg.blur : 0;
    const radius = wallpaperBlurPx(at, sized, blur ?? 0);
    try {
      return { image: blurWallpaper(sized, radius), failed: null, held };
    } catch (error) {
      return {
        image: null,
        failed: `"${load.name}" could not be blurred at ${sized.width}×${sized.height} (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    } finally {
      // The sharp copy made for this output, once the blur has its own.
      if (radius > 0 && sized !== held) (sized.image as ImageBitmap).close();
    }
  };
  /** What the facts say about the wallpaper of a render at `at` whose
   *  deepest camera scale was `deepestScale`. */
  const wallpaperWarning = (
    at: RenderTarget,
    deepestScale: number,
    failed: string | null,
  ): WallpaperWarning | null => {
    if (failed !== null) {
      return {
        kind: "leftOut",
        sentence: `The wallpaper was left out: ${failed}; the ${fileType === "stills" ? "stills use" : "video uses"} the plain gradient.`,
      };
    }
    const load = input.wallpaper;
    if (load === null || !load.ok) return null;
    // The image's own size against what covering `at` at that zoom needs:
    // `natural`, never the smaller raster it was decoded to.
    const { width, height } = load.natural;
    const scale = Math.max(at.width / width, at.height / height) * deepestScale;
    const needs = {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
    return needs.width > width
      ? {
          kind: "soft",
          sentence: `The wallpaper "${load.name}" is ${width}×${height}, smaller than this export's deepest zoom needs (${needs.width}×${needs.height}), so it will look soft.`,
        }
      : null;
  };
  /** A raster made for one output, freed once that output is rendered;
   *  the loader's own decode is the loader's to free. */
  const release = (image: FrameImage | null, held: FrameImage | null): void => {
    if (image !== null && image.image !== held?.image) {
      (image.image as ImageBitmap).close();
    }
  };
  const plan = planScene(scene);
  const surface = createOffscreenSurface();
  // Ranges reclaimed before this render ran: the compositor draws them as
  // stills, and without this the reader would take them for decode failures.
  const reclaimed = bundle.degradations
    .filter((d) => d.kind === "motionReclaimed")
    .map((d) => ({
      ref: `${d.startMs}-${d.endMs}ms`,
      reason: RECLAIMED_SPAN_REASON,
    }));

  // The widest frame the recording has, measured once.
  const widestKeyframe = bundle.keyframes.reduce(
    (widest, k) => Math.max(widest, k.width),
    0,
  );
  if (fileType === "stills") {
    const options = input.stills;
    const sized =
      options === undefined
        ? { target, cappedFrom: null }
        : stillsTarget(
            target,
            options.width,
            (t) => {
              const composed = composeForTarget({
                plan,
                bundle,
                scene,
                target: t,
              });
              return composed.presentation.frameRect.width;
            },
            widestKeyframe,
          );
    const at = sized.target;
    const { logo, logoWarning } = await logoAt(at);
    const wallpaper = await wallpaperAt(at);
    const camera = options === undefined ? undefined : (options.zoom ?? "none");
    let result: Awaited<ReturnType<typeof renderStills>>;
    try {
      result = await renderStills({
        plan,
        bundle,
        scene,
        target: at,
        ports: { frames, surface, images: createPngSink() },
        logo,
        wallpaper: wallpaper.image,
        ...(camera === undefined ? {} : { camera }),
        ...(onFrame === undefined ? {} : { onFrame }),
      });
    } finally {
      release(wallpaper.image, wallpaper.held ?? null);
    }
    // `none` frames every still whole; otherwise a still may sit at any
    // zoom the video reaches. Asked only when there is an image to judge.
    const deepest =
      camera === "none" || input.wallpaper?.ok !== true
        ? 1
        : composeForTarget({
            plan,
            bundle,
            scene,
            target: at,
          }).resolved.cameraKeys.reduce((m, k) => Math.max(m, k.scale), 1);
    return {
      files: result.files.map((f) => ({ name: f.name, bytes: f.bytes })),
      facts: {
        detailViolations: result.detailViolations,
        unavailableSpans: [...result.unavailableSpans, ...reclaimed],
        unplacedStills: result.unplacedStills,
        loweredZooms: result.loweredZooms,
        logoWarning,
        wallpaperWarning: wallpaperWarning(at, deepest, wallpaper.failed),
        clampedRanges: result.clampedRanges,
        rendered: { width: at.width, height: at.height, fps: at.fps },
        ...(sized.cappedFrom === null
          ? {}
          : { stillsCapped: { askedWidth: sized.cappedFrom } }),
      },
    };
  }

  const renderAt = async (
    at: RenderTarget,
    maxBytes?: number,
    saysWidth = false,
    pass?: CapRender,
  ) => {
    const { logo, logoWarning } = await logoAt(at);
    const wallpaper = await wallpaperAt(at);
    const ports =
      at.format === "gif"
        ? {
            frames,
            surface,
            gif: createGifSink(at, maxBytes === undefined ? {} : { maxBytes }),
          }
        : { frames, surface, video: createMp4Sink(at) };
    let result: Awaited<ReturnType<typeof renderScene>>;
    try {
      result = await renderScene({
        plan,
        bundle,
        scene,
        target: at,
        ports,
        logo,
        wallpaper: wallpaper.image,
        ...(onFrame === undefined
          ? {}
          : {
              onFrame:
                pass !== undefined
                  ? (done: number, total: number) =>
                      onFrame(done, total, at.width, pass)
                  : saysWidth
                    ? (done: number, total: number) =>
                        onFrame(done, total, at.width)
                    : onFrame,
            }),
      });
    } finally {
      release(wallpaper.image, wallpaper.held ?? null);
    }
    return {
      result,
      logoWarning,
      wallpaperWarning: wallpaperWarning(
        at,
        result.deepestScale,
        wallpaper.failed,
      ),
      at,
    };
  };

  const budget = target.format === "gif" ? input.gifBudget : undefined;
  const cap = target.format === "mp4" ? input.mp4Cap : undefined;
  const refused: NonNullable<RenderFacts["gifBudget"]>["refused"] = [];
  let videoCap: VideoCap | undefined;
  let done: Awaited<ReturnType<typeof renderAt>> | undefined;
  if (cap !== undefined) {
    const steps: VideoCap["steps"] = [];
    // How many renders the ladder could take from here, for progress.
    let upTo = 1;
    for (
      let at: RenderTarget | undefined = target;
      upTo <= MAX_CAP_STEPS;
      upTo++
    ) {
      const next = nextCapStep(at, cap.share);
      if (next === null) break;
      at = next.target;
    }
    // The first render's failure is the export's, as without a cap: there
    // is no file to keep.
    let current = await renderAt(target, undefined, true, {
      render: 1,
      upTo,
    });
    let kept = current;
    let failed: VideoCap["failed"];
    while (
      current.result.bytes.byteLength > cap.maxBytes &&
      steps.length < MAX_CAP_STEPS
    ) {
      const next = nextCapStep(current.at, cap.share);
      if (next === null) break;
      try {
        current = await renderAt(next.target, undefined, true, {
          render: steps.length + 2,
          upTo,
        });
      } catch (error) {
        // A good file is already made: a lower rung that throws costs the
        // fit, never the export (ruling, 2026-10-18), and says why.
        failed = {
          step: next.step,
          error: error instanceof Error ? error.message : String(error),
        };
        break;
      }
      steps.push(next.step);
      // The smallest file made: the last one, unless a step came out
      // larger (a quality the encoder could not honour below another's).
      if (current.result.bytes.byteLength <= kept.result.bytes.byteLength) {
        kept = current;
      }
    }
    done = kept;
    videoCap = {
      maxBytes: cap.maxBytes,
      met: kept.result.bytes.byteLength <= cap.maxBytes,
      steps,
      keptQuality: kept.at.encoder?.quality ?? null,
      ...(failed === undefined ? {} : { failed }),
    };
  } else if (budget === undefined) {
    done = await renderAt(target);
  } else {
    // The narrowest frame the GIF draws from: a width whose window is
    // drawn wider than this stretches those frames, zoom or no zoom, which
    // the detail violations (zooms only) do not see. Motion spans count:
    // they follow the display's DPR and keyframes the replay's, so on a
    // DPR-1 display the moving frames are a third of the keyframes' width
    // — and they are most of a GIF's frames.
    const recorded = bundle.motionSpans.reduce(
      (narrowest, span) => Math.min(narrowest, span.width),
      widestKeyframe,
    );
    const costAt = (at: RenderTarget) => {
      const composed = composeForTarget({ plan, bundle, scene, target: at });
      return {
        ...detailCost(composed.violations),
        stretched: composed.presentation.frameRect.width > recorded,
      };
    };
    const own = costAt(target);
    for (const factor of GIF_WIDTH_LADDER) {
      const at = scaledTarget(target, factor);
      // The target's own width has nowhere narrower to go: it renders
      // whole, and its size is reported against the budget.
      const last = factor === GIF_WIDTH_LADDER.at(-1);
      if (!last) {
        // Wider than the recording can back: a DPR-1 take at twice the
        // width held a 2.2x zoom near 1x (2026-10-16). Not rendered.
        const cost = costAt(at);
        if (
          (cost.stretched && !own.stretched) ||
          cost.lostScale > own.lostScale + 1e-6 ||
          cost.upscaled > own.upscaled
        ) {
          refused.push({
            width: at.width,
            height: at.height,
            limit: "detail",
          });
          continue;
        }
      }
      try {
        done = await renderAt(at, last ? undefined : budget.maxBytes, true);
        break;
      } catch (error) {
        if (!isGifOverBudget(error)) throw error;
        refused.push({ width: at.width, height: at.height, limit: "budget" });
      }
    }
  }
  if (done === undefined) {
    throw new Error("the GIF width ladder ended without a render");
  }
  const { result, logoWarning, wallpaperWarning: wallpaperSaid, at } = done;
  return {
    files: [{ name: null, bytes: result.bytes }],
    facts: {
      detailViolations: result.detailViolations,
      unavailableSpans: [...oncePerSpan(result.unavailableSpans), ...reclaimed],
      unplacedStills: [],
      loweredZooms: result.loweredZooms,
      logoWarning,
      wallpaperWarning: wallpaperSaid,
      clampedRanges: result.clampedRanges,
      rendered: { width: at.width, height: at.height, fps: at.fps },
      ...(budget === undefined
        ? {}
        : {
            gifBudget: {
              maxBytes: budget.maxBytes,
              byteLength: result.bytes.byteLength,
              refused,
            },
          }),
      ...(videoCap === undefined ? {} : { videoCap }),
      // From `done`, the render kept: a capped or budgeted file is the
      // last rung that was kept, and its screens are that render's.
      screens: result.screens,
    },
  };
}
