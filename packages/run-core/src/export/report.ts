import type {
  DetailViolation,
  LoweredZoom,
  UnavailableSpan,
  UnplacedStill,
} from "@demoman/compositor";
import type { SceneAspect, SceneDocument } from "@demoman/scene-schema";
import { ZOOM_FLOOR_SCALE } from "../auto-zoom.js";
import type { EditedStep, TargetCheck } from "../refilm/edited.js";
import type {
  ExportQuality,
  FileType,
  RenderedFile,
  RenderProgress,
} from "./target.js";

/**
 * A click whose zoom the video does not play as it was asked for, named by
 * the click (`click`, in a script target's words) so an agent can find it:
 *
 * - `skipped`: the take has no zoom on it, because the target fits the
 *   viewport only at `fitsAt`, under the `floor` (`zoomsForClicks`).
 * - `lowered`, `by: "cap"`: a 9:16 frame held it to `got`, the vertical
 *   cap (`verticalCameraIntents`). Every zoom in a 9:16 frame is, so the
 *   verdict says these once, not per click (author, 2026-10-14); the list
 *   keeps each one so an agent can ask which.
 * - `lowered`, `by: "fit"`: a 9:16 frame narrowed it to `got` so its target
 *   fits the crop (`fitScaleFor`); 1 means the camera only pans to it.
 *
 * Until 2026-10-14 an export where every zoom had been dropped, capped or
 * narrowed answered exactly like one where none had: the facts were in the
 * scene (`zoomsSkipped`) and the compositor's notes, and no CLI consumer
 * read either.
 */
export type ZoomWarning =
  | {
      kind: "skipped";
      /** `targetTooWide`, or `textTooWide` in a take saved 2026-10-09..10,
       *  where `fitsAt` was the widest zoom that cut no line of text. */
      because: "targetTooWide" | "textTooWide";
      actionId: string;
      click: string;
      fitsAt: number;
      floor: number;
    }
  | {
      kind: "lowered";
      by: "cap" | "fit";
      actionId: string;
      click: string;
      asked: number;
      got: number;
    };

/** The longest page-given name a summary quotes, in characters. */
export const CLICK_NAME_MAX = 60;

/** A name the page chose, made safe to quote in a sentence an agent is told
 *  to pass on as it is: one line, no control or invisible formatting
 *  characters (a right-to-left override, say), at most
 *  CLICK_NAME_MAX characters, and quoted with its own quotes escaped, so a
 *  label can neither close the quote nor add a paragraph to the summary. An
 *  element's whole text content can be a page long. */
function quoted(name: string): string {
  // Code points, not UTF-16 units: a cut through a surrogate pair would
  // print a lone `\ud83d` where an emoji was.
  const line = [...name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()];
  return JSON.stringify(
    line.length > CLICK_NAME_MAX
      ? `${line.slice(0, CLICK_NAME_MAX - 1).join("")}…`
      : line.join(""),
  );
}

/** A role as the sentence prints it. `computeRole` takes the first token of
 *  the page's own `role` attribute without checking it against ARIA's list,
 *  so a page chooses it too: a plain role word (`button`, `menuitem`)
 *  prints bare, anything else is quoted like a name. */
function roleOf(role: string): string {
  return /^[a-z]{1,30}$/.test(role) ? role : quoted(role);
}

/** A click as a script would target it: the forms `scriptStepLabel` prints.
 *  The action id when the recording kept no name, rather than nothing. */
function clickName(scene: SceneDocument, actionId: string): string {
  const anchorId = scene.actions.find((a) => a.id === actionId)?.anchorId;
  const f = scene.anchors.find((a) => a.id === anchorId)?.fingerprint;
  if (f === undefined) return `click ${actionId}`;
  const name = f.accessibleName?.trim();
  if (f.role !== null && name)
    return `click on ${roleOf(f.role)} ${quoted(name)}`;
  const text = f.textContent?.trim();
  if (text) return `click on text ${quoted(text)}`;
  if (f.stableId !== null) return `click on stableId ${quoted(f.stableId)}`;
  return `click ${actionId}`;
}

/**
 * Every click whose zoom the export does not play as asked, in the take's
 * own order: the zooms the take left out under the floor (`zoomsSkipped`;
 * the closeness skips are not zooms changed, only zooms not doubled) and
 * the ones the render capped or narrowed (`RenderResult.loweredZooms`).
 */
export function zoomWarnings(
  scene: SceneDocument,
  lowered: readonly LoweredZoom[],
): ZoomWarning[] {
  const order = new Map(scene.actions.map((a, i) => [a.id, i] as const));
  const skipped: ZoomWarning[] = (scene.zoomsSkipped ?? []).flatMap((skip) =>
    skip.reason === "targetTooWide" || skip.reason === "textTooWide"
      ? [
          {
            kind: "skipped" as const,
            because: skip.reason,
            actionId: skip.actionId,
            click: clickName(scene, skip.actionId),
            fitsAt: skip.scale,
            floor: ZOOM_FLOOR_SCALE,
          },
        ]
      : [],
  );
  const changed: ZoomWarning[] = lowered.map((zoom) => ({
    kind: "lowered" as const,
    by: zoom.by,
    actionId: zoom.actionId,
    click: clickName(scene, zoom.actionId),
    asked: zoom.asked,
    got: zoom.got,
  }));
  return [...skipped, ...changed].sort(
    (a, b) =>
      (order.get(a.actionId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.actionId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Where a rendered file was saved, as whoever saved it says. The extension's
 * `SaveOutcome` (`adapters/downloads.ts`, through chrome.downloads) is one;
 * the CLI's folder save (`apps/runner/src/executor/save.ts`) is the other.
 * `downloadId` is Chrome's id for the download, and null when no browser
 * download made the file — never a made-up number.
 */
export type SavedTo =
  | {
      kind: "saved";
      downloadId: number | null;
      savedAs: string;
      path: string | null;
    }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

/**
 * What the run page's Export says (spec 2026-10-01 §2.3), as `#export-report`.
 * Every way an export can end has its own `outcome`, and only `saved` means a
 * file is on disk at a path someone measured.
 */
export type ExportRefusal =
  | "noTakeId"
  | "takeNotFound"
  | "takeUnreadable"
  | "noFrames"
  | "busy"
  | "invalidFileType"
  | "invalidStillsOptions"
  | "invalidQuality"
  | "invalidMaxMB"
  | "fileTypeUnsupported";

export interface ExportWarnings {
  logo: string | null;
  unavailableSpans: UnavailableSpan[];
  detailViolations: DetailViolation[];
  /** Steps a stills export made no file for (`UnplacedStill`). Present on
   *  a stills report only. */
  unplacedStills?: UnplacedStill[];
  /** Clicks whose zoom the video does not play as asked
   *  (`zoomWarnings`). Absent: this door does not report them (the
   *  extension's export, today); empty: every zoom played as asked. */
  zooms?: ZoomWarning[];
  /** What reading the take took away from it, one sentence each
   *  (`migrateToCurrent`'s notes): schema 12 removed text overlays.
   *  Absent: nothing was taken away. */
  migration?: string[];
  /** Steps whose scene.json no longer matches what the frames filmed
   *  (`editedSinceRecorded`). Absent: this door does not compute it, or
   *  there was no record to compare against; empty: nothing was edited. */
  editedSinceRecorded?: EditedStep[];
  /** Whether a target edited in place could be looked for (`targetCheckOf`).
   *  Only `{ unreadable }` reaches the summary: a take with no skeleton
   *  (filmed before skeletons existed) has none, and the summary stays
   *  silent about that, so this field is the only record of it. */
  targetCheck?: TargetCheck;
  /** How many masks the take has. A re-film (`run({ takeId })`)
   *  leaves every one behind (`notCarried`), so an edited take's
   *  summary says so. Absent: this door does not count them. */
  masks?: number;
  /** A GIF the CLI rendered under a byte budget (`renderOutput`'s
   *  `gifBudget`): the widths it would not fit at, widest first, and the
   *  kept file's size — over `maxBytes` when even the narrowest did not
   *  fit. Absent: no budget (an MP4, stills, or the extension's export). */
  gifSize?: GifSize;
  /** What an MP4 was made at and how big it is: the quality asked for and
   *  the saved file's size, said in the summary's head. Set only by the
   *  CLI door's MP4 save. Absent: the extension's export (its summary is
   *  unchanged), a GIF or stills. */
  videoSize?: VideoSize;
  /** Stills whose asked width (`width` or `native`) the 4K cap cut: the
   *  width asked for. Absent: nothing was cut. */
  stillsCapped?: { askedWidth: number };
  /** The file was saved but the take's `outputs.json` would not take its
   *  row, so the studio's list of exports will not show it: why. Absent:
   *  it is listed (or this door keeps no such list). */
  notListed?: { error: string };
}

/**
 * Which of a capped MP4's renders a frame of progress belongs to: the
 * `render`th, out of `upTo` the ladder can take from the first target. A
 * step that keeps the width (the frame rate, the quality) starts again from
 * frame 0 at the same width, so the width alone cannot say it is a new
 * render (review, 2026-10-18).
 */
export interface CapRender {
  render: number;
  upTo: number;
}

/** One step a size cap took to make a video fit (spec 2026-10-18 §8), in
 *  the order the ladder takes them: 60 to 30 fps, then the share target's
 *  frame, then quality 0.35. */
export type VideoStep =
  | { kind: "fps"; from: number; to: number }
  | {
      kind: "share";
      from: { width: number; height: number };
      to: { width: number; height: number };
      /** The share target's `encoder.quality`, which this step also went
       *  to: a full export already at the share frame lowered only this,
       *  and the summary names it then rather than an unchanged frame. */
      quality?: number;
    }
  | { kind: "quality"; from: number; to: number };

/** A size cap on a video (`export({ maxMB })`): what it was, whether the
 *  kept file meets it, and the steps taken to try, in order. A cap that fit
 *  at the first render took none. Filled by `renderOutput`'s `mp4Cap`. */
export interface VideoCap {
  maxBytes: number;
  /** The kept file is at most `maxBytes`. False: every step was taken and
   *  the smallest file was kept anyway, still `saved`. */
  met: boolean;
  steps: VideoStep[];
  /** The kept file's `encoder.quality`, or null when it was encoded by
   *  bitrate (a full-quality render). With the file's frame and fps it is
   *  what a cap that was not met names as the smallest it goes. */
  keptQuality: number | null;
  /** A step whose render threw, and why. The ladder stopped there and kept
   *  the smallest file made before it, so `met` is false; `steps` holds
   *  only the steps that rendered. Absent: no render after the first
   *  threw. */
  failed?: { step: VideoStep; error: string };
}

export interface VideoSize {
  quality: ExportQuality;
  byteLength: number;
  /** No quality was asked for and the Export quality setting could not be
   *  read: why. `quality` is then the default in its place. */
  settingUnreadable?: string;
  cap?: VideoCap;
}

export interface GifSize {
  maxBytes: number;
  byteLength: number;
  /** Widest first. `detail`: the recording lacks the pixels for that width
   *  (never said in the summary — the GIF is as sharp as the frames allow);
   *  `budget`: it was over `maxBytes`. */
  refused: { width: number; height: number; limit: "detail" | "budget" }[];
}

type SavedCommon = {
  outcome: "saved";
  takeId: string;
  aspect: SceneAspect;
  width: number;
  height: number;
  fps: number;
  warnings: ExportWarnings;
};

export type ExportReport =
  | { outcome: "refusedBeforeExport"; reason: ExportRefusal; detail: string }
  | {
      outcome: "exporting";
      phase: "rendering" | "saving";
      done: number;
      total: number;
      /** A budgeted GIF's or a capped MP4's width this pass: a re-render
       *  starts again from frame 0 (`renderOutput`'s `gifBudget`,
       *  `mp4Cap`). */
      width?: number;
      /** A capped MP4's render this is, and how many the ladder may take:
       *  its fps and quality steps keep the width. */
      pass?: CapRender;
    }
  | (SavedCommon & {
      fileType: "mp4" | "gif";
      file: { path: string; byteLength: number; downloadId: number | null };
    })
  | (SavedCommon & {
      fileType: "stills";
      folder: { path: string; files: { name: string; byteLength: number }[] };
    })
  | { outcome: "renderFailed"; takeId: string; error: string }
  | {
      outcome: "saveFailed";
      takeId: string;
      error: string;
      /** The folder refused before anything was rendered (the CLI checks
       *  it first): no video exists anywhere. Absent, the video rendered
       *  and only its save failed. */
      beforeRender?: true;
      /** A stills folder that stopped partway: what is on disk, what is not. */
      partial?: { folder: string; written: string[]; notWritten: string[] };
      /** What was asked for, so the sentence names it. Absent: an MP4
       *  (every report before the CLI made GIFs and stills). */
      fileType?: FileType;
    }
  | {
      outcome: "pathUnknown";
      takeId: string;
      name: string;
      downloadId: number | null;
      detail: string;
    }
  | { outcome: "threw"; error: string };

export type RenderSettled =
  | { kind: "rendered"; file: RenderedFile }
  | { kind: "failed"; error: string };

/**
 * One job's progress events, up to its `finished`, as the file it made or the
 * reason it made none. A `failed` anywhere wins over an `output`: a job that
 * said it failed has not produced a file anyone should send.
 */
export function settleRender(events: readonly RenderProgress[]): RenderSettled {
  const failures = events.flatMap((e) =>
    e.kind === "failed" ? [e.error] : [],
  );
  if (failures.length > 0)
    return { kind: "failed", error: failures.join("; ") };
  const files = events.flatMap((e) => (e.kind === "output" ? e.files : []));
  if (files.length === 0) {
    return {
      kind: "failed",
      error: "the export finished without producing a file",
    };
  }
  if (files.length > 1) {
    return {
      kind: "failed",
      error: `the export produced ${files.length} files where one MP4 was expected`,
    };
  }
  return { kind: "rendered", file: files[0] as RenderedFile };
}

/** A rendered file's save, as the report. `pathUnknown` is its own outcome:
 *  the file is probably on disk, but the agent's whole job is to name where,
 *  and a guessed path reads exactly like a measured one. */
export function reportForSave(args: {
  takeId: string;
  fileType: "mp4" | "gif";
  file: RenderedFile;
  saved: SavedTo;
  aspect: SceneAspect;
  target: { width: number; height: number; fps: number };
  /** See `warnings.zooms`. Omitted by a door that does not measure them. */
  zooms?: ZoomWarning[];
  /** See `warnings.migration`. */
  migration?: string[];
  /** See `warnings.editedSinceRecorded`. */
  editedSinceRecorded?: EditedStep[];
  /** See `warnings.targetCheck`. */
  targetCheck?: TargetCheck;
  /** See `warnings.masks`: `scene.edits.masks.length`. */
  masks?: number;
  /** See `warnings.gifSize`. */
  gifSize?: GifSize;
  /** See `warnings.videoSize`. Omitted by a door that does not say it. */
  videoSize?: VideoSize;
}): ExportReport {
  const { takeId, file, saved } = args;
  switch (saved.kind) {
    case "cancelled":
      return {
        outcome: "saveFailed",
        takeId,
        error: "the save was cancelled in Chrome",
        fileType: args.fileType,
      };
    case "failed":
      return {
        outcome: "saveFailed",
        takeId,
        error: saved.error,
        fileType: args.fileType,
      };
    case "saved":
      if (saved.path === null) {
        return {
          outcome: "pathUnknown",
          takeId,
          name: saved.savedAs,
          downloadId: saved.downloadId,
          detail:
            "Chrome reported the download complete but could not say where it is — look in Chrome's downloads list for this name",
        };
      }
      return {
        outcome: "saved",
        fileType: args.fileType,
        takeId,
        file: {
          path: saved.path,
          byteLength: file.byteLength,
          downloadId: saved.downloadId,
        },
        aspect: args.aspect,
        width: args.target.width,
        height: args.target.height,
        fps: args.target.fps,
        warnings: warningsOf(
          {
            logoWarning: file.logoWarning ?? null,
            unavailableSpans: file.unavailableSpans ?? [],
            detailViolations: file.detailViolations,
          },
          args,
        ),
      };
  }
}

function warningsOf(
  facts: {
    logoWarning: string | null;
    unavailableSpans: UnavailableSpan[];
    detailViolations: DetailViolation[];
    unplacedStills?: UnplacedStill[];
  },
  args: {
    zooms?: ZoomWarning[];
    migration?: string[];
    editedSinceRecorded?: EditedStep[];
    targetCheck?: TargetCheck;
    masks?: number;
    gifSize?: GifSize;
    videoSize?: VideoSize;
    stillsCapped?: { askedWidth: number };
  },
): ExportWarnings {
  return {
    logo: facts.logoWarning,
    unavailableSpans: facts.unavailableSpans,
    detailViolations: facts.detailViolations,
    ...(facts.unplacedStills === undefined
      ? {}
      : { unplacedStills: facts.unplacedStills }),
    ...(args.zooms === undefined ? {} : { zooms: args.zooms }),
    ...(args.migration === undefined || args.migration.length === 0
      ? {}
      : { migration: args.migration }),
    ...(args.editedSinceRecorded === undefined
      ? {}
      : { editedSinceRecorded: args.editedSinceRecorded }),
    ...(args.targetCheck === undefined
      ? {}
      : { targetCheck: args.targetCheck }),
    ...(args.masks === undefined ? {} : { masks: args.masks }),
    ...(args.gifSize === undefined ? {} : { gifSize: args.gifSize }),
    ...(args.videoSize === undefined ? {} : { videoSize: args.videoSize }),
    ...(args.stillsCapped === undefined
      ? {}
      : { stillsCapped: args.stillsCapped }),
  };
}

/** Where a stills folder was saved: the folder and what is in it, or the
 *  reason it is not whole (`partial`: what is on disk and what is not). */
export type StillsSavedTo =
  | {
      kind: "saved";
      path: string;
      files: { name: string; byteLength: number }[];
    }
  | {
      kind: "failed";
      error: string;
      partial?: { folder: string; written: string[]; notWritten: string[] };
    };

/** A stills folder's save, as the report. */
export function reportForStillsSave(args: {
  takeId: string;
  saved: StillsSavedTo;
  aspect: SceneAspect;
  target: { width: number; height: number; fps: number };
  facts: {
    logoWarning: string | null;
    unavailableSpans: UnavailableSpan[];
    detailViolations: DetailViolation[];
    unplacedStills: UnplacedStill[];
  };
  zooms?: ZoomWarning[];
  migration?: string[];
  editedSinceRecorded?: EditedStep[];
  targetCheck?: TargetCheck;
  masks?: number;
  /** See `warnings.stillsCapped`. */
  stillsCapped?: { askedWidth: number };
}): ExportReport {
  const { takeId, saved } = args;
  if (saved.kind === "failed") {
    return {
      outcome: "saveFailed",
      takeId,
      error: saved.error,
      fileType: "stills",
      ...(saved.partial === undefined ? {} : { partial: saved.partial }),
    };
  }
  return {
    outcome: "saved",
    fileType: "stills",
    takeId,
    folder: { path: saved.path, files: saved.files },
    aspect: args.aspect,
    width: args.target.width,
    height: args.target.height,
    fps: args.target.fps,
    warnings: warningsOf(args.facts, args),
  };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** `s` trimmed and ended with a full stop unless it already ends a
 *  sentence: how a detail is said inside a summary. */
export const sentence = (s: string): string =>
  /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;

/**
 * A file's size as a person reads it, base 10: `13.2 MB` (one decimal,
 * none when it is whole), and under 1 MB in KB (`412 KB`), where a short
 * take's "0.0 MB" would name nothing. The one helper for every size a
 * summary says: the export's and the gh attach's.
 */
export const fileSize = (bytes: number) => {
  const kb = Math.round(bytes / 1000);
  if (kb < 1000) return `${bytes > 0 ? Math.max(1, kb) : 0} KB`;
  return `${Math.round(bytes / 100_000) / 10} MB`;
};

/** Where a cap step went: a share step names the frame and the quality
 *  when both changed, the quality alone when the frame did not (a full
 *  export already at the share frame). */
function capStepTarget(step: VideoStep): string {
  switch (step.kind) {
    case "fps":
      return `${step.to} fps`;
    case "share": {
      const frame = `${step.to.width}×${step.to.height}`;
      const same =
        step.from.width === step.to.width &&
        step.from.height === step.to.height;
      if (step.quality === undefined) return frame;
      return same
        ? `quality ${step.quality}`
        : `${frame} at quality ${step.quality}`;
    }
    case "quality":
      return `quality ${step.to}`;
  }
}

/**
 * A size cap the file misses, said right after the file's size: the kept
 * file's frame rate, frame and quality, or where lowering it failed. Null
 * when the cap was met (the head says the size as any MP4's does).
 */
function videoCapClause(
  videoSize: VideoSize | undefined,
  frame: { width: number; height: number; fps: number },
): string | null {
  const cap = videoSize?.cap;
  if (cap === undefined) return null;
  // The cap as it was asked for (`maxMB`), never rounded or restated:
  // `fileSize` would call a 0.05 MB cap "50 KB" and a 9.96 MB one "10 MB".
  const max = `${cap.maxBytes / 1_000_000} MB`;
  // Met, however it got there: the file is the size asked for, and what
  // the ladder lowered stays in `warnings.videoSize.cap.steps`.
  if (cap.met) return null;
  if (cap.failed !== undefined) {
    // The ladder stopped short: the kept file is not the smallest it goes,
    // and the reason it is not is said whole.
    return `: over the ${max} asked for; lowering it further failed at ${capStepTarget(cap.failed.step)}: ${cap.failed.error.trim().replace(/[.!?]+$/, "")}`;
  }
  const quality =
    cap.keptQuality === null ? "full quality" : `quality ${cap.keptQuality}`;
  return `: over the ${max} asked for even at the smallest it goes (${frame.fps} fps, ${frame.width}×${frame.height}, ${quality})`;
}

/** A budgeted GIF over the budget even at its narrowest. One made
 *  narrower to fit is said nowhere but `warnings.gifSize`. */
function gifOverBudget(gifSize: GifSize | undefined, width: number): string[] {
  if (gifSize === undefined || gifSize.byteLength <= gifSize.maxBytes)
    return [];
  return [
    `it is ${fileSize(gifSize.byteLength)}, over the ${fileSize(gifSize.maxBytes)} a GIF is kept under even at ${width} px wide; an MP4 of this take is much smaller`,
  ];
}

/** Steps a stills export made no file for: counted, with the first one's
 *  reason said whole. The reasons are the compositor's own sentences (the
 *  editor's "No still for a step you cut" row prints the same text), and
 *  `warnings.unplacedStills` keeps every step. */
function unplacedClauses(unplaced: readonly UnplacedStill[]): string[] {
  const first = unplaced[0];
  if (first === undefined) return [];
  return [
    `${plural(unplaced.length, "step got no still", "steps got no still")} (${first.actionId}: ${first.reason})`,
  ];
}

/** One edit, said whole. Each kind names what the video shows, since an
 *  added step is not in it and a removed one still is. */
function editedWhat(e: EditedStep): string {
  switch (e.what) {
    case "text":
      return `${e.actionId}: "${e.was ?? ""}" → "${e.now ?? ""}"; the video still shows the old text`;
    case "kind":
      // A re-film refuses a changed verb (it never guesses which was
      // meant); derive takes the scene's and says so.
      return `${e.actionId}: its step changed from ${e.was ?? ""} to ${e.now ?? ""}; the video shows the step as recorded — derive this take, check the step, and run the draft`;
    case "target":
      return `${e.actionId}: its target changed; the video shows the step as recorded`;
    case "added":
      return `${e.actionId}: added after recording; it is not in the video`;
    case "removed":
      return `${e.actionId}: removed after recording; the video still shows it`;
  }
}

/** Steps the take was edited on after it was filmed: counted, with the
 *  first one said whole, and the move that makes the video match. That move
 *  is `run({ takeId })` unless a step's verb changed, which a re-film
 *  refuses: then it is derive, check, run. */
function editedClauses(
  edited: readonly EditedStep[],
  takeId: string,
  masks: number,
): string[] {
  const first = edited[0];
  if (first === undefined) return [];
  const changed = edited.find((e) => e.what === "kind");
  const move =
    changed === undefined
      ? ` — run({ takeId: "${takeId}" }) re-records it`
      : changed === first
        ? ""
        : ` — ${changed.actionId}'s step changed from ${changed.was ?? ""} to ${changed.now ?? ""}, so derive this take, check the step, and run the draft`;
  return [
    `${plural(edited.length, "step was", "steps were")} edited after recording (${editedWhat(first)})${move}`,
    ...(masks > 0
      ? [`a re-recording leaves its ${plural(masks, "mask", "masks")} behind`]
      : []),
  ];
}

/**
 * A report as the run page paints it and the agent bridge answers it: the
 * report, plus the sentence `#export-verdict` shows.
 *
 * Until 2026-10-11 the answer carried only the report, so an agent read
 * `warnings.detailViolations` as raw numbers — nine entries for one
 * six-click take, each of which the recipe asked it to name — while a person
 * read one sentence. `summary` is that sentence, so both say the same thing.
 */
export type ExportAnswer = ExportReport & {
  summary: string;
  /** A failed export's: no quality was asked for and the Export quality
   *  setting could not be read, why. A saved MP4 says it in
   *  `warnings.videoSize.settingUnreadable` instead. */
  settingUnreadable?: string;
};

export function withSummary(report: ExportReport): ExportAnswer {
  return { ...report, summary: exportVerdict(report) };
}

/**
 * What a saved export's sentence says "but" about, one clause each: only
 * what the person asked for and the file does not have — a logo left out,
 * motion shown as a still, a step with no still, an edit the video does
 * not show, a GIF over its budget. Empty: the file is what was asked for.
 * Demoman's own framing calls (a zoom skipped, narrowed or held, an
 * upscaled frame, a narrower GIF, a capped still) stay in `warnings` and
 * out of the sentence: the person cannot act on them, and the studio is
 * where a take is changed (author, 2026-10-20). `exportVerdict` joins them
 * into its sentence; the studio's history rows count them.
 */
export function exportCaveats(
  report: Extract<ExportReport, { outcome: "saved" }>,
): string[] {
  const {
    logo,
    unavailableSpans,
    migration,
    editedSinceRecorded,
    masks,
    unplacedStills,
    gifSize,
    videoSize,
  } = report.warnings;
  return [
    ...(videoSize?.settingUnreadable === undefined
      ? []
      : [
          `it is ${videoSize.quality} quality, not your Export quality setting, which could not be read (${videoSize.settingUnreadable.replace(/\.$/, "")})`,
        ]),
    ...(logo === null ? [] : [`the logo is missing (${logo})`]),
    ...(unavailableSpans.length === 0
      ? []
      : [
          `${plural(unavailableSpans.length, "stretch of motion is a still", "stretches of motion are stills")}`,
        ]),
    ...unplacedClauses(unplacedStills ?? []),
    // Each note is a whole sentence; a clause carries no period of its own.
    ...(migration ?? []).map((note) => note.replace(/\.$/, "")),
    ...editedClauses(editedSinceRecorded ?? [], report.takeId, masks ?? 0),
    ...gifOverBudget(gifSize, report.width),
  ];
}

/** `#export-verdict`: one sentence per outcome, and only `saved` begins
 *  "Saved". Exhaustive on `outcome`, with no fallback. */
export function exportVerdict(report: ExportReport): string {
  switch (report.outcome) {
    case "refusedBeforeExport":
      return `Not exported: ${sentence(report.detail)}`;
    case "exporting":
      if (report.phase === "saving") return "Exporting — saving the file.";
      return report.total === 0
        ? "Exporting — preparing the render."
        : report.pass !== undefined
          ? `Exporting — render ${report.pass.render} of up to ${report.pass.upTo} to fit the size asked for: frame ${report.done} of ${report.total}${report.width === undefined ? "" : `, ${report.width} px wide`}.`
          : `Exporting — rendering frame ${report.done} of ${report.total}${report.width === undefined ? "" : `, ${report.width} px wide`}.`;
    case "saved": {
      const { videoSize, notListed } = report.warnings;
      const but = exportCaveats(report);
      const capClause =
        report.fileType === "stills" ? null : videoCapClause(videoSize, report);
      const head =
        report.fileType === "stills"
          ? `Saved ${plural(report.folder.files.length, "still", "stills")} in ${report.folder.path} (${report.width}×${report.height})`
          : capClause !== null && videoSize !== undefined
            ? // The size leaves the brackets to lead what the cap cost.
              `Saved ${report.file.path} (${report.width}×${report.height}, ${report.fps} fps), ${fileSize(videoSize.byteLength)}${capClause}`
            : `Saved ${report.file.path} (${report.width}×${report.height}, ${report.fps} fps${videoSize === undefined ? "" : `, ${fileSize(videoSize.byteLength)}`})`;
      const said =
        but.length === 0 ? `${head}.` : `${head}, but ${but.join("; ")}.`;
      return notListed === undefined
        ? said
        : `${said} It was saved, but not listed in the take's exports: ${notListed.error}.`;
    }
    case "renderFailed":
      return `The render failed, so no file was made: ${sentence(report.error)}`;
    case "saveFailed":
      if (report.partial !== undefined) {
        const { folder, written, notWritten } = report.partial;
        const total = written.length + notWritten.length;
        return `Only ${written.length} of ${plural(total, "still", "stills")} ${written.length === 1 ? "is" : "are"} on disk, in ${folder}: ${sentence(report.error)}`;
      }
      {
        const what =
          report.fileType === "stills"
            ? { noun: "stills", are: "are" }
            : { noun: report.fileType === "gif" ? "GIF" : "video", are: "is" };
        return report.beforeRender === true
          ? `Nothing was rendered, because the ${what.noun} could not be saved there: ${sentence(report.error)}`
          : `The ${what.noun} rendered but ${what.are} not on disk: ${sentence(report.error)}`;
      }
    case "pathUnknown":
      return `The download finished, but its path is unknown: ${sentence(report.detail)}`;
    case "threw":
      return `The export failed unexpectedly rather than reporting a result: ${sentence(report.error)} Check the console for its stack.`;
  }
}
