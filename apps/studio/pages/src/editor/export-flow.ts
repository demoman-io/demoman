// apps/studio/pages/src/editor/export-flow.ts
import type { ExportEvent } from "../platform/types";
import type { ExportRun, SaveView } from "./export-run";

/** This page's export as the editor draws it: the button's phase, what the
 *  last save came to, and why the last export failed, if it did. */
export interface ExportFlow {
  run: ExportRun;
  save: SaveView | null;
  /** Cleared by the next press; every failed output adds its line. */
  error: string | null;
}

export const IDLE_EXPORT: ExportFlow = {
  run: { phase: "idle" },
  save: null,
  error: null,
};

/** What the page does after an event: redraw, move only the progress bar
 *  (a render per frame would kill a slider drag), re-read the take's
 *  outputs, or nothing. */
export type ExportEffect = "render" | "progress" | "relist" | "none";

const joined = (said: string | null, line: string): string =>
  said === null ? line : `${said}; ${line}`;

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
  switch (event.kind) {
    case "queued":
      // Only while this page's press is still waiting on its first frame.
      return waiting
        ? {
            flow: {
              ...flow,
              run: { phase: "queued", position: event.position },
            },
            effect: "render",
          }
        : { flow, effect: "none" };
    case "rendering":
      // Per frame, whole percents (the renderer throttles).
      return waiting
        ? {
            flow: {
              ...flow,
              run: { phase: "encoding", done: event.done, total: event.total },
            },
            effect: "progress",
          }
        : { flow, effect: "none" };
    case "fileFailed":
      // Kept until the next press; the re-list that follows draws it.
      return {
        flow: { ...flow, error: joined(flow.error, event.line) },
        effect: "none",
      };
    case "saving":
      return { flow: { ...flow, run: { phase: "saving" } }, effect: "render" };
    case "saved":
      return {
        flow: {
          ...flow,
          run: { phase: "idle" },
          // The event's summary rides on the outcome row it belongs to.
          save:
            event.save.kind === "saved" && event.summary !== null
              ? { ...event.save, summary: event.summary }
              : event.save,
        },
        effect: "render",
      };
    case "failed":
      return {
        flow: {
          ...flow,
          run: { phase: "idle" },
          // Null when a `fileFailed` has already said why.
          error:
            event.detail === null
              ? flow.error
              : joined(flow.error, event.detail),
        },
        effect: "render",
      };
    case "outputsChanged":
      // What is stored for this take, whichever tab put it there.
      return { flow, effect: "relist" };
  }
}
