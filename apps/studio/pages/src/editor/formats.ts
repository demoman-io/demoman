import type { RenderTarget } from "@demoman/compositor";
import type { SceneAspect } from "@demoman/scene-schema";
import { formatLength } from "../library/length";
import type { FileType } from "./jobs";
import { targetFor } from "./jobs";

export { targetFor };

/**
 * The export's copy, in one place. The file type is picked in the Export
 * panel; the aspect is the scene's, picked under the preview. `main.ts`
 * previews `targetFor(fileType, aspect, bundle, frame)` and the panel describes the
 * same target, so the framing scrubbed and the file saved are one answer.
 */

export const FILE_TYPE_TITLES: Record<FileType, string> = {
  mp4: "MP4",
  gif: "GIF",
  stills: "PNG stills",
};

/** "Export", never "Render": "Rebuild" names the replay. */
export const EXPORT_LABELS: Record<FileType, string> = {
  mp4: "Export MP4",
  gif: "Export GIF",
  stills: "Export PNG stills",
};

/** "MP4 · 0:24". A still has no length, so it says what it is. The file's
 *  size is `sizeReadout`'s, under it in the same box (review, 2026-10-06:
 *  said here too, it was said twice, two ways). */
export function exportSummary(fileType: FileType, durationMs: number): string {
  const tail =
    fileType === "stills" ? "one per step" : formatLength(durationMs);
  return [FILE_TYPE_TITLES[fileType], tail].join(" · ");
}

/** The deliverable's name inside a sentence — the logo notes' "No room for
 *  the logo in Vertical GIF". */
export function deliverableTitle(
  fileType: FileType,
  aspect: SceneAspect,
): string {
  const portrait = aspect === "9:16";
  switch (fileType) {
    case "mp4":
      if (portrait) return "Vertical video";
      return aspect === "auto" ? "Video" : "Landscape video";
    case "gif":
      return portrait ? "Vertical GIF" : "GIF";
    case "stills":
      return portrait ? "Vertical PNG stills" : "PNG stills";
  }
}

export function aspectNote(aspect: SceneAspect): string {
  switch (aspect) {
    case "auto":
      return "Auto, set under the preview — the video takes the recording's shape";
    case "9:16":
      return "9:16, set under the preview — the camera follows each step";
    case "16:9":
      return "16:9, set under the preview";
  }
}

/** "Recording 1512 × 820 · Video 1920 × 1042" — the captured page and the
 *  file the selected format makes (spec 2026-10-06 §3). In 16:9 and 9:16
 *  it is the reason any bars are there. */
export function sizeReadout(
  recording: { width: number; height: number },
  target: RenderTarget,
): string {
  return `Recording ${recording.width} × ${recording.height} · Video ${target.width} × ${target.height}`;
}

/** "0:10 · 1920 × 1080" — the header's line beside the take's name: how
 *  long the deliverable runs and the size of the file the selected format
 *  makes. The same two facts the Export panel's summary and size readout
 *  give, shortened for a line that is always on screen.
 *
 *  Rounded as the Recordings card's badge is (`formatLength`), so one take
 *  has one length on both pages. And always on screen means it is on
 *  screen when there is nothing to export too, so a take with no frames,
 *  or a trim with nothing left in it, says so here rather than showing the
 *  line a ready take shows. Stills have a size but no length. */
export function takeMeta(state: {
  durationMs: number;
  fileType: FileType;
  target: { width: number; height: number };
  hasFrames: boolean;
}): string {
  if (!state.hasFrames) return "No frames to export";
  if (state.durationMs <= 0) return "Nothing left to export";
  const size = `${state.target.width} × ${state.target.height}`;
  return state.fileType === "stills"
    ? `${FILE_TYPE_TITLES.stills} · ${size}`
    : `${formatLength(state.durationMs)} · ${size}`;
}
