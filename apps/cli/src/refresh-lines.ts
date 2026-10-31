import type { RefreshResult } from "@demoman/runner/package";

/** What `demoman refresh` prints and exits with: a line per video with what
 *  its comparison found (why a video was replaced, how near an unchanged one
 *  came), its notes beside it, and 1 when any video failed (CI's only
 *  signal). */
export function refreshLines(result: RefreshResult): {
  lines: string[];
  code: 0 | 1;
} {
  if (result.videos.length === 0)
    return { lines: ["No flows are kept in .demoman/videos/."], code: 0 };
  return {
    lines: result.videos.map((v) => {
      const said = v.detail === "" ? v.outcome : `${v.outcome}: ${v.detail}`;
      const notes = v.notes.length > 0 ? ` (${v.notes.join("; ")})` : "";
      return `${v.name}: ${said}${notes}`;
    }),
    code: result.videos.some((v) => v.outcome === "failed") ? 1 : 0,
  };
}
