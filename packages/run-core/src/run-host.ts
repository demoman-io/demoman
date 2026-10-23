import type { ReplayResult, ReplayStatus } from "@demoman/replay-engine";

/** Unique for the life of a run: anchor ids, action ids, telemetry ids and
 *  bridge request ids all need one, and every one of them is required to be
 *  unique inside the thing it names. */
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- what any hosted run says about itself --------------------------------

/**
 * The run, reduced to what a later surface can act on.
 *
 * Both fields are copied, neither is derived: `outcome` says how far the run
 * got and `reason` says what failed, and the pair `complete` + a reason is
 * reachable and load-bearing (a run that replayed everything and then could
 * not store its bundle — the frames exist only in memory, and that is the
 * case an author must act on immediately).
 */
export function statusOf(result: ReplayResult): ReplayStatus {
  return {
    outcome: result.outcome,
    reason: result.reason,
    completed: result.completed,
    total: result.total,
  };
}

/**
 * Name the window's disappearance as what it was.
 *
 * When the author closes the replay window mid-run every subsequent protocol
 * call rejects, and the engine — correctly, from where it stands — calls that
 * `portFailure`: something underneath gave way. Out here we know *which*
 * thing, and `windowClosed` is one of the two failures an author can actually
 * do something about. Only `portFailure` is refined: a run that had already
 * stopped for a wait timeout stopped because of the wait, and the first
 * failure is the one that explains the run.
 */
export function attributeClosedWindow(
  result: ReplayResult,
  windowClosed: boolean,
): ReplayResult {
  if (!windowClosed || result.reason !== "portFailure") return result;
  return { ...result, reason: "windowClosed" };
}
