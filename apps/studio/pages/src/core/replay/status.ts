import {
  failedPerformedStep,
  type ReplayStopReason,
  reasonSentence,
} from "@demoman/replay-engine";
import type { CapabilityPolicy } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { isAuthoredScene, runsRouteClause } from "../../shell/runs-link";

/**
 * Lifted whole from `src/editor/staleness.ts` on 2026-09-27 (task 7 of the
 * agent-door plan), byte-for-byte apart from this header and its import
 * paths — see `docs/superpowers/specs/2026-09-26-agent-door-and-editor-
 * removal-design.md` §2 and §6: "Engine. Lifts whole — it is run-outcome
 * reporting."
 *
 * **The lift is all that has happened so far, and the editor is still the only
 * consumer.** `ReplayStatus`, `replayRecoverable` and `replaySentence` are
 * imported by `src/editor/` and `src/adapters/bundle-source.ts`, and by
 * nothing else. In particular `src/core/replay/report.ts` does not import this
 * file at all — it takes `ReplayStatus` from `@demoman/replay-engine` and
 * `reasonSentence` straight from the engine too — and nothing at the agent
 * door consults `RECOVERABLE` or `replaySentence`. This header said otherwise
 * ("`buildRunReport` is the new consumer this file exists for, reading the
 * same print-the-identifier fallback and the same `RECOVERABLE` set"), which
 * was a claim about a wire that does not exist. The move out of `editor/` was
 * made so that a door-side consumer CAN be written here rather than copied;
 * that consumer is spec §5's and is not here yet.
 *
 * What follows is the file's own prior history, unchanged:
 *
 * `BundleStatus`, `bundleStatus()`, `markersMatch()` and `sameActions()` left
 * this file on 2026-09-24. They were the stale flag's read side: one enum,
 * derived from a boolean stored on disk plus a markers-only comparison that
 * could not see a retext (`markersMatch`) and a structural one that could
 * (`sameActions`, used only to clear the flag on undo). `approximations.ts`
 * replaced all four — the stored flag is gone, and what stayed stale is now
 * a per-edit list derived from the frames' own `madeFrom` record, compared
 * field by field against the current scene. Look there for the banner this
 * file used to feed, and for the `session.ts` snapshot field (`madeFrom`)
 * that supplies it.
 *
 * What is still here answers a narrower question: not "are the frames
 * current", but "why did the last rebuild stop, and does the author still
 * need to hear it".
 */

/**
 * What the replay producer reported about its last run, if it ran.
 *
 * `bundle === null` is NOT the state to branch on: a replay that refused,
 * threw, or stopped early can leave a null bundle, and a scene of only
 * `waitFor` actions can complete successfully with a null bundle because it
 * plans no cursor path and harvests nothing. The honest discriminator is
 * whether a result exists at all — absent means replay never ran, present
 * with a `reason` means it ran and stopped and the author is owed an
 * explanation rather than a calm "no frames yet".
 *
 * Optional throughout, because the producer is a concurrent stream: until it
 * supplies this, every path degrades to the pre-existing behaviour.
 */
export interface ReplayStatus {
  outcome: "complete" | "partial";
  reason: string | null;
  completed: number;
  total: number;
}

/**
 * Why a run stopped, in the editor's own voice.
 *
 * The producer's `reason` values are identifiers, not sentences — honest but
 * curt in front of an author. The phrasing lives here for the same reason
 * the capability-tier copy does: it is UI, and the producer should be able
 * to add a reason without costing this surface a release.
 *
 * Which is exactly what the fallback protects. An unmapped identifier is
 * printed verbatim rather than swallowed or turned into "something went
 * wrong" — curt beats mysterious, and a support conversation can work with
 * a literal.
 */

/**
 * Whether the take is probably fine and the run can simply be retried, per
 * stop reason.
 *
 * `cancelledByAuthor` belongs here for a different reason than
 * `anchorNotRendered` and arrives at the same place: nothing broke. Without
 * it the editor announced the author's own choice as "The last regeneration
 * did not finish", above a sentence that then said "you cancelled".
 *
 * `anchorUnreachable` is the same omission found again, in the same box: its
 * own sentence ends "nothing is wrong with the anchor ... run it again" and
 * the headline above it read "The last full-quality render did not finish".
 * Note which reason is `false` — `anchorFrameMismatch` is the half of that
 * failure that re-running cannot fix, and it belongs with the breakages.
 * ("Here" and "not here" is how this read while the table was a `Set` of the
 * true ones; every reason is listed now, and the value is the answer.)
 *
 * `pageFaulted` is that omission a THIRD time, and it was introduced by the
 * fix wave that added the reason (2026-09-27). It is not a door-only reason:
 * `replay-host.ts` wires `createSensorPageAgent` for the editor's Rebuild too,
 * so a page whose resolver threw during a rebuild classified as a breakage
 * under a sentence that says "the app is up; look at that page's own console
 * for the fault, then run again". And before that wave the same event reported
 * `pageSilent`, which is `true` — so it was a regression, not a gap.
 *
 * **`Record<ReplayStopReason, boolean>`, not `Set<string>`, and that is the
 * fix rather than the entry.** This was a hand-maintained set beside a
 * discriminated union, which is how it came to be missing an entry in the
 * first place: nothing could refuse the omission, and the omission's cost is
 * a headline that contradicts the sentence printed underneath it. The
 * compiler refuses it now, the same way `REASON_TEXT` and `ACTS_ON_THE_PAGE`
 * are refused an omission. A reason added to `ReplayStopReason` must be
 * classified here, deliberately, one way or the other.
 *
 * Membership is otherwise exactly what the set held: this table records
 * today's classification and reclassified nothing but `pageFaulted`.
 */
const RECOVERABLE: Record<ReplayStopReason, boolean> = {
  anchorNotRendered: true,
  anchorUnreachable: true,
  cancelledByAuthor: true,
  pageSilent: true,
  pageFaulted: true,
  // The browser moved a click's release (2026-10-13); its own sentence says
  // nothing is wrong with the take and to run it again.
  clickNotDelivered: true,
  // Breakages, refusals, and the reasons whose own advice is not "run it
  // again". `false` here is a decision, not an omission — see the docblock.
  mutating: false,
  // The script's to fix: the same drag fails the same way again.
  dragEndOutOfView: false,
  dragNoDistance: false,
  redactedWithoutReplacement: false,
  unresolvedAnchor: false,
  ambiguousAnchor: false,
  anchorFrameMismatch: false,
  pageWentElsewhere: false,
  // Launch C, CLI only: rerunning without signing in meets the same page.
  signedOut: false,
  unperformableStep: false,
  waitTimeout: false,
  occlusionTimeout: false,
  debuggerUnavailable: false,
  windowClosed: false,
  portFailure: false,
  // The browser would not emulate the device; a rerun meets the same refusal.
  deviceFailed: false,
  noActions: false,
};

/**
 * Whether a stopped run is a break to fix, or a run that simply did not
 * happen. `replaySentence`'s clause below and the headline `renderFailure`
 * puts above it are the same claim said twice, so both read this rather than
 * each deciding for itself — the headline deciding on its own is how a
 * cancel came to be announced as a failure.
 *
 * `=== true`, and the cast is deliberate: `ReplayStatus.reason` comes back off
 * disk unvalidated (see its own docblock), so a stored take may name a reason
 * this build has retired, or one this table has never heard of. Such a reason
 * is NOT recoverable — the honest answer for "I cannot tell" here is the one
 * that shows the author the failure box rather than hiding it behind "just run
 * it again" — and comparing against `true` rather than reading the value as
 * truthy is what keeps an inherited property name (`"constructor"`) from
 * answering yes.
 */
export function replayRecoverable(replay: ReplayStatus | null): boolean {
  if (replay === null || replay.reason === null) return false;
  return RECOVERABLE[replay.reason as ReplayStopReason] === true;
}

/**
 * What a run that did not go cleanly owes the author. Null when replay never
 * ran, ran clean, or stopped for a reason the policy it is asked under has
 * already resolved — see the guard at the top of the body.
 *
 * Takes the policy, and it is not optional. Most sentences this can return
 * end in advice to run again, and while the policy refuses a run that advice
 * cannot be taken — so a caller holding a refusing policy gets null rather
 * than advice the policy refuses. The one caller today, the editor's
 * session, holds none: since 2026-09-28 (plan 2 of the agent door, Task 7)
 * it asks under `session.ts`'s `VOICED`, which always allows, because the
 * editor offers no run of its own and the run page reads the policy itself.
 * A stopped re-shoot is owed its reason whatever the setting now says.
 *
 * Worded as a re-shoot since that date: the run page's Re-shoot is the only
 * thing left that writes a replay status the editor reads, and the editor
 * has no rebuild to point at, so the advice sends the author to Runs.
 *
 * `outcome` and `reason` are two facts, not one said twice: `outcome` says
 * how far replay got, `reason` says what went wrong, and **a complete run
 * can carry a reason.** The case that makes that real is a replay that
 * executes every action and then fails to persist its bundle — a quota
 * failure, the most plausible one here given 200 keyframes at 1–3 MB each.
 * Nothing about that run was partial, and "then stopped" would be false on
 * both halves, which is why it gets its own sentence.
 *
 * That sentence used to end "Render now — they will not still be here
 * later", on the premise that the frames were in memory and the author
 * could still export them. **The premise was false in both halves**, found
 * 2026-09-08:
 *
 * - There is no Render control in the box the sentence is printed in.
 *   `renderFailure` rendered one button beneath it until Task 10 retired it
 *   (spec §2: the export's own rebuild-failure row is the one way to start a
 *   rebuild now); the export panel's Render was on the inspector's Demo tab,
 *   elsewhere on the page, even before that.
 * - Pressing that Render would not have helped anyway. `render:start`
 *   carries a `sceneId` and nothing else (`background.ts`), and the
 *   offscreen renderer reads the bundle back out of the store — which is
 *   precisely where this run's frames did not land. The session does not
 *   hold them either: `regenerate`'s `refresh()` re-reads through
 *   `bundles.active`, so the engine's in-memory bundle is gone the moment
 *   the run returns.
 *
 * So the sentence says what is true rather than naming a button under it.
 * `runNotice` in `src/adapters/replay-runner.ts` tells the author the same
 * thing about the same event from the develop panel; the two are meant to
 * agree.
 */
export function replaySentence(
  replay: ReplayStatus | null,
  policy: CapabilityPolicy,
  scene?: SceneDocument,
): string | null {
  if (replay === null || replay.reason === null) return null;
  // Every sentence below ends in advice to change something and run again.
  // While replay is switched off, taking that advice — pressing Export,
  // which is the one control left that starts a rebuild — would only reach
  // the orchestrator to be refused, so this withholds the sentence entirely.
  //
  // `"mutating"` drops out in BOTH directions, which is why it is named
  // rather than left to the guard above. `engine.ts` reports it precisely
  // when `mayReplay` was false at the moment the run was asked for, so once
  // the author turns the setting on — the editor's `enableMutatingReplay`
  // route — its text would tell them to turn on the setting they just turned
  // on, beside an Export press that now works.
  if (!policy.mayReplay || replay.reason === "mutating") return null;
  const why = reasonSentence(replay.reason);
  // On an authored take a stored status came from its script run — Runs
  // refuses to re-shoot an authored take, so nothing else writes one — and
  // "re-shoot it" would route the author into that refusal. The scene says
  // which take this is; without one the wording is the recorded take's.
  const authored = scene !== undefined && isAuthoredScene(scene);
  const subject = authored ? "The script run" : "The re-shoot";
  const did = authored ? "performed" : "reconstructed";
  // Which step, when the scene is to hand. Diagnosing a stopped replay used
  // to mean reading `completed` out of a telemetry blob and counting down
  // the action list by hand to find that step five was a reCAPTCHA.
  //
  // `failedPerformedStep`, not `failedStep` directly: see its own docblock.
  // `src/adapters/replay-runner.ts`'s `runNotice` calls the same function for
  // the same reason — the develop panel's live notice and this failure
  // sentence must never name two different steps for one stop.
  const step = scene ? failedPerformedStep(scene, replay) : null;
  const at = step
    ? ` Stopped at step ${step.number}, ${step.kind} ${step.label}.`
    : "";
  // A refusal to start, not a run that stopped or finished: there was
  // nothing to perform, so `replayOutcome(0, 0)` reads `outcome` as
  // vacuously "complete". Falling into the `outcome === "complete"` branch
  // below would invent a storage failure that did not happen.
  if (replay.reason === "noActions") {
    return `${subject} never started: ${why}.`;
  }
  if (replay.outcome === "complete") {
    // `portFailure` is the one documented shape of "complete with a reason":
    // every action replayed and PERSISTING the bundle afterwards is what
    // failed (this docblock's own quota example). Any other reason reaching
    // here is a fact a future producer added that this sentence does not
    // know the shape of yet — naming it rather than assuming it is the
    // storage failure above is the smallest guard against the next such
    // reason inheriting a sentence about disk space it never caused, which
    // is exactly the mistake `noActions` was until the branch above existed.
    if (replay.reason === "portFailure") {
      return `${subject} ${did} all ${replay.total} steps but could not save the frames: ${why}. Nothing from it reached the store, so this page still shows the frames from before it ran — free some space and ${runsRouteClause(authored)} to try again.`;
    }
    return `${subject} ${did} all ${replay.total} steps, but: ${why}.`;
  }
  // A recoverable reason must not read as breakage — the take is probably
  // fine and a retry is the whole story. Anything else still needs to sound
  // like something the author must act on.
  const clause = replayRecoverable(replay)
    ? "and stopped early"
    : "then stopped";
  return `${subject} ${did} ${replay.completed} of ${replay.total} steps ${clause}: ${why}.${at}`;
}
