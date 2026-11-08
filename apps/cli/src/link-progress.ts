// `demoman link`'s progress on stderr: each phase once as it starts, and a
// render at most every quarter, not a line per frame (a 30 s take at 60 fps
// reports 1,800 frames).
export function linkProgress(
  write: (line: string) => void,
): (p: unknown) => void {
  let phase: string | null = null;
  let quarter = -1;
  return (p) => {
    const {
      phase: ph,
      done,
      total,
      summary,
    } = p as {
      phase?: unknown;
      done?: unknown;
      total?: unknown;
      summary?: unknown;
    };
    if (typeof summary !== "string") return;
    if (
      ph === "rendering" &&
      typeof done === "number" &&
      typeof total === "number" &&
      total > 0
    ) {
      const q = Math.floor((done / total) * 4);
      if (ph === phase && q === quarter) return;
      phase = ph;
      quarter = q;
      write(summary);
      return;
    }
    // Uploading says each part: there are a few, each up to 50 MB.
    if (ph === phase && ph !== "uploading") return;
    phase = typeof ph === "string" ? ph : null;
    quarter = -1;
    write(summary);
  };
}
