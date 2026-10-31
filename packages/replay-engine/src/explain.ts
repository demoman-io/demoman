import type { SceneAnchor, SceneDocument } from "@demoman/scene-schema";
import { WAIT_TIMEOUT_MS } from "./constants.js";
import type { ReplayStatus, ReplayStopReason } from "./types.js";

/**
 * Why a run stopped, in the author's own language, and which step it stopped
 * on. Both surfaces that report a replay read from here.
 *
 * The reason text used to live in `src/editor/staleness.ts`, where the
 * orchestrator could not reach it — so the "developing" window printed the
 * raw identifier. A real take reported `Stopped: unresolvedAnchor` and left
 * the author with nothing to act on, while the editor two clicks away had a
 * whole sentence for the same fact.
 */
/**
 * Typed over the union, not `Record<string, string>`: `reasonSentence` falls
 * back to printing the raw identifier, so a reason added without an entry here
 * would report `Stopped: pageWentElsewhere` and no test would go red for it.
 * That fallback is deliberate and stays (curt beats mysterious for a reason
 * this surface has never heard of), which is exactly why the table it backs
 * has to be exhaustive by construction.
 */
export const REASON_TEXT: Record<ReplayStopReason, string> = {
  mutating:
    "this flow writes data and rebuilding is switched off for it, so what you have is what this take itself recorded — turn on rebuilds for write flows, then rebuild it",
  cancelledByAuthor:
    "you cancelled before it started, so this scene still has what the take itself recorded — re-shoot it in Runs to run it now",
  // Genuinely gone. The only one of these three that means the demo is
  // actually broken.
  unresolvedAnchor:
    "an element this demo depends on was not on the page — check the step's target names something the page really shows, or what the step before it does",
  // NOT "could not find it". Several WERE found, and replay stopped rather
  // than guess, because guessing is how a replay clicks the wrong row of a
  // table. The author's problem is upstream: the element is not identified
  // well enough to be found again.
  ambiguousAnchor:
    "several elements matched this step, so replay stopped rather than risk clicking the wrong one — name the target more precisely (a stableId, or a role with a fuller name, from a snapshot of the page)",
  // Usually nothing is wrong with the take. A virtualized row that has not
  // been rendered yet; the app can be asked to scroll it into view. The
  // resolver reports it separately precisely because it is recoverable, and
  // collapsing it into "could not be found" used to send authors off to
  // re-record something that was fine.
  anchorNotRendered:
    "an element was in the page's data but not rendered — the page probably needs scrolling further first, so add a scrollTo step before this one",
  // Not a verdict about any element. Before this had its own sentence the
  // silence read as `unresolvedAnchor`, and an author whose app was down
  // was sent off to re-record a step that was fine.
  pageSilent:
    "the page did not answer when replay asked it to find an element — the app may be down, offline, or showing a browser error page; check it loads, then run again",
  // The sibling of the reason above and the opposite diagnosis: the page WAS
  // heard from and it faulted. Reported as `pageSilent` until 2026-09-27 (no
  // reply was posted for a thrown page agent at all, so the caller's timeout
  // fired), which sent authors off to check an app that was up.
  pageFaulted:
    "the page itself threw an error when replay asked it to find an element, so nothing about the element was measured — the app is up; look at that page's own console for the fault, then run again",
  // The one reason whose whole job is to say the anchor is NOT the problem.
  // Folded into `unresolvedAnchor` until 2026-09-07, which sent authors off
  // to re-record a step whose anchor the resolver had just found cleanly.
  anchorUnreachable:
    "replay found the element this step needs and then could not reach it to measure — nothing is wrong with the target, so changing the step will not help; run it again, and say so if it repeats",
  // The sibling of the reason above, and the opposite instruction. Both say
  // the anchor is fine; only this one is permanent, because the corroboration
  // that refused the frame will refuse it identically on every future run —
  // which is why it must not inherit "run it again, and say so if it
  // repeats". It always repeats.
  anchorFrameMismatch:
    "replay found the element this step needs and the frame holding it is not the one recorded — the page's frames have changed since the take, so running it again will fail the same way; change the step to target an element outside that frame",
  // Names the surface that exists. The replacements panel this used to send
  // authors to was deleted with the Steps disclosure on 2026-09-14; a
  // replacement is authored on the step itself now.
  redactedWithoutReplacement:
    "a typed value was withheld — a credential field, a secret-shaped value, or an editor whose text went unknown — and has no demo-safe replacement yet; select that step on the timeline and fill in Replace on-screen text, then run it again",
  // An authored run only, and the sentence has to name the move the page made:
  // the author's script is fine up to here, and what it is missing is either a
  // wait for the page it landed on or a session that is still signed in. Both
  // witnesses this is raised from are a change of page, so the sentence can
  // state that as fact rather than hedging it.
  pageWentElsewhere:
    "the app moved to a different page partway through this script, and nothing in the script asked it to — either a step navigated, or the session expired and it went to a sign-in page; check the app is still signed in, and add a waitForLoad after any step that navigates, then run it again",
  signedOut:
    "the app sent this browser to its sign-in page, so nothing was recorded — sign in again with demoman signin, then run it again",
  // Also authored only. Not a failure of the app or of the page: the script
  // asked for something this door does not perform, and the run refused
  // rather than perform a different thing and call it done.
  unperformableStep:
    "this script asks for something the run cannot perform — a click with a button other than the left one — so it stopped rather than do something else and report success; change that step to a left click",
  // Underneath the take: the browser put the click (its press, its release,
  // or both) somewhere other than where it was sent. "Run it again" is the
  // honest move — the cause, input during a still, is gated since
  // 2026-10-13, so a repeat is news worth saying.
  clickNotDelivered:
    "the browser put a click somewhere other than where it was sent, so the page never saw that click and the step did not happen — nothing is wrong with the steps; run it again, and say so if it repeats",
  dragEndOutOfView:
    "a drag's start or end was off the page once its start was in view, and a drag cannot scroll while it moves, so it was not begun; drag to a target on the same screen, or scroll first",
  dragNoDistance:
    "a drag's two ends landed on the same point once measured, which is a click, not a drag, so it was not begun; give the drag's end another target, spot or offset",
  waitTimeout: `what the step waited for (an element to show or hide, or the page to load) did not happen within ${WAIT_TIMEOUT_MS / 1000} s — check the target, or what the step before it does`,
  occlusionTimeout:
    "the render window stayed covered, so the frames would not have been usable — leave the window uncovered while it runs, then run it again",
  windowClosed:
    "the replay window was closed before the run finished — nothing is wrong with the take, run it again",
  debuggerUnavailable:
    "the debugger could not be attached to the replay tab — close DevTools on it and run again",
  // Underneath the take, so re-recording cannot help, and once is the honest
  // allowance for a rerun: this said "usually worth simply running it again"
  // until M4 (2026-10-01), and an agent spent the last run of its cap
  // repeating a muxer fault no rerun could get past.
  deviceFailed:
    "the browser refused to emulate the device, so nothing was recorded — the note says which command and why",
  portFailure:
    "something underneath the run gave way — not a fault in the script, so changing it will not fix it; run it once more, and if it stops the same way, report it",
  // Reported by the caller, not the engine: there was nothing to perform.
  noActions:
    "this take has no step that acts on the page, so there is nothing to record",
};

/**
 * An unmapped identifier is printed verbatim rather than swallowed or turned
 * into "something went wrong". Curt beats mysterious, and a support thread
 * can work with a literal.
 */
export function reasonSentence(reason: string): string {
  // `string`, not `ReplayStopReason`: `ReplayStatus.reason` comes back off disk
  // unvalidated, and a stored take may name a reason this build has retired.
  return reason in REASON_TEXT
    ? REASON_TEXT[reason as ReplayStopReason]
    : reason;
}

/**
 * What to call a step's target. The fingerprint's priority order is the
 * resolver's; this is the human-readable echo of it.
 */
export function anchorLabel(anchor: SceneAnchor | undefined): string {
  if (!anchor) return "(navigation)";
  const f = anchor.fingerprint;
  return (
    f.accessibleName ?? f.textContent ?? f.stableId ?? f.dataKey ?? anchor.id
  );
}

export interface FailedStep {
  /** 1-based, as an author counts steps. */
  number: number;
  total: number;
  kind: string;
  label: string;
}

/**
 * The step a run stopped on.
 *
 * `completed` is how many actions replayed, so the action at that index is
 * the one that failed — the arithmetic nobody should have to do by hand.
 * Before this, diagnosing a stopped replay meant reading `completed: 4` out
 * of a telemetry blob and counting down a nineteen-line action list to find
 * that step five was a reCAPTCHA.
 *
 * Null whenever no single step is to blame: a run that stopped for no
 * reason, a run with no status at all, and a complete run whose failure was
 * in storing the frames rather than in performing an action.
 */
export function failedStep(
  scene: SceneDocument,
  replay: ReplayStatus | null,
): FailedStep | null {
  if (replay === null || replay.reason === null) return null;
  if (replay.outcome === "complete") return null;
  const action = scene.actions[replay.completed];
  if (!action) return null;
  return {
    number: replay.completed + 1,
    total: scene.actions.length,
    kind: action.kind,
    label: anchorLabel(scene.anchors.find((a) => a.id === action.anchorId)),
  };
}

/**
 * `failedStep` for a run of the take as it is. Step cuts used to skip steps
 * in a rebuild, so this once translated the run's count back to the log;
 * removed pieces skip none (spec 2026-10-22 split-tool), so the two agree.
 * Kept as the one name both reporting surfaces call.
 */
export function failedPerformedStep(
  scene: SceneDocument,
  replay: ReplayStatus | null,
): FailedStep | null {
  return failedStep(scene, replay);
}
