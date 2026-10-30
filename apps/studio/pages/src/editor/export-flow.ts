// apps/studio/pages/src/editor/export-flow.ts
import type { ExportEvent } from "../platform/types";
import type { ExportRun, SaveView } from "./export-run";
import { FILE_TYPE_TITLES } from "./formats";
import type { FileType } from "./jobs";

/** One file of a press of Export: its type, its job once an event names
 *  it, and how it ended (null while it is waiting or being made). */
export interface ExportFile {
  fileType: FileType;
  jobId: string | null;
  ended: null | "saved" | "failed";
}

/** This page's export as the editor draws it: the button's phase, what the
 *  last save came to, and why the last export failed, if it did. */
export interface ExportFlow {
  /** The phase of the file being made; idle once every file has ended. */
  run: ExportRun;
  /** The last press's files, in the order they are made. */
  files: ExportFile[];
  save: SaveView | null;
  /** Cleared by the next press; every failed output adds its line. */
  error: string | null;
}

export const IDLE_EXPORT: ExportFlow = {
  run: { phase: "idle" },
  files: [],
  save: null,
  error: null,
};

/** A press of Export for these files, before any job has answered. */
export function pressedExport(fileTypes: readonly FileType[]): ExportFlow {
  return {
    run: { phase: "encoding", done: 0, total: 0 },
    files: fileTypes.map((fileType) => ({
      fileType,
      jobId: null,
      ended: null,
    })),
    save: null,
    error: null,
  };
}

/** The file being made: the first that has not ended, or null. */
export function currentFile(files: readonly ExportFile[]): ExportFile | null {
  return files.find((f) => f.ended === null) ?? null;
}

/** What the page does after an event: redraw, move only the progress bar
 *  (a render per frame would kill a slider drag), re-read the take's
 *  outputs, or nothing. */
export type ExportEffect = "render" | "progress" | "relist" | "none";

const joined = (said: string | null, line: string): string =>
  said === null ? line : `${said}; ${line}`;

/**
 * The file `jobId` is, naming it on first sight. The page starts a press's
 * jobs one after another and the studio queues each before it answers, so
 * a job's first event comes before the next job exists: an id not seen yet
 * is the next file still without one. -1 for a job that is none of them.
 */
function claim(
  files: ExportFile[],
  jobId: string,
): { files: ExportFile[]; index: number } {
  const known = files.findIndex((f) => f.jobId === jobId);
  if (known !== -1) return { files, index: known };
  const next = files.findIndex((f) => f.jobId === null && f.ended === null);
  if (next === -1) return { files, index: -1 };
  return {
    files: files.map((f, i) => (i === next ? { ...f, jobId } : f)),
    index: next,
  };
}

/** One press's saves said as one: every file's names, bytes and sentence. */
function mergeSaves(prev: SaveView | null, next: SaveView): SaveView {
  if (prev?.kind !== "saved" || next.kind !== "saved") return next;
  const summaries = [prev.summary, next.summary].filter(
    (s): s is string => s !== null,
  );
  return {
    kind: "saved",
    names: [...prev.names, ...next.names],
    byteLength: prev.byteLength + next.byteLength,
    reveal: prev.reveal ?? next.reveal,
    summary: summaries.length === 0 ? null : summaries.join(" "),
    outputRefs: [...prev.outputRefs, ...next.outputRefs],
  };
}

/**
 * The flow after file `index` ended: the next file's turn, or idle when none
 * is left. A press with no files (a flow built before `files` existed)
 * ends at its first end, as it always did.
 */
function ended(
  files: ExportFile[],
  index: number,
  how: "saved" | "failed",
): Pick<ExportFlow, "run" | "files"> {
  const next = files.map((f, i) => (i === index ? { ...f, ended: how } : f));
  return {
    files: next,
    run:
      currentFile(next) === null
        ? { phase: "idle" }
        : { phase: "encoding", done: 0, total: 0 },
  };
}

/**
 * The export after one of this page's job events. Every event is for a job
 * this page started (`Platform.exports.onEvent`), so another tab's job never
 * frees this tab's Export button.
 */
export function applyExportEvent(
  flow: ExportFlow,
  event: ExportEvent,
): { flow: ExportFlow; effect: ExportEffect } {
  const waiting = flow.run.phase === "encoding" || flow.run.phase === "queued";
  if (event.kind === "outputsChanged") {
    // What is stored for the take, whichever tab put it there.
    return { flow, effect: "relist" };
  }
  const { files, index } = claim(flow.files, event.jobId);
  const current = currentFile(files);
  // Only the file being made moves the button; a later file's `queued`
  // arrives while the first is still rendering.
  const isCurrent = index === -1 || files[index] === current;
  switch (event.kind) {
    case "queued":
      // Only while this page's press is still waiting on its first frame.
      return waiting && isCurrent
        ? {
            flow: {
              ...flow,
              files,
              run: { phase: "queued", position: event.position },
            },
            effect: "render",
          }
        : { flow: { ...flow, files }, effect: "none" };
    case "rendering":
      // Per frame, whole percents (the renderer throttles).
      return waiting && isCurrent
        ? {
            flow: {
              ...flow,
              files,
              run: { phase: "encoding", done: event.done, total: event.total },
            },
            effect: "progress",
          }
        : { flow: { ...flow, files }, effect: "none" };
    case "fileFailed":
      // Kept until the next press; the re-list that follows draws it.
      return {
        flow: { ...flow, files, error: joined(flow.error, event.line) },
        effect: "none",
      };
    case "saving":
      return {
        flow: { ...flow, files, run: { phase: "saving" } },
        effect: "render",
      };
    case "saved":
      return {
        flow: {
          ...flow,
          ...ended(files, index, "saved"),
          // The event's summary rides on the outcome row it belongs to.
          save: mergeSaves(
            flow.save,
            event.save.kind === "saved" && event.summary !== null
              ? { ...event.save, summary: event.summary }
              : event.save,
          ),
        },
        effect: "render",
      };
    case "failed": {
      // Which file it was, once a press makes more than one.
      const file = files.length > 1 ? files[index] : undefined;
      const who =
        file === undefined ? "" : `${FILE_TYPE_TITLES[file.fileType]}: `;
      return {
        flow: {
          ...flow,
          ...ended(files, index, "failed"),
          // Null when a `fileFailed` has already said why.
          error:
            event.detail === null
              ? flow.error
              : joined(flow.error, `${who}${event.detail}`),
        },
        effect: "render",
      };
    }
  }
}
