import type { SceneAspect } from "@demoman/scene-schema";
import { formatLength } from "../library/length";
import type { FileType } from "./jobs";
import { targetFor } from "./jobs";

export { targetFor };

/**
 * The export's copy, in one place. The file types are ticked in the Export
 * panel; the aspect is the scene's, picked under the preview. Each file row
 * describes `targetFor(fileType, aspect, bundle, frame)`, and `main.ts`
 * previews one of them (`previewFileType`), so the framing scrubbed and the
 * file saved are one answer.
 */

export const FILE_TYPE_TITLES: Record<FileType, string> = {
  mp4: "MP4",
  gif: "GIF",
  stills: "PNG stills",
};

/** The panel's file rows, in the order they are drawn and exported. */
export const FILE_TYPES: readonly FileType[] = ["mp4", "gif", "stills"];

/** "Export MP4 + GIF + stills": the ticked files, the first named in full.
 *  "Export", never "Render": "Rebuild" names the replay. Bare "Export"
 *  with nothing ticked, where the button is disabled and the line under it
 *  says why. */
export function exportLabel(fileTypes: readonly FileType[]): string {
  const names = fileTypes.map((t, i) =>
    i > 0 && t === "stills" ? "stills" : FILE_TYPE_TITLES[t],
  );
  return ["Export", names.join(" + ")].filter(Boolean).join(" ");
}

/** "0:24 · 1920 × 1080": one file row's facts, the file it makes. A still
 *  has no length, so it says what it is. */
export function fileFacts(
  fileType: FileType,
  durationMs: number,
  target: { width: number; height: number },
): string {
  const head =
    fileType === "stills" ? "one per step" : formatLength(durationMs);
  return `${head} · ${target.width} × ${target.height}`;
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

/** "Recording 1512 × 820" — the captured page (spec 2026-10-06 §3). Each
 *  file's own size is on its row (`fileFacts`); beside those it is the
 *  reason any bars are there. */
export function sizeReadout(recording: {
  width: number;
  height: number;
}): string {
  return `Recording ${recording.width} × ${recording.height}`;
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
