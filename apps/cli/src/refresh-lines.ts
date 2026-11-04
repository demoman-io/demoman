import type { RefreshResult } from "@demoman/runner/package";

/** What `demoman refresh` prints and exits with: a line per video with what
 *  its comparison found (one word per outcome: changed, added, uncompared,
 *  unchanged or failed; then why, or how near an unchanged one came), its
 *  notes beside it, and 1 when any video failed (CI's only
 *  signal). */
export function refreshLines(
  result: RefreshResult,
  /** What starting the app said, printed first. */
  app: string[] = [],
): {
  lines: string[];
  code: 0 | 1;
} {
  const { lines, code } = videoLines(result);
  return { lines: [...app, ...lines], code };
}

function videoLines(result: RefreshResult): {
  lines: string[];
  code: 0 | 1;
} {
  if (result.videos.length === 0)
    return {
      lines: [
        "No flows in .demoman/flows/. Add one with npx demoman add <flow> --to <path>.",
      ],
      code: 0,
    };
  return {
    lines: result.videos.map((v) => {
      const said = v.detail === "" ? v.outcome : `${v.outcome}: ${v.detail}`;
      const notes = v.notes.length > 0 ? ` (${v.notes.join("; ")})` : "";
      return `${v.name}: ${said}${notes}`;
    }),
    code: result.videos.some((v) => v.outcome === "failed") ? 1 : 0,
  };
}

/** What `demoman refresh` says and exits with when the app does not start:
 *  the reason and its detail, exit 1. Nothing was refreshed or recorded. */
export function appRefusal(refusal: { reason: string; detail: string }): {
  line: string;
  code: 1;
} {
  return { line: `${refusal.reason}: ${refusal.detail}`, code: 1 };
}
