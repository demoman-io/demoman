import type { RevealTarget } from "../platform/types";
import { EXPORT_LABELS } from "./formats";
import type { FileType } from "./jobs";

/** Where this page's own export is. Only this page's job moves it.
 *
 *  One phase fewer than it had: until 2026-09-28 a `rebuilding` phase ran
 *  ahead of `encoding`, because export performed the rebuild on the way out.
 *  The rebuild left the editor for the run page's Re-shoot (plan 2 of the
 *  agent door, Task 7), so a press goes straight to the encode. */
export type ExportRun =
  | { phase: "idle" }
  /** Waiting its turn behind other exports (the studio's queue). `position`
   *  is how many are ahead; 0 is next. The extension never queues. */
  | { phase: "queued"; position: number }
  | { phase: "encoding"; done: number; total: number }
  | { phase: "saving" };

/**
 * Whether there is anything to export.
 *
 * Its own type rather than a boolean for the reason it outlived the rebuild:
 * a take with nothing to export is not `exact`. The panel's answer to
 * `noFrames` is a route, not only a disabled button — "This take has no
 * frames — re-shoot it in Runs", linking to `run.html?take=<takeId>` (spec
 * §7, "A take has no frames": never a disabled Export with no explanation).
 * The take's id and whether it is authored travel beside this, as the
 * panel's `runsRoute`, since 2026-09-28's final review: a take WITH frames
 * draws its route too (I3), so the route is no longer a `noFrames` detail.
 *
 * Until 2026-09-28 it also had `rebuildable` and `frozen` members, decided
 * from the approximations and the replay policy; both left with the rebuild.
 */
export type ExportReadiness = { kind: "exact" } | { kind: "noFrames" };

/** How one stored output's save through the browser's downloads ended
 *  (the extension's; the studio's server saves its own files). */
export type SaveOutcome =
  | { kind: "saved"; downloadId: number; savedAs: string; path: string | null }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

/**
 * What the last save came to, for the panel's outcome row. `failed` counts
 * the saves that worked, so one refused file out of five is said as that
 * and not as "the export failed" — or as "saved".
 */
export type SaveView =
  | {
      kind: "saved";
      names: string[];
      byteLength: number;
      /** What "Show in folder" reveals; null when this side has nothing to
       *  show (no button is drawn). */
      reveal: RevealTarget | null;
      /** The studio's one-sentence account of the export; null on the
       *  extension. */
      summary: string | null;
      /** The stored outputs this save describes, whose warnings the panel
       *  draws under its outcome row. Empty on the studio, whose `summary`
       *  says them and which stores no rows of its own. */
      outputRefs: string[];
    }
  | { kind: "cancelled"; refs: string[]; saved: number; total: number }
  | {
      kind: "failed";
      error: string;
      refs: string[];
      saved: number;
      total: number;
    };

/**
 * The button's words. A running export's label describes the run; at rest it
 * is the plain label for the file type, whatever the readiness — a frameless
 * take's button is disabled, and the reason is drawn beside it, not folded
 * into its label. Exhaustive on the phase, with no fallback.
 *
 * The readiness is still taken, and deliberately ignored: every caller draws
 * the button from one, and a label rule that ever needs it again belongs
 * here rather than in a second function beside this one.
 */
export function exportButtonLabel(
  run: ExportRun,
  fileType: FileType,
  _readiness: ExportReadiness,
): string {
  switch (run.phase) {
    case "idle":
      return EXPORT_LABELS[fileType];
    case "queued":
      return run.position === 0 ? "Queued…" : `Queued (${run.position} ahead)`;
    case "encoding":
      return run.total > 0
        ? `Exporting · ${Math.floor((run.done * 100) / run.total)}%`
        : "Exporting…";
    case "saving":
      return "Saving…";
  }
}

export function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  return mb >= 1
    ? `${Math.round(mb * 10) / 10} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function aggregateSaves(
  results: {
    ref: string;
    name: string;
    byteLength: number;
    outcome: SaveOutcome;
  }[],
): SaveView {
  // `saveOutputs` never calls this with nothing; a caller that does would
  // otherwise get a "saved" view of no files.
  if (results.length === 0)
    throw new Error("aggregateSaves was given no saves");
  const failed = results.filter((r) => r.outcome.kind === "failed");
  const saved = results.filter((r) => r.outcome.kind === "saved");
  if (failed.length > 0) {
    const first = failed[0] as (typeof failed)[number] & {
      outcome: { kind: "failed"; error: string };
    };
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
    return {
      kind: "failed",
      error: `${first.name}: ${first.outcome.error}${more}`,
      // Every file that did NOT save, not just the ones that failed. A set
      // can hold both — file 1's bytes gone from the store, then a cancel
      // that counts files 2 onward as cancelled — and `refs` is what
      // "Download again" is handed. Sending only the failures retried one
      // file while the row said "Saved 0 of 5" and the button promised the
      // set.
      refs: results.filter((r) => r.outcome.kind !== "saved").map((r) => r.ref),
      saved: saved.length,
      total: results.length,
    };
  }
  const cancelled = results.filter((r) => r.outcome.kind === "cancelled");
  if (cancelled.length > 0)
    return {
      kind: "cancelled",
      refs: cancelled.map((r) => r.ref),
      saved: saved.length,
      total: results.length,
    };
  const outcomes = saved.map(
    (r) => r.outcome as Extract<SaveOutcome, { kind: "saved" }>,
  );
  return {
    kind: "saved",
    names: outcomes.map((o) => o.savedAs),
    byteLength: saved.reduce((sum, r) => sum + r.byteLength, 0),
    reveal:
      outcomes[0] === undefined
        ? null
        : { kind: "download", id: outcomes[0].downloadId },
    summary: null,
    outputRefs: saved.map((r) => r.ref),
  };
}
