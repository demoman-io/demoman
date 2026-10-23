import { describe, expect, it } from "vitest";
import {
  authoredScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  replayRecoverable,
  replaySentence,
} from "../../../pages/src/core/replay/status";

const ALLOWED = { mayReplay: true, writes: [] };
const REFUSED = { mayReplay: false, writes: [] };

describe("replaySentence and replayRecoverable", () => {
  it("prints an unmapped reason verbatim rather than swallowing it", () => {
    // A new reason from the producer must not cost this surface a release,
    // and must not degrade to "something went wrong" — curt beats mysterious.
    const sentence = replaySentence(
      {
        outcome: "partial",
        reason: "someFutureReason",
        completed: 1,
        total: 4,
      },
      ALLOWED,
    );
    expect(sentence).toContain("someFutureReason");
    expect(sentence).toContain("1 of 4");
  });

  it("says what a known reason actually means", () => {
    const sentence = replaySentence(
      {
        outcome: "partial",
        reason: "redactedWithoutReplacement",
        completed: 0,
        total: 3,
      },
      ALLOWED,
    );
    // The surface the sentence names has to be one the editor still has:
    // the replacements panel it used to send authors to was deleted on
    // 2026-09-14, and a replacement is authored on the step now.
    expect(sentence).toMatch(/Replace on-screen text/);
    expect(sentence).not.toContain("redactedWithoutReplacement");
  });

  it("gives each of the three anchor reasons its own distinct sentence", () => {
    // gone / several / not-yet is the load-bearing distinction the producer
    // split unresolvedAnchor into. Each must point at a different action.
    const gone = replaySentence(
      {
        outcome: "partial",
        reason: "unresolvedAnchor",
        completed: 1,
        total: 3,
      },
      ALLOWED,
    );
    const several = replaySentence(
      {
        outcome: "partial",
        reason: "ambiguousAnchor",
        completed: 1,
        total: 3,
      },
      ALLOWED,
    );
    const notYet = replaySentence(
      {
        outcome: "partial",
        reason: "anchorNotRendered",
        completed: 1,
        total: 3,
      },
      ALLOWED,
    );
    expect(new Set([gone, several, notYet]).size).toBe(3);
    expect(gone).toMatch(/no longer on the page/);
    expect(gone).toMatch(/re-record|remap/);
  });

  it("does not claim an element was missing when several were found", () => {
    // ambiguousAnchor: several candidates WERE found, and replay stopped
    // rather than guess which one. "Could not be found" would be a lie
    // here — the real risk is acting on the wrong candidate.
    const sentence = replaySentence(
      {
        outcome: "partial",
        reason: "ambiguousAnchor",
        completed: 1,
        total: 3,
      },
      ALLOWED,
    );
    expect(sentence).not.toMatch(/could not be found/i);
    expect(sentence).toMatch(/identifying more precisely/);
  });

  it("does not accuse the take when the take is probably fine", () => {
    // anchorNotRendered is recoverable — usually a virtualized row that
    // just needs scrolling into view. It must not read as breakage, and
    // must not send the author off to re-record something that was fine.
    const sentence = replaySentence(
      {
        outcome: "partial",
        reason: "anchorNotRendered",
        completed: 1,
        total: 3,
      },
      ALLOWED,
    );
    expect(sentence).not.toMatch(/then stopped/);
    expect(sentence).not.toMatch(/re-record/);
  });

  it("does not accuse the take when the page simply did not answer", () => {
    // pageSilent is the app being down, offline, or on a browser error
    // page. The sentence already says to check it loads and run again; the
    // headline must not call that a break to fix.
    const sentence = replaySentence(
      { outcome: "partial", reason: "pageSilent", completed: 1, total: 3 },
      ALLOWED,
    );
    expect(sentence).not.toMatch(/then stopped/);
    expect(sentence).not.toMatch(/re-record/);
  });

  it("reads correctly for a stop that completed no steps", () => {
    expect(
      replaySentence(
        {
          outcome: "partial",
          reason: "waitTimeout",
          completed: 0,
          total: 4,
        },
        ALLOWED,
      ),
    ).toMatch(/reconstructed 0 of 4/);
  });

  // Fix wave, item 1. This sentence used to ignore the policy while
  // `bundleStatus` (gone since 2026-09-24 — see `staleness.ts`'s tombstone)
  // separately refused to call a refused scene "stale" or "failed" so no
  // Regenerate button was offered; `renderFailure` hangs its retry button
  // off this sentence alone, so the two had to agree. Every mapped reason
  // ends in advice to change something and run again, which is the one
  // thing a refused scene cannot do.
  it("says nothing about a stopped run while the policy refuses to replay", () => {
    expect(
      replaySentence(
        {
          outcome: "partial",
          reason: "unresolvedAnchor",
          completed: 1,
          total: 3,
        },
        REFUSED,
      ),
    ).toBeNull();
  });

  // The same defect in the other direction. `engine.ts` reports "mutating"
  // only when `mayReplay` was false at the moment the run was asked for, so
  // the instant the author flips the setting on (the editor's
  // `enableMutatingReplay` route) the sentence tells them to turn on the
  // setting they just turned on — beside a retry button that now works.
  it("says nothing about a refusal the current policy has already lifted", () => {
    expect(
      replaySentence(
        { outcome: "partial", reason: "mutating", completed: 0, total: 4 },
        ALLOWED,
      ),
    ).toBeNull();
  });

  it("does not call a complete run partial, and sends it to Runs to try again", () => {
    // outcome and reason are two facts. A run can execute every action and
    // then fail to persist, and "then stopped" is false on both halves.
    //
    // The advice is asserted as well as the phrasing, because this sentence
    // used to end "Render now" — naming a control that is not in the box it
    // prints in, for frames that a Render could not have reached anyway (see
    // `replaySentence`'s docblock). What it must do instead is point at where
    // the take can actually be run again.
    const sentence = replaySentence(
      {
        outcome: "complete",
        reason: "portFailure",
        completed: 4,
        total: 4,
      },
      ALLOWED,
    );
    expect(sentence).toMatch(/all 4 steps/);
    expect(sentence).not.toMatch(/then stopped/);
    expect(sentence).not.toMatch(/render now/i);
    // The editor has no rebuild to point at since plan 2's Task 7: the way
    // to try again is a re-shoot, on the run page.
    expect(sentence).toMatch(/re-shoot it in Runs to try again/);
    expect(sentence).not.toMatch(/rebuild/i);
  });

  // Fix round 3. `noActions` settles as `outcome: "complete"` (the same
  // "vacuously complete" rule a genuinely actionless take gets, from
  // `replayOutcome(0, 0)` once `withoutCutSteps` leaves nothing to perform),
  // and until this round that routed it into the branch above — built for a
  // replay that finished and then failed to PERSIST, and reachable today by
  // cutting every step and pressing rebuild. It told the author to free disk
  // space for a problem disk space cannot fix.
  it("says there is nothing to film rather than inventing a storage failure, for a run with nothing to perform", () => {
    const sentence = replaySentence(
      { outcome: "complete", reason: "noActions", completed: 0, total: 0 },
      ALLOWED,
    );
    expect(sentence).not.toBeNull();
    expect(sentence).toMatch(/nothing to record/i);
    expect(sentence).not.toMatch(/save|space|re-record/i);
  });

  // The generic "complete with a reason" branch's own half of the same
  // finding: it must not assume storage for a reason it does not recognise
  // either, or the NEXT reason a producer adds inherits the same wrong cause.
  it("names an unrecognised complete-with-a-reason cause instead of assuming storage", () => {
    const sentence = replaySentence(
      {
        outcome: "complete",
        reason: "someFutureReason",
        completed: 4,
        total: 4,
      },
      ALLOWED,
    );
    expect(sentence).toMatch(/someFutureReason/);
    expect(sentence).not.toMatch(/save|space|re-record/i);
  });

  it("explains a replay the author cancelled", () => {
    const text = replaySentence(
      {
        outcome: "partial",
        reason: "cancelledByAuthor",
        completed: 0,
        total: 4,
      },
      ALLOWED,
    );
    // Distinctive phrases from the mapped copy: the fallback prints the bare
    // identifier, which contains "cancel" and would satisfy a looser match —
    // the point of the mapping is the sentence, not the word.
    expect(text).toContain("the take itself recorded");
    expect(text).toContain("re-shoot it in Runs to run it now");
    expect(text).not.toMatch(/rebuil/i);
    expect(text).not.toContain("cancelledByAuthor");
    expect(text).not.toMatch(/never/i);
  });

  // Fix wave, item 2. A cancel is the author's own choice, not a breakage —
  // "then stopped" is the clause reserved for something they must act on,
  // and `RECOVERABLE` exists exactly to keep the two apart.
  it("does not phrase the author's own cancellation as a breakage", () => {
    const text = replaySentence(
      {
        outcome: "partial",
        reason: "cancelledByAuthor",
        completed: 0,
        total: 4,
      },
      ALLOWED,
    );
    expect(text).toContain("and stopped early");
    expect(text).not.toContain("then stopped");
  });

  // The same signal the clause above reads, exported so `renderFailure`'s
  // headline cannot disagree with the sentence underneath it.
  it("reports which stops are recoverable, so the headline can agree", () => {
    const status = (reason: string) => ({
      outcome: "partial" as const,
      reason,
      completed: 0,
      total: 4,
    });
    expect(replayRecoverable(status("cancelledByAuthor"))).toBe(true);
    expect(replayRecoverable(status("anchorNotRendered"))).toBe(true);
    // Its sentence says "nothing is wrong with the anchor ... run it again",
    // and the headline above it said the render did not finish. One box, two
    // claims.
    expect(replayRecoverable(status("anchorUnreachable"))).toBe(true);
    // Its sibling, and deliberately not recoverable: the frames the take
    // recorded are not the frames the page has, and every re-run reproduces
    // it. Here the headline is right and the retry advice would not be.
    expect(replayRecoverable(status("anchorFrameMismatch"))).toBe(false);
    expect(replayRecoverable(status("unresolvedAnchor"))).toBe(false);
    expect(replayRecoverable(null)).toBe(false);
  });

  /**
   * `pageFaulted`, the reason the agent-door fix wave added — and the entry it
   * first forgot.
   *
   * It is reachable from the editor's Rebuild, not only from the door:
   * `replay-host.ts` wires `createSensorPageAgent` for both, and
   * `page-agent.ts` maps a faulted reply to it. So a page whose resolver threw
   * during a rebuild classified as a breakage while the sentence printed
   * underneath said the app is up and to run it again — the same headline-
   * contradicts-its-own-sentence pair the cases above exist for, and a
   * REGRESSION rather than a gap, because the same event reported `pageSilent`
   * before the wave and `pageSilent` is recoverable.
   *
   * The premise, asserted rather than assumed: the sentence really does end in
   * retry advice, which is what makes "breakage" the wrong classification. A
   * `REASON_TEXT` entry rewritten to say the take needs re-recording would make
   * the classification below the wrong one, and this is what would notice.
   *
   * The production change that turns this red: `pageFaulted: false` in
   * `RECOVERABLE`, which is exactly the state this test was written for. What
   * would NOT redden it, and is why the set became a
   * `Record<ReplayStopReason, boolean>` in the same change: deleting the entry
   * altogether — a `Set<string>` accepted that silently, and the compiler now
   * refuses it.
   */
  it("reports a page that faulted as recoverable, agreeing with its own sentence", () => {
    const faulted = {
      outcome: "partial" as const,
      reason: "pageFaulted",
      completed: 2,
      total: 4,
    };
    const said = replaySentence(faulted, ALLOWED) ?? "";
    expect(said).toMatch(/the app is up/);
    expect(said).toMatch(/run again/);
    expect(replayRecoverable(faulted)).toBe(true);
    // And the reason it is not: silence is a different fact, and it was what
    // this event reported before the reason existed.
    expect(replayRecoverable({ ...faulted, reason: "pageSilent" })).toBe(true);
  });

  /**
   * A reason this build has never heard of is NOT recoverable. `reason` comes
   * off disk unvalidated, so this is reachable from a stored take naming a
   * retired reason — and the honest answer for "I cannot tell" is the one that
   * shows the author the failure box rather than hiding it behind "just run it
   * again".
   *
   * `"constructor"` is the case a lookup written as `RECOVERABLE[reason]` on a
   * plain object record would get wrong: the inherited property is truthy.
   * The production change that reddens this: dropping the `=== true`.
   */
  it.each(["someFutureReason", "constructor", "toString", "__proto__"])(
    "does not read %s as recoverable",
    (reason) => {
      expect(
        replayRecoverable({
          outcome: "partial",
          reason,
          completed: 0,
          total: 4,
        }),
      ).toBe(false);
    },
  );

  it("says nothing about a run that never happened or ran clean", () => {
    expect(replaySentence(null, ALLOWED)).toBeNull();
    expect(
      replaySentence(
        {
          outcome: "complete",
          reason: null,
          completed: 3,
          total: 3,
        },
        ALLOWED,
      ),
    ).toBeNull();
  });
});

// A stored replay status on an authored take came from its script run: Runs
// refuses to re-shoot an authored take, so nothing else writes one. The
// sentence has to say so, and route the author to what works there. Goes red
// if `replaySentence` stops reading the scene's capture mode.
describe("replaySentence for an authored take", () => {
  const authored = authoredScene(readonlyScene());
  const stop = (reason: string, over = {}) => ({
    outcome: "partial" as const,
    reason,
    completed: 2,
    total: 5,
    ...over,
  });

  it("premise: the two scenes differ in the capture mode and nothing else is claimed", () => {
    expect(authored.meta.capture.mode).toBe("authored");
    expect(readonlyScene().meta.capture.mode).not.toBe("authored");
  });

  it("calls a stopped run a script run that performed N of M steps", () => {
    const text =
      replaySentence(stop("unresolvedAnchor"), ALLOWED, authored) ?? "";
    expect(text).toMatch(
      /^The script run performed 2 of 5 steps then stopped: /,
    );
    expect(text).not.toMatch(/re-shoot/i);
    const recorded =
      replaySentence(stop("unresolvedAnchor"), ALLOWED, readonlyScene()) ?? "";
    expect(recorded).toMatch(
      /^The re-shoot reconstructed 2 of 5 steps then stopped: /,
    );
  });

  it("keeps the recoverable clause, and the complete-but-unsaved advice, in the script run's voice", () => {
    const recoverable =
      replaySentence(
        stop("pageFaulted", { completed: 0 }),
        ALLOWED,
        authored,
      ) ?? "";
    // Premise: the reason really is one the take can recover from.
    expect(replayRecoverable(stop("pageFaulted"))).toBe(true);
    expect(recoverable).toMatch(
      /^The script run performed 0 of 5 steps and stopped early: /,
    );
    const unsaved =
      replaySentence(
        { outcome: "complete", reason: "portFailure", completed: 4, total: 4 },
        ALLOWED,
        authored,
      ) ?? "";
    expect(unsaved).toMatch(
      /^The script run performed all 4 steps but could not save the frames: /,
    );
    expect(unsaved).toMatch(/run its script again in Runs to try again\.$/);
    expect(unsaved).not.toMatch(/re-shoot/i);
    const other =
      replaySentence(
        { outcome: "complete", reason: "pageSilent", completed: 4, total: 4 },
        ALLOWED,
        authored,
      ) ?? "";
    expect(other).toMatch(/^The script run performed all 4 steps, but: /);
  });

  it("says the script run never started, not the re-shoot", () => {
    const text =
      replaySentence(
        { outcome: "complete", reason: "noActions", completed: 0, total: 0 },
        ALLOWED,
        authored,
      ) ?? "";
    expect(text).toMatch(/^The script run never started: /);
  });
});
