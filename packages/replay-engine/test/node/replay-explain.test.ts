import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { REASON_TEXT } from "../../src/explain.js";
import type { ReplayStatus } from "../../src/index.js";
import { anchorLabel, failedStep, reasonSentence } from "../../src/index.js";

/**
 * A scene shaped like the Google-search take that exposed this gap: a click,
 * a type, two navigation waits, then a reCAPTCHA the replay could not find.
 */
function scene(): SceneDocument {
  const anchors = [
    { id: "a-1", fingerprint: { stableId: "Search" } },
    { id: "a-2", fingerprint: { stableId: "recaptcha-anchor-label" } },
    { id: "a-3", fingerprint: { accessibleName: "Cheese" } },
  ];
  const actions = [
    { id: "act-1", kind: "click", anchorId: "a-1" },
    { id: "act-2", kind: "type", anchorId: "a-1" },
    { id: "act-3", kind: "waitFor", anchorId: null },
    { id: "act-4", kind: "waitFor", anchorId: null },
    { id: "act-5", kind: "moveTo", anchorId: "a-2" },
    { id: "act-6", kind: "click", anchorId: "a-3" },
  ];
  return { anchors, actions } as unknown as SceneDocument;
}

const status = (over: Partial<ReplayStatus> = {}): ReplayStatus => ({
  outcome: "partial",
  reason: "unresolvedAnchor",
  completed: 4,
  total: 6,
  ...over,
});

describe("reasonSentence", () => {
  it("maps a known reason to the author's language", () => {
    expect(reasonSentence("unresolvedAnchor")).toMatch(/not on the page/);
  });

  // The orchestrator used to print the bare identifier, so a real take
  // reported "Stopped: unresolvedAnchor" and the author had no way in.
  it("never returns the bare identifier for a mapped reason", () => {
    expect(reasonSentence("unresolvedAnchor")).not.toBe("unresolvedAnchor");
  });

  it("prints an unmapped identifier verbatim rather than swallowing it", () => {
    expect(reasonSentence("somethingNewAndUnmapped")).toBe(
      "somethingNewAndUnmapped",
    );
  });

  // A page that never answered is not a page that said "gone". Before this
  // reason existed the silence was folded into `unresolvedAnchor`, and an
  // author whose app was simply down was told to re-record the step.
  // Discriminates on the mapped copy, never on the identifier: the fallback
  // prints the reason verbatim, so /silent/i would pass with and without
  // the mapping.
  it("tells the author the page did not answer, not that the element is gone", () => {
    const sentence = reasonSentence("pageSilent");
    expect(sentence).toContain("did not answer");
    expect(sentence).not.toContain("not on the page");
    expect(sentence).not.toContain("pageSilent");
  });

  /**
   * Asserted against the fallback, not merely for a match: `reasonSentence`
   * prints an unmapped identifier verbatim, so `/unreachable/i` would pass
   * with and without the mapping — the exact vacuous shape CLAUDE.md names.
   * The sentence has to differ from the identifier AND say the thing that
   * makes this reason worth having: the anchor is not the problem.
   */
  it("tells an author their anchor is fine when replay could not reach it", () => {
    const sentence = reasonSentence("anchorUnreachable");

    expect(sentence).not.toBe("anchorUnreachable");
    expect(sentence).toMatch(/nothing is wrong with the target/i);
  });

  /**
   * The half of the reason above that re-running cannot fix.
   *
   * `anchorUnreachable` covered three causes and told the author to run it
   * again. For two of them — a realm or a context that was not there yet —
   * that is a real fix. For the third it is advice that never resolves:
   * corroboration refuses a frame whose origin, name or ordinal contradicts
   * the hop, and it will refuse the same frame on every future run.
   *
   * Asserted against the fallback and against the sentence it was split from,
   * so sharing that copy again goes red rather than passing on a match.
   */
  it("tells an author a moved frame needs a different target, not a rerun", () => {
    const sentence = reasonSentence("anchorFrameMismatch");

    expect(sentence).not.toBe("anchorFrameMismatch");
    expect(sentence).toContain("running it again will fail the same way");
    expect(sentence).not.toContain("say so if it repeats");
    expect(reasonSentence("anchorUnreachable")).toContain(
      "say so if it repeats",
    );
  });

  /**
   * M4, 2026-10-01: this said "usually worth simply running it again", and an
   * agent did — run 3 of M2 repeated a muxer fault the run could not get past,
   * and spent the last run of its cap on it. The fault is underneath the take,
   * so the sentence has to say re-recording will not help, allow ONE more run,
   * and say what to do when that one stops too. Asserted against the
   * fallback and against the old advice.
   */
  it("tells an author a port failure is not the take's, and to report a second one", () => {
    const sentence = reasonSentence("portFailure");

    expect(sentence).not.toBe("portFailure");
    expect(sentence).toContain("not a fault in the script");
    expect(sentence).toContain("run it once more");
    expect(sentence).toMatch(/if it stops the same way, report it$/);
    expect(sentence).not.toContain("usually worth simply running it again");
  });
});

describe("failedStep", () => {
  /**
   * The whole point. `completed: 4` means four actions replayed, so the
   * FIFTH is the one that failed — and working that out by hand from
   * telemetry is what this exists to stop.
   */
  it("names the action after the last one that completed", () => {
    const step = failedStep(scene(), status());
    expect(step).toEqual({
      number: 5,
      total: 6,
      kind: "moveTo",
      label: "recaptcha-anchor-label",
    });
  });

  it("reports nothing when the run did not stop for a reason", () => {
    expect(failedStep(scene(), status({ reason: null }))).toBeNull();
  });

  it("reports nothing when there is no status at all", () => {
    expect(failedStep(scene(), null)).toBeNull();
  });

  // A complete run that failed to store its frames stopped at no action.
  it("reports nothing when every action completed", () => {
    expect(
      failedStep(scene(), status({ outcome: "complete", completed: 6 })),
    ).toBeNull();
  });

  it("reports nothing when completed runs past the action list", () => {
    expect(failedStep(scene(), status({ completed: 99 }))).toBeNull();
  });

  it("calls a navigation wait what the timeline calls it", () => {
    const step = failedStep(scene(), status({ completed: 2 }));
    expect(step?.label).toBe("(navigation)");
  });
});

describe("anchorLabel", () => {
  it("prefers the accessible name, then text, then the stable id", () => {
    expect(
      anchorLabel({
        id: "x",
        fingerprint: { accessibleName: "Cheese", stableId: "s" },
      } as never),
    ).toBe("Cheese");
    expect(
      anchorLabel({ id: "x", fingerprint: { stableId: "s" } } as never),
    ).toBe("s");
  });

  it("falls back to the anchor id when the fingerprint names nothing", () => {
    expect(anchorLabel({ id: "a-9", fingerprint: {} } as never)).toBe("a-9");
  });

  it("calls a missing anchor a navigation", () => {
    expect(anchorLabel(undefined)).toBe("(navigation)");
  });
});

describe("stop sentences", () => {
  it("no stop sentence tells an agent to re-record or remap", () => {
    // Premise: the table is the real one, not an empty stand-in.
    expect(Object.keys(REASON_TEXT).length).toBeGreaterThan(20);
    for (const [reason, text] of Object.entries(REASON_TEXT)) {
      expect(text, reason).not.toMatch(/re-record|remap/i);
    }
  });
});
