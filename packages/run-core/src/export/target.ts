// packages/run-core/src/export/target.ts
import {
  type ClampedRange,
  type DetailViolation,
  type FrameBundle,
  GIF_800,
  GIF_VERTICAL_450,
  HIGH_LANDSCAPE,
  HIGH_MAX_BITRATE,
  HIGH_VERTICAL,
  LANDSCAPE_1080P,
  landscapeFrame,
  pickMp4Tier,
  type RenderTarget,
  SHARE_LANDSCAPE,
  SHARE_VERTICAL,
  STILL_1440,
  STILL_VERTICAL_1080,
  type UnavailableSpan,
  type UnplacedStill,
  VERTICAL_1080,
} from "@demoman/compositor";
import type { SceneAspect, SceneDocument } from "@demoman/scene-schema";

/** What the file is. The frame's shape is the scene's (`canvas.aspect`). */
export type FileType = "mp4" | "gif" | "stills";

/**
 * How an MP4 is sized and encoded (spec 2026-10-18 §3). `share`: the share
 * target (`SHARE_LANDSCAPE`, `SHARE_VERTICAL`), small enough for a chat or a
 * pull request. `high`: 60 fps at 1440p when the keyframes back it, at
 * about 30 MB for 30 s (`HIGH_LANDSCAPE`, `HIGH_VERTICAL`). `full`: the
 * largest tier the keyframes back, at 60 fps and the tier's bitrate, as
 * every export was before 2026-10-18. GIF and stills have one size each and
 * ignore it. In the order Settings lists them, smallest first.
 */
export const EXPORT_QUALITY_VALUES = ["share", "high", "full"] as const;
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

/** Each quality's name wherever a person picks it: the Studio's Settings and
 *  Export panel, and setup's menu. */
export const EXPORT_QUALITY_LABELS: Record<ExportQuality, string> = {
  share: "Sharing",
  high: "High",
  full: "Full",
};

/** What an MP4 is made at when nothing asks otherwise. GitHub's doors
 *  (`attach`, and an export given `maxMB`) ask for `share`. */
export const DEFAULT_EXPORT_QUALITY: ExportQuality = "high";

/** The one check of a quality read from a file, a request or a tool call:
 *  every door reads `EXPORT_QUALITY_VALUES`, so none can drift. */
export const isExportQuality = (v: unknown): v is ExportQuality =>
  typeof v === "string" &&
  (EXPORT_QUALITY_VALUES as readonly string[]).includes(v);

/** `targetFor`'s choices beyond the file type, the shape and the frames. */
export interface TargetOptions {
  /** Caps a landscape MP4's tier. Tests only (`ExecutorOptions.mp4MaxTier`). */
  maxTier?: RenderTarget;
  /** Absent: `full`, the answer every door got before share existed. */
  quality?: ExportQuality;
}

/**
 * Progress is per frame. `renderScene` and `renderStills` report each frame
 * they hand to a sink (`onFrame`), and the offscreen renderer forwards them
 * as `frame` reports — throttled to whole-percent changes, always including
 * the last — so the Export button can read "Exporting · 43%" rather than a
 * spinner. `started`/`output`/`failed`/`finished` still bracket the job's
 * one file type.
 */
export type RenderProgress =
  | { kind: "started"; jobId: string; output: FileType }
  | {
      kind: "frame";
      jobId: string;
      output: FileType;
      done: number;
      total: number;
    }
  | { kind: "output"; jobId: string; output: FileType; files: RenderedFile[] }
  | { kind: "failed"; jobId: string; output: FileType; error: string }
  | { kind: "finished"; jobId: string };

/**
 * What an export says about its wallpaper, kept apart by what it costs:
 * `leftOut` is a file on the gradient instead of the scene's image (keep
 * and refresh refuse it, as a missing logo), `soft` is an image drawn but
 * smaller than the deepest zoom needs. `sentence` is said as written.
 */
export interface WallpaperWarning {
  kind: "leftOut" | "soft";
  sentence: string;
}

export interface RenderedFile {
  ref: string;
  name: string;
  byteLength: number;
  contentType: string;
  detailViolations: DetailViolation[];
  /** Motion the frame source could not serve, drawn as a still of the
   *  preceding keyframe instead. Optional: rows stored before this field
   *  existed carry none. */
  unavailableSpans?: UnavailableSpan[];
  /** Why the logo is missing from this file, when it is. Optional: rows
   *  stored before this field existed carry none. */
  logoWarning?: string;
  /** Why the file shows the gradient instead of its wallpaper, or that the
   *  image is too small for its deepest zoom (`RenderFacts`). */
  wallpaperWarning?: WallpaperWarning;
  /** Steps that got no still. See `StoredOutput.unplacedStills` for why this
   *  rides the row rather than a console. */
  unplacedStills?: UnplacedStill[];
  /** What the rendered composition clamped (`RenderResult`). Set by an MP4
   *  or GIF render; absent from stills and from stored rows. */
  clampedRanges?: ClampedRange[];
}

/** What an Auto frame is sized from, besides the frames (spec 2026-10-06 §2). */
export interface FrameFacts {
  padding: number;
  /** The recording's size when no bundle exists yet. */
  viewport: { width: number; height: number };
}

export function frameOf(
  scene: Pick<SceneDocument, "branding" | "meta">,
): FrameFacts {
  return {
    padding: scene.branding.padding,
    viewport: scene.meta.capture.viewport,
  };
}

/** The recording's size an Auto frame is solved from: the frames'
 *  viewport, or the take's recorded one before any frames exist. The
 *  export panel's readout names the same size. */
export function recordingOf(
  bundle: FrameBundle | null,
  frame: FrameFacts,
): { width: number; height: number } {
  return bundle?.viewport ?? frame.viewport;
}

/** The landscape preset each file type renders at, by the keyframes for MP4
 *  (`pickMp4Tier`: along their long side for Auto, by width for 16:9), no
 *  wider than `maxTier` when one is given. */
function landscapeTier(
  fileType: FileType,
  bundle: FrameBundle | null,
  aspect: SceneAspect,
  maxTier: RenderTarget | undefined,
): RenderTarget {
  switch (fileType) {
    case "mp4": {
      const tier = bundle ? pickMp4Tier(bundle, aspect) : LANDSCAPE_1080P;
      return maxTier !== undefined && maxTier.width < tier.width
        ? maxTier
        : tier;
    }
    case "gif":
      return GIF_800;
    case "stills":
      return STILL_1440;
  }
}

/**
 * The share target for a landscape tier: `SHARE_LANDSCAPE`, or the tier's
 * own frame when that is the smaller, so share never draws more pixels than
 * the keyframes (or a cap) back. The smaller frame keeps share's frame rate
 * and encoder, and its nominal bitrate scales by area, as `autoTarget`'s
 * does. Since share became 2560 wide (2026-10-29), keyframes that back only
 * the 1080p tier reach the second branch too, not only a `maxTier`.
 */
function shareTier(tier: RenderTarget): RenderTarget {
  if (tier.width >= SHARE_LANDSCAPE.width) return SHARE_LANDSCAPE;
  return {
    ...SHARE_LANDSCAPE,
    width: tier.width,
    height: tier.height,
    cornerRadius: tier.cornerRadius,
    bitrate: Math.round(
      (SHARE_LANDSCAPE.bitrate * tier.width * tier.height) /
        (SHARE_LANDSCAPE.width * SHARE_LANDSCAPE.height),
    ),
  };
}

/** The high target for a landscape tier: `HIGH_LANDSCAPE`, or the tier's
 *  own frame when the keyframes (or a cap) back no more, at high's bitrate
 *  or the tier's own when that is lower: high never asks more than full. */
function highTier(tier: RenderTarget): RenderTarget {
  return tier.width >= HIGH_LANDSCAPE.width
    ? HIGH_LANDSCAPE
    : { ...tier, bitrate: Math.min(tier.bitrate, HIGH_LANDSCAPE.bitrate) };
}

/**
 * Maps a file type and the scene's aspect to the compositor's target.
 *
 * Landscape MP4 follows the bundle's keyframes via `pickMp4Tier` — the
 * same logic the headless runner uses, so the preview the author scrubs and
 * the file they get are derived from the same answer. Before a bundle
 * exists there is nothing to measure and 1080p is the floor. 9:16 turns
 * every file type on end.
 *
 * Auto is the landscape tier reshaped to the recording plus an even margin
 * (`landscapeFrame`), the recording's size from `recordingOf`.
 *
 * `quality` (absent: `full`) chooses an MP4's size: `full` is the tier
 * above; `share` is the share target, no larger than that tier
 * (`shareTier`), with Auto reshaping the share frame's long side the same
 * way, and `SHARE_VERTICAL` for 9:16, smaller than any vertical tier;
 * `high` is the same for the high target (`highTier`, `HIGH_VERTICAL`).
 *
 * The preview and the export panel both resolve through this function.
 * So does the CLI's export (`apps/runner/src/executor/export.ts`): one answer for
 * every door.
 *
 * `maxTier` caps a landscape MP4's tier (Auto keeps its shape inside it).
 * Tests only (`ExecutorOptions.mp4MaxTier`): a lane that renders in software
 * asks for 1080p where the keyframes back 4K. No door sets it.
 */
export function targetFor(
  fileType: FileType,
  aspect: SceneAspect,
  bundle: FrameBundle | null,
  frame: FrameFacts,
  options: TargetOptions = {},
): RenderTarget {
  const quality = fileType === "mp4" ? (options.quality ?? "full") : "full";
  if (aspect !== "9:16") {
    const tier = landscapeTier(fileType, bundle, aspect, options.maxTier);
    const shaped = landscapeFrame(
      aspect,
      quality === "share"
        ? shareTier(tier)
        : quality === "high"
          ? highTier(tier)
          : tier,
      recordingOf(bundle, frame),
      frame.padding,
    );
    return quality === "high" && shaped.bitrate > HIGH_MAX_BITRATE
      ? { ...shaped, bitrate: HIGH_MAX_BITRATE }
      : shaped;
  }
  switch (fileType) {
    case "mp4":
      return quality === "share"
        ? SHARE_VERTICAL
        : quality === "high"
          ? HIGH_VERTICAL
          : VERTICAL_1080;
    case "gif":
      return GIF_VERTICAL_450;
    case "stills":
      return STILL_VERTICAL_1080;
  }
}

/** How the CLI's stills are sized and framed. */
export interface StillsOptions {
  /** The canvas's width in px, or `native`: the window drawn at the
   *  recording's own size. Absent: the target's, narrowed so the window is
   *  never drawn wider than the recording. Either way at most
   *  `MAX_STILL_SIDE` on the long side. */
  width?: number | "native";
  /** `none` (absent): the whole window. `step`: the step's zoom, all the
   *  way in. See `StillCamera`. */
  zoom?: "none" | "step";
}

/** The longest side a still is drawn at: 4K. */
export const MAX_STILL_SIDE = 3840;

/**
 * The most bytes a GIF the CLI exports is let grow to before it is made
 * narrower (`renderOutput`'s `gifBudget`, `GIF_WIDTH_LADDER`). GitHub takes
 * an image upload of up to 10 MB, and a GIF is the form that plays inline
 * in a pull request or an issue.
 */
export const GIF_BUDGET_BYTES = 10_000_000;

/** Longest base name, in characters. Chrome's own limit is the
 *  filesystem's (255 bytes on most); 120 leaves room for " stills
 *  (vertical)/", an action id and a de-duplicating " (1)". */
const MAX_BASE = 120;

/** Names Windows reserves for devices, refused by Chrome's downloads API on
 *  every platform — as the whole name before the extension, in any case. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A take's label as a filename Chrome will accept.
 *
 * Chrome's downloads API REFUSES a filename it considers unsafe rather than
 * cleaning it, so an untitled take — labelled by host and path, slash
 * included — would be a failed save. Beyond the reserved punctuation it
 * refuses `~`, every Unicode format character (Cf: the ZWJ inside a joined
 * emoji, a soft hyphen, the direction marks RTL tab titles carry), control
 * characters, and a Windows device name. Punctuation and `~` become `-`,
 * format and control characters go, leading and trailing dots and spaces go
 * (Windows drops them silently, and a leading dot hides the file on macOS),
 * and a device name gains a `-`. Cut by character, never inside one: a
 * lone surrogate is not a name either.
 */
export function exportBaseName(label: string): string {
  const trim = (text: string) => text.replace(/^[\s.]+|[\s.]+$/g, "");
  const cleaned = trim(
    label
      .replace(/[\t\n\r]+/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\p{Cf}/gu, "")
      .replace(/[\\/:*?"<>|~]/g, "-")
      .replace(/ {2,}/g, " "),
  );
  const cut = trim([...cleaned].slice(0, MAX_BASE).join(""));
  if (cut === "") return "demoman";
  return DEVICE_NAME.test(cut) ? `${cut}-` : cut;
}

export function exportFileName(
  fileType: "mp4" | "gif",
  aspect: SceneAspect,
  base: string,
): string {
  const suffix = aspect === "9:16" ? " (vertical)" : "";
  return `${base}${suffix}.${fileType}`;
}

/** Stills are one file per step, so they get a folder of their own. */
export function stillsFolder(aspect: SceneAspect, base: string): string {
  return aspect === "9:16" ? `${base} stills (vertical)` : `${base} stills`;
}

export function contentTypeFor(fileType: FileType): string {
  switch (fileType) {
    case "mp4":
      return "video/mp4";
    case "gif":
      return "image/gif";
    case "stills":
      return "image/png";
  }
}
