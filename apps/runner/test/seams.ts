/** One run of the film: still (any idle) or motion, in output ms. */
export type Run = { outStartMs: number; outEndMs: number; kind: string };
/** An idle/motion boundary the seam check can sample either side of. */
export type Seam = { atMs: number; idleBefore: boolean };

/**
 * The runs and seams of one planned pair, for same-take's seam check (spec
 * 2026-11-13, Part 4 test 2). Runs of one kind are merged: two idle segments
 * side by side are one still stretch on the film. A seam counts only where a
 * frame and the 100 ms reference fit on its idle side, and three frames on
 * its moving side.
 */
export function pairSeams(
  timeline: readonly { outStartMs: number; outEndMs: number; kind: string }[],
  pairStart: number,
  pairEnd: number,
  frameMs: number,
): { runs: Run[]; seams: Seam[] } {
  const runs: Run[] = [];
  for (const g of timeline) {
    if (g.outEndMs <= pairStart) continue;
    if (g.outStartMs >= pairEnd) break;
    const kind = g.kind === "motion" ? "motion" : "still";
    const last = runs.at(-1);
    // Clipped to the pair: room outside it is another step's.
    const outStartMs = Math.max(g.outStartMs, pairStart);
    const outEndMs = Math.min(g.outEndMs, pairEnd);
    if (last?.kind === kind) last.outEndMs = outEndMs;
    else runs.push({ outStartMs, outEndMs, kind });
  }
  // An idle between two motion runs that no frame of the film falls inside
  // shows nothing still: the film moves straight through it. On ubuntu the
  // journey opened with a 5 ms pointer sample, 12.5 ms of idle, then the
  // rest of it, and neither seam that made qualified. An idle that
  // holds a frame tick, however short, stays an idle.
  const holdsNoFrame = (g: Run) =>
    Math.ceil(g.outStartMs / frameMs) * frameMs >= g.outEndMs;
  for (let i = 1; i + 1 < runs.length; ) {
    const [before, g, after] = runs.slice(i - 1, i + 2) as [Run, Run, Run];
    if (
      g.kind === "still" &&
      holdsNoFrame(g) &&
      before.kind === "motion" &&
      after.kind === "motion"
    ) {
      before.outEndMs = after.outEndMs;
      runs.splice(i, 2);
    } else i++;
  }
  const seams: Seam[] = [];
  for (let i = 0; i + 1 < runs.length; i++) {
    const a = runs[i] as Run;
    const b = runs[i + 1] as Run;
    if ((a.kind === "still") === (b.kind === "still")) continue;
    const idle = a.kind === "still" ? a : b;
    const moving = a.kind === "still" ? b : a;
    if (idle.outEndMs - idle.outStartMs < 100 + 3 * frameMs) continue;
    if (moving.outEndMs - moving.outStartMs < 3 * frameMs) continue;
    seams.push({ atMs: a.outEndMs, idleBefore: a.kind === "still" });
  }
  return { runs, seams };
}
