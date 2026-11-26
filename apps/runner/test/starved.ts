import { SPAN_QUIET_MS } from "@demoman/replay-engine";

/**
 * Whether the recorder kept motion past an act's end (DEM-239's skip, in
 * executor-room.slow). A span closes `SPAN_QUIET_MS` after its last moving
 * frame, and an act ended at a gap ends on that last frame, so a span's own
 * close always reaches past such an act: asked of `endMs` alone, an act that
 * ended at a starved screencast's gap read as one that ended inside kept
 * motion, and the skip could never apply (CI, PR #146, 2026-11-26: six tries,
 * each span ending exactly 250 ms after its act).
 */
export function motionKeptAfter(
  spans: readonly { startMs: number; endMs: number }[],
  actEndMs: number,
): boolean {
  return spans.some(
    (m) => m.startMs < actEndMs && m.endMs - SPAN_QUIET_MS > actEndMs,
  );
}
